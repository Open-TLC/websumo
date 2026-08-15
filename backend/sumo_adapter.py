import sys
sys.path.insert(0, '/usr/local/lib/python3.14/site-packages/sumo/tools')

import asyncio
import json
import math
import os
import re
import signal
import time
from concurrent.futures import ThreadPoolExecutor

import libsumo as traci
import nats
import sumolib

SCENARIOS_DIR = os.environ.get('SCENARIOS_DIR', '/tmp/shared/sumotest')
# OC coherent-demo mode: mirror Open Controller's live signal state onto this
# sim's traffic lights each step, so the vehicles shown obey OC's control. OC
# publishes group.status.<ctrl>.<sigIdx> where sigIdx is the raw SUMO signal
# index (see backend/oc_join.py), so the mapping is per-index and exact — no
# positional group_outputs logic needed. See docs/OC_ELEMENTS_DISPLAY_PLAN.md.
OC_MIRROR = os.environ.get('OC_MIRROR', '').lower() in ('1', 'true', 'yes', 'on')

# ---- V2X experiment: floating-car egocentric knowledge graphs -----------------
# Ground SUMO ids onto the static intersection graph's opencontroller.org IRIs.
# The hex approach id in a SUMO edge name is the linkage key (Phase 0 finding).
# This is a swappable seam: id-lookup in sim, GPS map-matching in the real world.
_HEX = r'[0-9a-fA-F]+'
FCD_RADIUS = 50.0   # metres — "sees" / neighbour range


def _iri_base(scenario: str) -> str:
    # fi.helsinki.269 -> https://opencontroller.org/id/intersection/fi-helsinki-269
    return f'https://opencontroller.org/id/intersection/{scenario.replace(".", "-")}'


def _ground_edge(scenario: str, edge_id: str | None) -> str | None:
    m = re.match(rf'(approach|exit)_({_HEX})_[a-z]+$', edge_id or '')
    return f'{_iri_base(scenario)}/{m.group(1)}/{m.group(2)}' if m else None


def _ground_lane(scenario: str, lane_id: str | None) -> str | None:
    # The graph's lane letter encodes role×mode: approach car=A / tram=TA,
    # exit car=D / tram=TD (verified against 269's graph.ttl). The number is the
    # SUMO lane index +1 — count matches; index→physical-lane direction is still
    # tentative (Phase 0). Modes other than tram fall back to the car letter.
    m = re.match(rf'(approach|exit)_({_HEX})_([a-z]+)_(\d+)$', lane_id or '')
    if not m:
        return None
    role, hex_id, mode, idx = m.group(1), m.group(2), m.group(3), int(m.group(4))
    letter = ('T' if mode == 'tram' else '') + ('A' if role == 'approach' else 'D')
    return f'{_iri_base(scenario)}/{role}/{hex_id}/lane/{letter}{idx + 1}'


# Ground a TLS movement (SUMO tls link index) onto the graph's oct:Connection.
# The graph has no SignalGroup abstraction (269's signal_groups are empty), but
# each Connection is keyed by (fromLane, toDepartureLane) — exactly what SUMO's
# getControlledLinks gives per link index. Built once at start into _LINK_GROUND.
OCT_GRAPH_DIR = os.environ.get('OCT_GRAPH_DIR', '')  # optional; path to intersection graphs for IRI grounding
_LINK_GROUND: dict = {}   # (tlsId, linkIndex) -> {fromLane, toLane, onConnection}


def _load_connection_map(scenario: str) -> dict:
    """(fromLaneIRI, toLaneIRI) -> connection IRI, read from the static graph.
    Best-effort: {} if graph.ttl isn't found — connection grounding is then
    omitted, but lane grounding (which needs no graph file) is unaffected."""
    path = os.path.join(OCT_GRAPH_DIR, scenario, 'graph.ttl')
    if not os.path.exists(path):
        return {}
    base = _iri_base(scenario)
    text = open(path).read()
    out = {}
    pat = re.compile(
        re.escape(base) + r'/connection/([0-9a-f]+)> a oct:Connection ;(.*?)\.\n', re.S)
    for m in pat.finditer(text):
        cid, body = m.group(1), m.group(2)
        fl = re.search(r'oct:fromLane <([^>]+)>', body)
        tl = re.search(r'oct:toDepartureLane <([^>]+)>', body)
        if fl and tl:
            out[(fl.group(1), tl.group(1))] = f'{base}/connection/{cid}'
    return out


