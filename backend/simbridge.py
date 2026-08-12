"""WebSUMO Simulation Bridge: synchronous NATS interface for simengines.

This module provides a clean seam between a synchronous simengine (e.g., OC's
simengine_integrated.py, which calls traci.simulationStep() in a tight loop)
and the asynchronous NATS broker. The bridge runs NATS in a background thread,
offering synchronous publish/subscribe methods from the simengine's main thread.

Usage (in OC's simengine):
    from simbridge import SimBridge

    bridge = SimBridge(scenario="fi.helsinki.269", nats_url="nats://localhost:4222")

    # In the step loop:
    traci.simulationStep()

    # Publish this step's state
    state = {
        "t": traci.simulation.getTime(),
        "vehicles": [...],
        "tls": {...},
        # ... (see SIM_PROTOCOL.md for full schema)
    }
    bridge.publish_step(state)

    # Collect and apply any pending commands (pause, speed, scale, etc.)
    cmds = bridge.collect_commands()
    for cmd, data in cmds.items():
        if cmd == "speed":
            speed_req = data.get("v", 1.0)
        elif cmd == "pause":
            paused = True
        # ... (see SIM_PROTOCOL.md for command list)

    bridge.close()
"""

import asyncio
import json
import logging
import queue
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

import nats

logger = logging.getLogger(__name__)


