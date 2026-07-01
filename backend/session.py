import sys
sys.path.insert(0, '/usr/local/lib/python3.14/site-packages/sumo/tools')

import asyncio
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Optional

import traci
import sumolib



@dataclass
class SimSession:
    session_id: str
    net: object  # sumolib.net.Net
    running: bool = True
    paused: bool = False
    step_delay: float = 0.05  # seconds between steps (~20 steps/sec at 1x speed)
    websocket: Optional[object] = None
    executor: ThreadPoolExecutor = field(
        default_factory=lambda: ThreadPoolExecutor(max_workers=1, thread_name_prefix='traci')
    )

    def do_step(self) -> dict | None:
        traci.simulationStep()
        if traci.simulation.getMinExpectedNumber() == 0:
            return None
        vehicles = []
        for vid in traci.vehicle.getIDList():
            x, y = traci.vehicle.getPosition(vid)
            lon, lat = self.net.convertXY2LonLat(x, y)
            vehicles.append([vid, round(lon, 7), round(lat, 7)])
        tls = {
            tls_id: traci.trafficlight.getRedYellowGreenState(tls_id)
            for tls_id in traci.trafficlight.getIDList()
        }
        return {
            't': round(traci.simulation.getTime(), 1),
            'vehicles': vehicles,
            'tls': tls,
        }

    def close_traci(self) -> None:
        try:
            traci.close()
        except Exception:
            pass


class SessionManager:
    def __init__(self) -> None:
        self._session: Optional[SimSession] = None

    @property
    def active(self) -> bool:
        return self._session is not None and self._session.running

    def get(self, session_id: str) -> Optional[SimSession]:
        if self._session and self._session.session_id == session_id:
            return self._session
        return None

    async def start(self, sumocfg: str, net_xml: str) -> str:
        loop = asyncio.get_running_loop()
        net = sumolib.net.readNet(net_xml, withInternal=False)
        session = SimSession(session_id=str(uuid.uuid4()), net=net)
        def _connect() -> None:
            # Close any stale connection; if the socket is already dead, force-clear
            # the registry so traci.start() doesn't raise "already active".
            try:
                traci.close()
            except Exception:
                import traci.connection as _tc
                _tc._connections.pop('default', None)
                _tc._connections.pop('', None)
            traci.start([
                'sumo', '-c', sumocfg,
                '--no-step-log',
                '--quit-on-end',
            ])

        await loop.run_in_executor(session.executor, _connect)
        self._session = session
        return session.session_id

    async def stop(self) -> None:
        if self._session:
            session = self._session
            self._session = None
            session.running = False
            # close_traci runs in the same executor after any pending do_step finishes
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(session.executor, session.close_traci)
            session.executor.shutdown(wait=False)


session_manager = SessionManager()


async def step_loop(session: SimSession) -> None:
    loop = asyncio.get_running_loop()
    try:
        while session.running:
            if session.paused:
                await asyncio.sleep(0.05)
                continue
            result = await loop.run_in_executor(session.executor, session.do_step)
            if result is None:
                if session.websocket:
                    try:
                        await session.websocket.send_json({'type': 'end'})
                    except Exception:
                        pass
                break
            if session.websocket:
                try:
                    await session.websocket.send_json(result)
                except Exception:
                    break
            await asyncio.sleep(session.step_delay)
    except asyncio.CancelledError:
        pass


def handle_command(session: SimSession, msg: dict) -> None:
    cmd = msg.get('cmd')
    if cmd == 'pause':
        session.paused = True
    elif cmd == 'resume':
        session.paused = False
    elif cmd == 'speed':
        v = max(0.1, min(float(msg.get('v', 1.0)), 20.0))
        session.step_delay = 0.05 / v
    elif cmd == 'stop':
        session.running = False