def _build_link_ground(scenario: str) -> None:
    """Populate _LINK_GROUND: each TLS link index -> its grounded from/to lanes
    and (when the graph is available) the connection IRI. Runs once after the
    sim starts, in the libsumo thread."""
    conn_map = _load_connection_map(scenario)
    _LINK_GROUND.clear()
    for tid in traci.trafficlight.getIDList():
        for idx, spec in enumerate(traci.trafficlight.getControlledLinks(tid)):
            if not spec:
                continue
            in_lane, out_lane, _via = spec[0]
            fi = _ground_lane(scenario, in_lane)
            ti = _ground_lane(scenario, out_lane)
            _LINK_GROUND[(tid, idx)] = {
                'fromLane': fi, 'toLane': ti,
                'onConnection': conn_map.get((fi, ti)),
            }


def _is_fcd(vid: str, selector: str) -> bool:
    """Is this vehicle a floating car (probe)? Configurable selector."""
    if not selector or selector == 'none':
        return False
    if selector == 'all':
        return True
    if selector == 'manual':
        return vid.startswith('manual_')
    if selector.startswith('fraction:'):
        try:
            frac = float(selector.split(':', 1)[1])
        except ValueError:
            return False
        return (hash(vid) & 0x7fffffff) % 1000 < frac * 1000   # deterministic per id
    if selector.startswith('vtype:'):
        return traci.vehicle.getTypeID(vid) == selector.split(':', 1)[1]
    return False


def _fcd_context(scenario: str) -> dict:
    return {
        '@vocab': 'https://opencontroller.org/ns/traffic#',
        'oct': 'https://opencontroller.org/ns/traffic#',
        'veh': f'urn:sim:{scenario}:veh:',   # sim-local ids (real world = plate/pseudonym)
        'onLane': {'@type': '@id'},
        'onEdge': {'@type': '@id'},
        'fromLane': {'@type': '@id'},
        'toLane': {'@type': '@id'},
        'onConnection': {'@type': '@id'},
    }


def _ego_graph(vid: str, net: object, scenario: str) -> dict:
    """Egocentric JSON-LD graph of what vehicle `vid` perceives, grounded on the
    static infra IRIs. Runs in the libsumo thread (called from _do_step)."""
    v = traci.vehicle
    x, y = v.getPosition(vid)
    lon, lat = net.convertXY2LonLat(x, y)
    node = {
        '@context': _fcd_context(scenario),
        '@id': f'veh:{vid}', '@type': 'Vehicle',
        't': round(traci.simulation.getTime(), 1), 'confidence': 1.0,
        'onLane': _ground_lane(scenario, v.getLaneID(vid)),
        'onEdge': _ground_edge(scenario, v.getRoadID(vid)),
        'lon': round(lon, 7), 'lat': round(lat, 7),
        'speed': round(v.getSpeed(vid), 2),
        'heading': round(v.getAngle(vid), 1),
    }
    leader = v.getLeader(vid, FCD_RADIUS)
    if leader and leader[0]:
        node['following'] = {'@id': f'veh:{leader[0]}', 'gap': round(leader[1], 1)}
    nt = v.getNextTLS(vid)
    if nt:
        tls_id, idx, dist, state = nt[0]
        # Ground to the junction + the specific movement (oct:Connection) the car
        # is about to make, keyed by (fromLane, toLane) via _LINK_GROUND. The graph
        # has no SignalGroup abstraction, so the Connection IS the resolvable link;
        # fromLane/toLane are always grounded, onConnection when the graph is loaded.
        appr = {'@id': _iri_base(scenario),
                'signalIndex': int(idx), 'distance': round(dist, 1), 'state': state}
        g = _LINK_GROUND.get((tls_id, int(idx)))
        if g:
            if g['fromLane']:
                appr['fromLane'] = g['fromLane']
            if g['toLane']:
                appr['toLane'] = g['toLane']
            if g['onConnection']:
                appr['onConnection'] = g['onConnection']
        node['approaching'] = appr
    sees = []
    for oid in v.getIDList():
        if oid == vid:
            continue
        ox, oy = v.getPosition(oid)
        d = math.hypot(ox - x, oy - y)
        if d <= FCD_RADIUS:
            # carry the observed object's position/speed (like a real CPM report),
            # so a fusion node can localise it from observations alone — no need
            # for the object to be a probe itself
            olon, olat = net.convertXY2LonLat(ox, oy)
            sees.append({'@id': f'veh:{oid}',
                         'onLane': _ground_lane(scenario, v.getLaneID(oid)),
                         'lon': round(olon, 7), 'lat': round(olat, 7),
                         'speed': round(v.getSpeed(oid), 2),
                         'range': round(d, 1)})
    if sees:
        node['sees'] = sees[:20]
    return node


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


