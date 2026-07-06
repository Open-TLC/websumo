import sys
sys.path.insert(0, '/usr/local/lib/python3.14/site-packages/sumo/tools')

import asyncio
import json
import os
import signal
import time
from concurrent.futures import ThreadPoolExecutor

import libsumo as traci
import nats
import sumolib

SCENARIOS_DIR = os.environ.get('SCENARIOS_DIR', '/tmp/shared/sumotest')


def _collect_events() -> list[dict]:
    """Exceptional events this step (collisions, teleports, emergency stops).

    Structured equivalents of sumo-gui's log panel; departed/arrived are
    deliberately excluded as high-volume noise.
    """
    events = []
    for c in traci.simulation.getCollisions():
        events.append({
            'type': 'collision',
            'text': f'{c.collider} vs {c.victim}',
            'lane': c.lane,
        })
    for vid in traci.simulation.getStartingTeleportIDList():
        events.append({'type': 'teleport', 'text': vid})
    for vid in traci.simulation.getEmergencyStoppingVehiclesIDList():
        events.append({'type': 'emergency', 'text': vid})
    return events


def _inspect_vehicle(vid: str) -> dict:
    v = traci.vehicle
    leader = v.getLeader(vid)
    next_tls = v.getNextTLS(vid)
    return {
        'kind': 'vehicle', 'id': vid,
        'type': v.getTypeID(vid),
        'vclass': v.getVehicleClass(vid),
        'speed': round(v.getSpeed(vid), 2),
        'allowedSpeed': round(v.getAllowedSpeed(vid), 2),
        'accel': round(v.getAcceleration(vid), 2),
        'lane': v.getLaneID(vid),
        'lanePos': round(v.getLanePosition(vid), 1),
        'route': v.getRouteID(vid),
        'routeEdges': list(v.getRoute(vid)),
        'routeIndex': v.getRouteIndex(vid),
        'departure': round(v.getDeparture(vid), 1),
        'departDelay': round(v.getDepartDelay(vid), 1),
        'waiting': round(v.getWaitingTime(vid), 1),
        'accumWaiting': round(v.getAccumulatedWaitingTime(vid), 1),
        'timeLoss': round(v.getTimeLoss(vid), 1),
        'distance': round(v.getDistance(vid), 1),
        'leader': [leader[0], round(leader[1], 1)] if leader else None,
        'nextTLS': [next_tls[0][0], round(next_tls[0][2], 1), next_tls[0][3]] if next_tls else None,
        'speedFactor': round(v.getSpeedFactor(vid), 3),
        'length': v.getLength(vid),
        'width': v.getWidth(vid),
        'minGap': v.getMinGap(vid),
    }


def _inspect_tls(tls_id: str) -> dict:
    t = traci.trafficlight
    program = t.getProgram(tls_id)
    phases = []
    for logic in t.getAllProgramLogics(tls_id):
        if logic.programID == program:
            phases = [[p.duration, p.state] for p in logic.phases]
            break
    return {
        'kind': 'tls', 'id': tls_id,
        'program': program,
        'phase': t.getPhase(tls_id),
        'state': t.getRedYellowGreenState(tls_id),
        'nextSwitch': round(t.getNextSwitch(tls_id), 1),
        'spent': round(t.getSpentDuration(tls_id), 1),
        'phases': phases,
    }


def _inspect_block(sel: dict) -> dict:
    """Inspect payload for the selected element; 'gone' marker if it vanished."""
    try:
        if sel['kind'] == 'vehicle':
            return _inspect_vehicle(sel['id'])
        if sel['kind'] == 'tls':
            return _inspect_tls(sel['id'])
    except Exception:
        pass
    return {'kind': sel['kind'], 'id': sel['id'], 'gone': True}


def _do_step(net: object, sel: dict | None = None) -> dict:
    """Advance one simulation step and return state.

    `_empty` flags that no vehicles are expected/running; the caller decides
    whether that means "end" — it does for flow-driven runs, but NOT when
    traffic scale is 0 (an intentionally empty sim the user injects into)."""
    traci.simulationStep()
    empty = traci.simulation.getMinExpectedNumber() == 0
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
    out = {
        't': round(traci.simulation.getTime(), 1),
        'vehicles': vehicles,
        'tls': tls,
        'detectors': detectors,
        'events': _collect_events(),
        '_empty': empty,
    }
    if sel:
        out['inspect'] = _inspect_block(sel)
    return out