class SimBridge:
    """Synchronous NATS interface for a simengine.

    Runs an asyncio event loop in a background thread, handling NATS
    pub/sub asynchronously while the main thread steps the simulation.
    Thread-safe: all methods can be called from the simengine's main thread.
    """

    def __init__(self, scenario: str, nats_url: str = "nats://localhost:4222",
                 on_command: Optional[Callable[[str, Dict], None]] = None,
                 net_xml_path: Optional[str] = None):
        """Initialize the bridge.

        Args:
            scenario: scenario ID (e.g., "fi.helsinki.269"). Used to construct
                     NATS subjects: sim.{scenario}.state, sim.{scenario}.cmd.*, etc.
            nats_url: NATS broker URL (default: localhost:4222).
            on_command: optional callback(cmd, data) invoked when a command arrives.
                       If provided, commands are passed here instead of queued.
                       Runs in the bridge's async thread; must be fast or re-entrant.
            net_xml_path: optional path to the scenario's .net.xml. When given, the
                       bridge answers `sim.{scenario}.net` requests with the gzipped
                       file, so WebSUMO can render the network without a local copy
                       (integrated mode needs nothing on the WebSUMO host's disk).
        """
        self.scenario = scenario
        self.nats_url = nats_url
        self.on_command = on_command

        # Read + gzip the network once (static per scenario). 269 is ~125 KB raw,
        # ~28 KB gzipped — well under the 1 MB core-NATS payload cap.
        self._net_gz: Optional[bytes] = None
        if net_xml_path:
            try:
                import gzip
                with open(net_xml_path, "rb") as f:
                    self._net_gz = gzip.compress(f.read())
            except OSError as e:
                logger.warning(f"SimBridge: could not read net.xml {net_xml_path}: {e}")

        self._nc: Optional[nats.aio.client.Client] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._cmd_queue: queue.Queue = queue.Queue()
        self._stop_event = threading.Event()
        self._ready_event = threading.Event()
        self._error: Optional[Exception] = None

        self._start_background_loop()

    def _start_background_loop(self) -> None:
        """Start the async event loop in a background thread."""
        def run_loop():
            try:
                self._loop = asyncio.new_event_loop()
                asyncio.set_event_loop(self._loop)
                self._loop.run_until_complete(self._async_init())
            except Exception as e:
                self._error = e
                logger.exception("SimBridge async loop error")
                self._ready_event.set()
            finally:
                if self._loop:
                    self._loop.close()

        self._thread = threading.Thread(target=run_loop, daemon=True, name="SimBridge-NATS")
        self._thread.start()
        self._ready_event.wait(timeout=5.0)
        if self._error:
            raise self._error

    async def _async_init(self) -> None:
        """Connect to NATS and subscribe to commands. Runs in background thread."""
        try:
            self._nc = await nats.connect(self.nats_url)
            logger.info(f"SimBridge connected to {self.nats_url} for scenario {self.scenario}")

            async def on_cmd_msg(msg: nats.aio.msg.Msg) -> None:
                cmd = msg.subject.rsplit(".", 1)[-1]  # last component of subject
                data = json.loads(msg.data or b'{}')
                if self.on_command:
                    # Caller provided a callback; invoke it directly (their responsibility
                    # to be fast or handle async). Otherwise queue for collect_commands().
                    try:
                        self.on_command(cmd, data)
                    except Exception as e:
                        logger.exception(f"on_command callback error for {cmd}: {e}")
                else:
                    self._cmd_queue.put((cmd, data))

            await self._nc.subscribe(f"sim.{self.scenario}.cmd.*", cb=on_cmd_msg)

            # Serve the network on request (integrated mode: WebSUMO renders it
            # without a local .net.xml). Reply is the gzipped file bytes.
            if self._net_gz is not None:
                async def on_net_request(msg: nats.aio.msg.Msg) -> None:
                    await msg.respond(self._net_gz)
                await self._nc.subscribe(f"sim.{self.scenario}.net", cb=on_net_request)

            self._ready_event.set()

            # Keep the loop alive until close(). `_stop_event` is a threading.Event
            # set from the main thread — it can't be awaited, so poll it.
            while not self._stop_event.is_set():
                await asyncio.sleep(0.1)
            try:
                await self._nc.drain()
            except Exception:
                pass
        except Exception as e:
            self._error = e
            logger.exception("SimBridge async init error")
            self._ready_event.set()

    def collect_commands(self) -> Dict[str, Any]:
        """Drain all pending commands from the queue and return them as a dict.

        Safe to call from the main (simengine) thread. Each command appears once;
        if multiple commands of the same type arrive before collection, the last
        one is kept (later commands override earlier ones).

        Returns:
            {cmd_name: data} dict. Empty dict if no commands pending.

        Example:
            cmds = bridge.collect_commands()
            if "speed" in cmds:
                speed_req = cmds["speed"].get("v", 1.0)
            if "pause" in cmds:
                paused = True
        """
        result = {}
        while True:
            try:
                cmd, data = self._cmd_queue.get_nowait()
                result[cmd] = data
            except queue.Empty:
                break
        return result

    def publish_step(self, state: Dict[str, Any]) -> None:
        """Publish a simulation step snapshot to sim.{scenario}.state.

        Safe to call from the main (simengine) thread. This is non-blocking;
        the actual NATS publish happens in the background thread.

        Args:
            state: dict with at least keys 't', 'vehicles', 'persons', 'tls', 'detectors'.
                  See SIM_PROTOCOL.md for full schema.

        Example:
            state = {
                "v": 1,
                "t": traci.simulation.getTime(),
                "vehicles": [...],
                "persons": [...],
                "tls": {...},
                "detectors": {...},
            }
            bridge.publish_step(state)
        """
        if not self._nc:
            return

        # Schedule the async publish in the background loop
        def _publish_async():
            asyncio.run_coroutine_threadsafe(
                self._nc.publish(f"sim.{self.scenario}.state", json.dumps(state).encode()),
                self._loop
            )

        # Run in the background thread's event loop
        asyncio.run_coroutine_threadsafe(
            self._nc.publish(f"sim.{self.scenario}.state", json.dumps(state).encode()),
            self._loop
        )

    def publish_log(self, t: float, events: List[Dict[str, Any]]) -> None:
        """Publish exceptional events (collisions, teleports, etc.).

        Safe to call from the main (simengine) thread.

        Args:
            t: simulation time (seconds).
            events: list of {type, text, lane?, ...} dicts. See SIM_PROTOCOL.md.

        Example:
            bridge.publish_log(t=123.4, events=[
                {"type": "collision", "text": "veh0 vs veh1", "lane": "edge_0"},
                {"type": "teleport", "text": "veh2"},
            ])
        """
        msg = {"type": "log", "t": t, "events": events}
        asyncio.run_coroutine_threadsafe(
            self._nc.publish(f"sim.{self.scenario}.log", json.dumps(msg).encode()),
            self._loop
        )

    def publish_end(self) -> None:
        """Publish sim.{scenario}.end to signal simulation termination.

        Safe to call from the main (simengine) thread. Blocks until published.
        """
        if not self._nc:
            return
        future = asyncio.run_coroutine_threadsafe(
            self._nc.publish(f"sim.{self.scenario}.end", b"{}"),
            self._loop
        )
        try:
            future.result(timeout=1.0)
        except Exception as e:
            logger.warning(f"Failed to publish end message: {e}")

    def close(self) -> None:
        """Cleanly shut down the bridge and background thread.

        Blocks until the NATS connection is closed and the thread exits.
        Safe to call from the main (simengine) thread; idempotent.
        """
        if not self._thread or not self._thread.is_alive():
            return

        # Signal the async loop to stop
        self._stop_event.set()

        # Wait for the thread to finish (with timeout)
        self._thread.join(timeout=2.0)
        if self._thread.is_alive():
            logger.warning("SimBridge thread did not exit cleanly")
        else:
            logger.info("SimBridge closed")