def _do_step(net: object, sel: dict | None = None, full: bool = True,
             scenario: str | None = None, fcd_sel: str | None = None,
             want_fcd: bool = False) -> dict:
    """Advance one simulation step.

    Always steps and collects events (cheap) + the empty flag; gathers the full
    vehicle/TLS/detector snapshot only when `full` (a UI frame). Steps between
    frames skip the expensive per-vehicle serialization, so the sim runs fast
    while the UI updates at a fixed ~10 Hz. `_empty` flags no vehicles
    expected/running — the caller decides if that ends the run (not when
    scale=0, an intentionally empty sim the user injects into)."""
    traci.simulationStep()
    empty = traci.simulation.getMinExpectedNumber() == 0
    events = _collect_events()
    t = round(traci.simulation.getTime(), 1)
    # detector occupancy is sampled EVERY step (not just on UI frames) so a
    # brief crossing between frames isn't missed at high playback speed; the
    # caller unions det_on across a frame's steps (see the run loop).
    det_on = [d for d in traci.inductionloop.getIDList()
              if traci.inductionloop.getLastStepVehicleNumber(d) > 0
              or traci.inductionloop.getLastStepOccupancy(d) > 0]
    if not full:
        return {'t': t, 'events': events, '_empty': empty, 'det_on': det_on}
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
    # Pedestrians live in a separate person world (traci.person.*), published
    # as a parallel array: [id, lon, lat, angleDeg, speed].
    persons = []
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
    tls = {
        tls_id: traci.trafficlight.getRedYellowGreenState(tls_id)
        for tls_id in traci.trafficlight.getIDList()
    }
    out = {
        't': t,
        'vehicles': vehicles,
        'persons': persons,
        'tls': tls,
        'events': events,
        '_empty': empty,
        'det_on': det_on,   # the run loop turns the frame's union into `detectors`
    }
    if sel:
        out['inspect'] = _inspect_block(sel)
    # V2X experiment: egocentric graphs for the floating cars (published
    # separately). Rate-limited by the caller (want_fcd) to ~a few Hz — the
    # per-vehicle perception scan is the expensive part, so we skip the BUILD,
    # not just the publish, on the frames in between.
    if want_fcd and fcd_sel and scenario:
        fcd = {vid: _ego_graph(vid, net, scenario)
               for vid in traci.vehicle.getIDList() if _is_fcd(vid, fcd_sel)}
        if fcd:
            out['fcd'] = fcd
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