def _build_route_cache(net: object) -> tuple[dict, dict]:
    """Routes indexed by starting edge, and by (starting edge, lane index).

    The lane-level index only includes routes whose first turn (the route's
    second edge) is reachable from that lane's connections. Injecting on a
    specific lane must pick a route that lane can actually follow — otherwise
    SUMO relocates the vehicle to a connecting lane and the requested
    `departLane` is silently ignored (e.g. a short right-turn pocket can't feed
    a straight-ahead route)."""
    routes_from: dict[str, list[str]] = {}
    lane_routes: dict[tuple[str, int], list[str]] = {}
    for rid in traci.route.getIDList():
        edges = traci.route.getEdges(rid)
        if not edges:
            continue
        first = edges[0]
        routes_from.setdefault(first, []).append(rid)
        second = edges[1] if len(edges) > 1 else None
        try:
            e = net.getEdge(first)
        except KeyError:
            continue
        for lane in e.getLanes():
            reachable = {c.getToLane().getEdge().getID() for c in lane.getOutgoing()}
            if second is None or second in reachable:
                lane_routes.setdefault((first, lane.getIndex()), []).append(rid)
    return routes_from, lane_routes


def _spawn(routes_from: dict, lane_routes: dict, edge: str, vtype: str,
           veh_id: str, pick: int, lane: int | None = None) -> dict:
    """Inject one vehicle of `vtype` at entry `edge`. Runs in the libsumo thread.

    When `lane` is given, the route is chosen from those that lane can follow so
    `departLane=<index>` is honoured; `departPos='free'` is required — the
    default 'base' silently queues under load (see GENERATOR_NODES_RESEARCH.md).
    """
    if lane is not None:
        route_ids = lane_routes.get((edge, lane)) or routes_from.get(edge)
    else:
        route_ids = routes_from.get(edge)
    if not route_ids:
        return {'ok': False, 'error': f'no route from edge {edge}'}
    if vtype not in traci.vehicletype.getIDList():
        return {'ok': False, 'error': f'unknown vtype {vtype}'}
    route_id = route_ids[pick % len(route_ids)]   # rotate for destination variety
    depart_lane = str(lane) if lane is not None else 'free'
    try:
        traci.vehicle.add(
            veh_id, route_id, typeID=vtype, depart='now',
            departLane=depart_lane, departPos='free', departSpeed='max',
        )
        return {'ok': True, 'id': veh_id, 'edge': edge, 'vtype': vtype, 'lane': lane}
    except Exception as e:   # vClass/route mismatch, jam — must not crash adapter
        return {'ok': False, 'error': str(e)}


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


