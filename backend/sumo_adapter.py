import sys
sys.path.insert(0, '/usr/local/lib/python3.14/site-packages/sumo/tools')

import asyncio
import json
import os
import signal
from concurrent.futures import ThreadPoolExecutor

import libsumo as traci
import nats
import sumolib

SCENARIOS_DIR = os.environ.get('SCENARIOS_DIR', '/tmp/shared/sumotest')


def _do_step(net: object) -> dict | None:
    """Advance one simulation step and return state, or None if sim ended."""
    traci.simulationStep()
    if traci.simulation.getMinExpectedNumber() == 0:
        return None
    vehicles = []
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
    tls = {
        tls_id: traci.trafficlight.getRedYellowGreenState(tls_id)
        for tls_id in traci.trafficlight.getIDList()
    }
    detectors = {
        det_id: traci.inductionloop.getLastStepVehicleNumber(det_id) > 0
                or traci.inductionloop.getLastStepOccupancy(det_id) > 0
        for det_id in traci.inductionloop.getIDList()
    }
    return {
        't': round(traci.simulation.getTime(), 1),
        'vehicles': vehicles,
        'tls': tls,
        'detectors': detectors,
    }


def _stretch_flows(scenario: str, end_time: int) -> str:
    """Write a temp route file with flow end times extended to end_time.

    Demand is defined as flows (vehsPerHour rates), so extending the end
    time simply continues the same rates — no vehicle list to regenerate.
    """
    import re
    src = f'{SCENARIOS_DIR}/{scenario}.rou.xml'
    dst = f'/tmp/{scenario}.rou.{end_time}.xml'
    with open(src) as f:
        content = f.read()
    content = re.sub(
        r'(<flow\b[^>]*\bend=")[0-9.]+(")',
        rf'\g<1>{end_time}\g<2>',
        content,
    )
    with open(dst, 'w') as f:
        f.write(content)
    return dst


async def run(scenario: str, nats_url: str, end_time: int | None = None) -> None:
    nc = await nats.connect(nats_url)

    sumocfg = f'{SCENARIOS_DIR}/{scenario}.sumocfg'
    net_xml  = f'{SCENARIOS_DIR}/{scenario}.net.xml'
    net = sumolib.net.readNet(net_xml, withInternal=False)

    paused     = False
    step_delay = 0.05   # seconds between steps (20 steps/sec = 1× speed)
    pending: dict = {}  # buffered commands applied before next step

    async def on_cmd(msg: nats.aio.msg.Msg) -> None:
        nonlocal paused, step_delay
        cmd = msg.subject.rsplit('.', 1)[-1]
        data = json.loads(msg.data) if msg.data else {}
        if cmd == 'pause':
            paused = True
        elif cmd == 'resume':
            paused = False
        elif cmd == 'stop':
            pending['stop'] = True
        elif cmd == 'speed':
            v = max(0.1, min(float(data.get('v', 1.0)), 50.0))
            step_delay = 0.05 / v
        elif cmd == 'scale':
            pending['scale'] = max(0.1, min(float(data.get('v', 1.0)), 5.0))

    await nc.subscribe(f'sim.{scenario}.cmd.*', cb=on_cmd)

    sumo_cmd = [
        'sumo', '-c', sumocfg,
        '--no-step-log',
        '--quit-on-end',
    ]
    detectors_xml = f'{SCENARIOS_DIR}/{scenario}.detectors.xml'
    if os.path.exists(detectors_xml):
        sumo_cmd += ['--additional-files', detectors_xml]
    if end_time is not None:
        sumo_cmd += [
            '--end', str(end_time),
            '--route-files', _stretch_flows(scenario, end_time),
        ]
    traci.start(sumo_cmd)

    loop = asyncio.get_running_loop()
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='libsumo')

    try:
        while True:
            if pending.get('stop'):
                break
            if paused:
                await asyncio.sleep(0.05)
                continue
            if 'scale' in pending:
                scale = pending.pop('scale')
                await loop.run_in_executor(executor, traci.simulation.setScale, scale)

            result = await loop.run_in_executor(executor, _do_step, net)
            if result is None:
                await nc.publish(f'sim.{scenario}.end', b'{}')
                break

            await nc.publish(
                f'sim.{scenario}.state',
                json.dumps(result).encode(),
            )
            await asyncio.sleep(step_delay)
    finally:
        try:
            traci.close()
        except Exception:
            pass
        executor.shutdown(wait=False)
        await nc.drain()


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: sumo_adapter.py <scenario> [end_time_s] [nats_url]', file=sys.stderr)
        sys.exit(1)

    scenario = sys.argv[1]
    end_time = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] != '0' else None
    nats_url  = sys.argv[3] if len(sys.argv) > 3 else 'nats://localhost:4222'

    # clean shutdown on SIGTERM (sent by FastAPI on adapter/stop)
    def _sigterm(signum, frame):
        sys.exit(0)
    signal.signal(signal.SIGTERM, _sigterm)

    asyncio.run(run(scenario, nats_url, end_time))