def _apply_oc_tls(oc_states: dict) -> None:
    """Mirror OC's live signal state onto this sim's traffic lights (OC_MIRROR).

    For each TLS, key = id.split('_')[0] (e.g. '270_Tyyn_Vali' → '270') and each
    signal index i takes OC's substate from `group.status.<key>.<i>` when known,
    else keeps the current char. Runs in the libsumo executor thread, before the
    step, so vehicles react to OC's signals within the same step.
    """
    if not oc_states:
        return
    for tid in traci.trafficlight.getIDList():
        key = tid.split('_')[0]
        cur = list(traci.trafficlight.getRedYellowGreenState(tid))
        changed = False
        for i in range(len(cur)):
            s = oc_states.get(f'{key}.{i}')
            if s and s != cur[i]:
                cur[i] = s
                changed = True
        if changed:
            traci.trafficlight.setRedYellowGreenState(tid, ''.join(cur))


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
    # V2X experiment: which vehicles emit egocentric graphs (default: injected
    # cars) and how often (default ~3 Hz wall — real CAM/CPM cadence, and the
    # eye doesn't need 10 Hz; graphs are heavier than the vehicle snapshot)
    fcd_sel = os.environ.get('FCD_SELECTOR', 'manual')
    fcd_dt = 1.0 / max(0.5, float(os.environ.get('FCD_HZ', '3')))

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
                # V2X: also push the ego graph once, so selecting a floating car
                # fills its JSON-LD + map overlay even while paused (the step
                # loop, which normally emits these, is idle then)
                if selected.get('kind') == 'vehicle':
                    def _oneshot_fcd(vid=selected['id']):
                        if vid in traci.vehicle.getIDList() and _is_fcd(vid, fcd_sel):
                            return _ego_graph(vid, net, scenario)
                        return None
                    graph = await loop.run_in_executor(executor, _oneshot_fcd)
                    if graph:
                        await nc.publish(
                            f'kg.{scenario}.fcd.{selected["id"]}',
                            json.dumps(graph).encode())
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

    # OC coherent-demo mode: track OC's live per-signal-index state and mirror it
    # onto this sim's TLS each step (below), so the shown vehicles obey OC.
    oc_states: dict[str, str] = {}   # "<ctrl>.<sigIdx>" -> substate char (r/g/y/G/…)
    if OC_MIRROR:
        async def on_oc_status(msg: nats.aio.msg.Msg) -> None:
            try:
                d = json.loads(msg.data)
                parts = msg.subject.split('.')          # group.status.<ctrl>.<idx>
                oc_states['.'.join(parts[2:-1]) + '.' + parts[-1]] = d.get('substate', '')
            except Exception:
                pass
        await nc.subscribe('group.status.>', cb=on_oc_status)

    # Serve the static scenario files on request (same contract as simbridge —
    # see SIM_PROTOCOL.md `sim.{scenario}.{net,detectors,routes}`), so a backend
    # with no local scenario files can render this sim fully over NATS. Gzipped;
    # read once. Missing files are simply not offered.
    import gzip
    _files = {
        'net':       net_xml,
        'detectors': f'{SCENARIOS_DIR}/{scenario}.detectors.xml',
        'routes':    f'{SCENARIOS_DIR}/{scenario}.rou.xml',
    }
    for _kind, _path in _files.items():
        try:
            with open(_path, 'rb') as _f:
                _gz = gzip.compress(_f.read())
        except OSError:
            continue

        async def _on_file(msg: nats.aio.msg.Msg, _gz: bytes = _gz) -> None:
            await msg.respond(_gz)
        await nc.subscribe(f'sim.{scenario}.{_kind}', cb=_on_file)

    sumo_cmd = [
        'sumo', '-c', sumocfg,
        '--step-length', '0.1',   # 10 physics steps per sim-second
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
    # V2X: map each TLS link index -> grounded movement (fromLane/toLane/connection)
    await loop.run_in_executor(executor, _build_link_ground, scenario)
    # apply the pre-Start traffic scale before the first step, so scale=0 means
    # truly zero flow insertion from t=0 (no vehicles slip in during startup)
    await loop.run_in_executor(executor, traci.simulation.setScale, current_scale)
    # configured end time (from --end or the sumocfg); bounds a scale=0 run that
    # would otherwise never see an empty-network end
    end_bound = await loop.run_in_executor(executor, traci.simulation.getEndTime)
    delta_t = await loop.run_in_executor(executor, traci.simulation.getDeltaT)  # sim-s/step
    all_dets = list(await loop.run_in_executor(executor, traci.inductionloop.getIDList))
    frame_dets: set = set()   # detectors active on any step since the last frame
    # smoothed wall period between iteration starts — includes ALL overhead
    # (step, serialize, NATS flush, loop), so delta_t/period is the true rate
    last_frame = 0.0       # wall time of the last UI snapshot published
    last_fcd = 0.0         # wall time of the last floating-car graph emit
    next_step = None       # absolute wall schedule for the next step (self-correcting)
    achieved_ema = None    # smoothed actual sim-rate (×RT), measured per frame
    prev_fw = None         # wall time of the previous frame
    prev_ft = 0.0          # sim time of the previous frame
    insp_prev = None       # (veh id, sim t, speed) of last inspect, for frame accel
    FRAME_DT = 0.095       # ~10 Hz UI, decoupled from the step rate

    try:
        while True:
            if pending.get('stop'):
                break
            if paused:
                await asyncio.sleep(0.05)
                next_step = None    # resync schedule after pause
                prev_fw = None      # don't count the paused gap as a frame
                continue
            if 'scale' in pending:
                scale = pending.pop('scale')
                await loop.run_in_executor(executor, traci.simulation.setScale, scale)

            # OC coherent mode: stamp OC's live signals onto the TLS before stepping
            if OC_MIRROR:
                await loop.run_in_executor(executor, _apply_oc_tls, oc_states)

            t_start = time.monotonic()
            if next_step is None:
                next_step = t_start
            # only build the full vehicle snapshot on a UI frame (~10 Hz wall);
            # in between, bare steps keep the sim moving cheaply
            full = (t_start - last_frame) >= FRAME_DT
            # egocentric graphs are a decimated subset of UI frames (~3 Hz)
            want_fcd = full and (t_start - last_fcd) >= fcd_dt
            if want_fcd:
                last_fcd = t_start
            result = await loop.run_in_executor(
                executor, _do_step, net, selected, full, scenario, fcd_sel, want_fcd)
            last_t = result['t']
            empty = result.pop('_empty')
            frame_dets.update(result.pop('det_on'))   # union across the frame's steps
            # V2X: publish each floating car's egocentric graph on its own subject
            fcd = result.pop('fcd', None)
            if fcd:
                for vid, graph in fcd.items():
                    await nc.publish(f'kg.{scenario}.fcd.{vid}', json.dumps(graph).encode())
            # End on: reaching the configured end time, OR an empty network — but
            # NOT when scale is 0 (an intentionally empty sim awaiting injection).
            if (end_bound > 0 and last_t >= end_bound) or (empty and current_scale > 0):
                await nc.publish(f'sim.{scenario}.end', b'{}')
                break

            # events are collected every step so nothing is missed between
            # frames; publish immediately when present
            events = result.pop('events')
            if events:
                await nc.publish(
                    f'sim.{scenario}.log',
                    json.dumps({'type': 'log', 't': last_t, 'events': events}).encode(),
                )

            if full:
                last_frame = t_start
                # a detector shown "on" if it was active on ANY step this frame
                result['detectors'] = {d: d in frame_dets for d in all_dets}
                frame_dets = set()
                # a vanished element (arrived vehicle) reports gone once
                if result.get('inspect', {}).get('gone'):
                    selected = None
                # actual sustained sim-rate (×RT) = sim advanced / wall elapsed
                # since the last frame. Only when it falls meaningfully short of
                # the request is the machine limited — reported so the UI clamps.
                if prev_fw is not None and t_start > prev_fw:
                    a = (last_t - prev_ft) / (t_start - prev_fw)
                    achieved_ema = a if achieved_ema is None else 0.6 * achieved_ema + 0.4 * a
                prev_fw, prev_ft = t_start, last_t
                limited = achieved_ema is not None and achieved_ema < 0.9 * speed_req
                result['maxRate'] = round(achieved_ema, 1) if limited else 9999.0
                # Acceleration consistent with the displayed frames: SUMO's
                # getAcceleration is the instantaneous last-0.1s value, but at
                # high speed frames are seconds apart, so it wouldn't explain the
                # speed change the user sees (e.g. reads 0 for a car that just
                # braked to a stop). Report Δspeed/Δframe-time instead; at 1× the
                # frame IS one step, so this equals the instantaneous value.
                ins = result.get('inspect')
                if ins and ins.get('kind') == 'vehicle' and not ins.get('gone'):
                    if insp_prev and insp_prev[0] == ins['id'] and last_t > insp_prev[1]:
                        ins['accel'] = round((ins['speed'] - insp_prev[2]) / (last_t - insp_prev[1]), 2)
                    insp_prev = (ins['id'], last_t, ins['speed'])
                else:
                    insp_prev = None
                await nc.publish(
                    f'sim.{scenario}.state',
                    json.dumps(result).encode(),
                )

            # pace to real-time × speed_req against an ABSOLUTE schedule clock.
            # asyncio.sleep can't accurately sleep < ~1 ms, so at high speed we
            # DON'T reset on small delays — we let them accumulate across a few
            # cheap steps into one sleepable chunk (the absolute clock keeps the
            # average rate exact). Only a real backlog means flat-out (ceiling).
            next_step += delta_t / speed_req
            delay = next_step - time.monotonic()
            if delay > 0.001:
                await asyncio.sleep(delay)
            elif delay < -0.1:
                next_step = time.monotonic()      # cap backlog, don't spiral
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