async def run(scenario: str, nats_url: str, end_time: int | None = None,
              init_scale: float = 1.0, init_speed: float = 1.0) -> None:
    nc = await nats.connect(nats_url)

    sumocfg = f'{SCENARIOS_DIR}/{scenario}.sumocfg'
    net_xml  = f'{SCENARIOS_DIR}/{scenario}.net.xml'
    net = sumolib.net.readNet(net_xml, withInternal=False)

    paused     = False
    # playback is real-time-aligned: speed is a multiple of real time, so the
    # wall period per step is deltaT/speed. speed_req is the requested multiple;
    # the loop reports the achievable ceiling (maxRate) when it can't keep up.
    speed_req  = max(0.1, min(init_speed, 1000.0))
    pending: dict = {}  # buffered commands applied before next step
    # single global selection per adapter — all subscribers see the same
    # inspect block; a multi-user setup needs per-client selections (see
    # docs/ELEMENT_INSPECTION_RESEARCH.md). 'client' field reserved for that.
    selected: dict | None = None
    route_cache: dict = {}       # first-edge → [route_ids]; filled after start
    lane_route_cache: dict = {}  # (first-edge, lane index) → [route_ids]
    spawn_n = 0                  # unique manual_{n} vehicle ids
    last_t = 0.0             # last step time (thread-safe: no libsumo call in callbacks)
    current_scale = max(0.0, min(init_scale, 5.0))   # 0 => don't auto-end on empty

    loop = asyncio.get_running_loop()
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='libsumo')

    async def on_cmd(msg: nats.aio.msg.Msg) -> None:
        nonlocal paused, speed_req, selected, spawn_n, current_scale
        cmd = msg.subject.rsplit('.', 1)[-1]
        data = json.loads(msg.data) if msg.data else {}
        if cmd == 'pause':
            paused = True
        elif cmd == 'resume':
            paused = False
        elif cmd == 'stop':
            pending['stop'] = True
        elif cmd == 'speed':
            speed_req = max(0.1, min(float(data.get('v', 1.0)), 1000.0))
        elif cmd == 'scale':
            # 0 = no flow insertion (only manual/generator vehicles)
            current_scale = max(0.0, min(float(data.get('v', 1.0)), 5.0))
            pending['scale'] = current_scale
        elif cmd == 'select':
            kind, oid = data.get('kind'), data.get('id')
            selected = {'kind': kind, 'id': oid} if kind and oid else None
            if selected:
                # immediate one-shot so the panel fills without waiting for
                # the next step (matters when paused or at low speed);
                # executor keeps all libsumo calls on one thread
                block = await loop.run_in_executor(executor, _inspect_block, selected)
                await nc.publish(
                    f'sim.{scenario}.state',
                    json.dumps({'type': 'inspect', 'inspect': block}).encode(),
                )
        elif cmd == 'spawn':
            edge, vtype = data.get('edge'), data.get('vtype')
            lane = data.get('lane')   # specific lane index, or None for 'free'
            if edge and vtype:
                spawn_n += 1
                veh_id = f'manual_{spawn_n}'
                result = await loop.run_in_executor(
                    executor, _spawn, route_cache, lane_route_cache,
                    edge, vtype, veh_id, spawn_n, lane)
                # injected vehicles appear in the state stream on their own; only
                # surface failures, on the log subject so the LOG panel shows them
                if not result['ok']:
                    await nc.publish(
                        f'sim.{scenario}.log',
                        json.dumps({'type': 'log', 't': last_t,
                                    'events': [{'type': 'spawn-failed',
                                                'text': f"{vtype} @ {edge}: {result['error']}"}]}).encode(),
                    )

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
    rf, lr = _build_route_cache(net)
    route_cache.update(rf)
    lane_route_cache.update(lr)
    # apply the pre-Start traffic scale before the first step, so scale=0 means
    # truly zero flow insertion from t=0 (no vehicles slip in during startup)
    await loop.run_in_executor(executor, traci.simulation.setScale, current_scale)
    # configured end time (from --end or the sumocfg); bounds a scale=0 run that
    # would otherwise never see an empty-network end
    end_bound = await loop.run_in_executor(executor, traci.simulation.getEndTime)
    delta_t = await loop.run_in_executor(executor, traci.simulation.getDeltaT)  # sim-s/step
    # smoothed wall period between iteration starts — includes ALL overhead
    # (step, serialize, NATS flush, loop), so delta_t/period is the true rate
    period_ema = None
    prev_start = None
    was_flat = False   # did the previous iteration run flat out (no sleep)?

    try:
        while True:
            if pending.get('stop'):
                break
            if paused:
                await asyncio.sleep(0.05)
                prev_start = None   # don't count the paused gap as work
                continue
            if 'scale' in pending:
                scale = pending.pop('scale')
                await loop.run_in_executor(executor, traci.simulation.setScale, scale)

            t_start = time.monotonic()
            if prev_start is not None:
                period = t_start - prev_start
                period_ema = period if period_ema is None else 0.85 * period_ema + 0.15 * period
            prev_start = t_start
            result = await loop.run_in_executor(executor, _do_step, net, selected)
            last_t = result['t']
            empty = result.pop('_empty')
            # End on: reaching the configured end time, OR an empty network — but
            # NOT when scale is 0 (an intentionally empty sim awaiting injection).
            if (end_bound > 0 and last_t >= end_bound) or (empty and current_scale > 0):
                await nc.publish(f'sim.{scenario}.end', b'{}')
                break

            # a vanished element (arrived vehicle) reports gone once, then deselects
            if result.get('inspect', {}).get('gone'):
                selected = None

            events = result.pop('events')
            if events:
                await nc.publish(
                    f'sim.{scenario}.log',
                    json.dumps({'type': 'log', 't': result['t'], 'events': events}).encode(),
                )
            # Report a real ceiling only while flat out (previous iteration
            # didn't sleep); otherwise a high sentinel = "keeping up, not
            # limited". This makes the UI's clamp unambiguous — no false red
            # from sleep jitter when we're actually hitting the requested rate.
            result['maxRate'] = (round(delta_t / period_ema, 1)
                                 if was_flat and period_ema else 9999.0)
            await nc.publish(
                f'sim.{scenario}.state',
                json.dumps(result).encode(),
            )
            # pace to real-time × speed_req; if the work already overran the
            # target period we run flat out (no sleep) — that's the ceiling
            sleep = delta_t / speed_req - (time.monotonic() - t_start)
            was_flat = sleep <= 0.002   # ~no sleep left => throughput-limited
            if sleep > 0:
                await asyncio.sleep(sleep)
    finally:
        try:
            traci.close()
        except Exception:
            pass
        executor.shutdown(wait=False)
        await nc.drain()


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: sumo_adapter.py <scenario> [end_time_s] [scale] [speed]', file=sys.stderr)
        sys.exit(1)

    scenario = sys.argv[1]
    end_time = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] != '0' else None
    init_scale = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    init_speed = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    nats_url = os.environ.get('NATS_URL', 'nats://localhost:4222')

    # clean shutdown on SIGTERM (sent by FastAPI on adapter/stop)
    def _sigterm(signum, frame):
        sys.exit(0)
    signal.signal(signal.SIGTERM, _sigterm)

    asyncio.run(run(scenario, nats_url, end_time, init_scale, init_speed))