def serialize_vehicles(traci, net, scenario: str) -> List:
    """Helper: serialize all vehicles to WebSUMO format.

    Args:
        traci: libsumo/traci module (e.g., `import libsumo as traci`).
        net: sumolib network object (e.g., `sumolib.net.readNet(...)`).
        scenario: scenario ID (used for IRI grounding if OC integration is active).

    Returns:
        List of [id, lon, lat, angle_deg, length_m, width_m, vclass].
    """
    vehicles = []
    try:
        for vid in traci.vehicle.getIDList():
            x, y = traci.vehicle.getPosition(vid)
            lon, lat = net.convertXY2LonLat(x, y)
            vehicles.append([
                vid,
                round(lon, 7),
                round(lat, 7),
                round(traci.vehicle.getAngle(vid), 1),
                round(traci.vehicle.getLength(vid), 2),
                round(traci.vehicle.getWidth(vid), 2),
                traci.vehicle.getVehicleClass(vid),
            ])
    except Exception as e:
        logger.warning(f"Error serializing vehicles: {e}")
    return vehicles


def serialize_persons(traci, net) -> List:
    """Helper: serialize all pedestrians/cyclists to WebSUMO format.

    Args:
        traci: libsumo/traci module.
        net: sumolib network object.

    Returns:
        List of [id, lon, lat, angle_deg, speed_m_s].
    """
    persons = []
    try:
        for pid in traci.person.getIDList():
            px, py = traci.person.getPosition(pid)
            plon, plat = net.convertXY2LonLat(px, py)
            persons.append([
                pid,
                round(plon, 7),
                round(plat, 7),
                round(traci.person.getAngle(pid), 1),
                round(traci.person.getSpeed(pid), 2),
            ])
    except Exception as e:
        logger.warning(f"Error serializing persons: {e}")
    return persons


def serialize_tls(traci) -> Dict[str, str]:
    """Helper: serialize all traffic light states.

    Args:
        traci: libsumo/traci module.

    Returns:
        {tls_id: phase_state_string}.
    """
    tls = {}
    try:
        for tid in traci.trafficlight.getIDList():
            tls[tid] = traci.trafficlight.getRedYellowGreenState(tid)
    except Exception as e:
        logger.warning(f"Error serializing TLS: {e}")
    return tls


def serialize_detectors(traci) -> Dict[str, bool]:
    """Helper: serialize detector occupancy.

    Args:
        traci: libsumo/traci module.

    Returns:
        {detector_id: is_active}.
    """
    detectors = {}
    try:
        for did in traci.inductionloop.getIDList():
            active = (traci.inductionloop.getLastStepVehicleNumber(did) > 0 or
                     traci.inductionloop.getLastStepOccupancy(did) > 0)
            detectors[did] = active
    except Exception as e:
        logger.warning(f"Error serializing detectors: {e}")
    return detectors
