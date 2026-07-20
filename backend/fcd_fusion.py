"""Floating-car fusion node — merges egocentric graphs into a shared LDM.

A standalone NATS actor (the "edge / roadside" side of V2X): it subscribes to
every floating car's egocentric graph on `kg.{scenario}.fcd.>`, keeps the latest
per probe in a short TTL window, and on a fixed tick fuses them into one shared
Local Dynamic Map published on `kg.{scenario}.ldm`.

Merge = RDF-style union keyed by shared IRIs. An ego graph is first-person, so the
observer is implicit = its `@id`; we decompose each into subject-attributed facts
(self-report + observations of neighbours) and collapse by subject IRI, tracking
who observed each object (`observedBy`) and whether ≥2 stations corroborate it.

In sim, cross-car identity is shared ground truth, so association is free — see
docs/V2X_LDM_MERGE_PLAN.md for the sim-vs-real (data-association) seam.

Run:  python fcd_fusion.py <scenario> [nats_url]
Env:  FUSE_HZ (default 3), FCD_TTL seconds (default 2.0)
"""
import asyncio
import json
import os
import sys
import time

import nats

FUSE_HZ = max(0.5, float(os.environ.get('FUSE_HZ', '3')))
FCD_TTL = float(os.environ.get('FCD_TTL', '2.0'))   # drop a probe unheard this long


def _strip(vid_iri: str) -> str:
    # "veh:flow_5.1" -> "flow_5.1" (ids contain dots, never colons)
    return vid_iri.split(':', 1)[1] if vid_iri.startswith('veh:') else vid_iri


def _ldm_context(scenario: str) -> dict:
    return {
        '@vocab': 'https://opencontroller.org/ns/traffic#',
        'oct': 'https://opencontroller.org/ns/traffic#',
        'veh': f'urn:sim:{scenario}:veh:',
        'onLane': {'@type': '@id'},
    }


def _fuse(scenario: str, fresh: dict) -> dict:
    """Merge the fresh per-probe ego graphs into one LDM document."""
    observers = sorted(fresh)
    # subject id -> {observedBy:set, self:dict|None, obs:[...], isProbe:bool}
    objs: dict = {}

    def rec(sid: str) -> dict:
        return objs.setdefault(sid, {'observedBy': set(), 'self': None,
                                     'obs': [], 'isProbe': False})

    for aid, g in fresh.items():
        r = rec(aid)                      # a probe observes itself (self-report)
        r['observedBy'].add(aid)
        r['isProbe'] = True
        r['self'] = {'onLane': g.get('onLane'), 'lon': g.get('lon'),
                     'lat': g.get('lat'), 'speed': g.get('speed')}
        for s in g.get('sees', []):       # A's observations of its neighbours
            sid = _strip(s.get('@id', ''))
            if not sid:
                continue
            rr = rec(sid)
            rr['observedBy'].add(aid)
            rr['obs'].append({'by': aid, 'onLane': s.get('onLane'),
                              'lon': s.get('lon'), 'lat': s.get('lat'),
                              'speed': s.get('speed'), 'range': s.get('range')})

    def _avg(vals):
        vals = [x for x in vals if x is not None]
        return sum(vals) / len(vals) if vals else None

    out = []
    for sid, r in objs.items():
        ob = sorted(r['observedBy'])
        # consensus: trust the object's own self-report; else fuse observers
        if r['self'] and r['self'].get('lon') is not None:
            lon, lat = r['self']['lon'], r['self']['lat']
            lane, speed = r['self']['onLane'], r['self']['speed']
        elif r['obs']:
            lon, lat = _avg([o['lon'] for o in r['obs']]), _avg([o['lat'] for o in r['obs']])
            speed = _avg([o['speed'] for o in r['obs']])
            lanes = [o['onLane'] for o in r['obs'] if o.get('onLane')]
            lane = max(set(lanes), key=lanes.count) if lanes else None
            lon = round(lon, 7) if lon is not None else None
            lat = round(lat, 7) if lat is not None else None
            speed = round(speed, 2) if speed is not None else None
        else:
            lon = lat = lane = speed = None
        out.append({'@id': f'veh:{sid}', 'onLane': lane, 'lon': lon, 'lat': lat,
                    'speed': speed, 'observedBy': ob, 'sources': len(ob),
                    'confirmed': len(ob) >= 2, 'isProbe': r['isProbe']})

    t = max((g.get('t', 0) for g in fresh.values()), default=0)
    return {'@context': _ldm_context(scenario),
            '@id': f'urn:sim:{scenario}:ldm', '@type': 'LocalDynamicMap',
            't': t, 'observers': observers, 'objects': out}


async def run(scenario: str, nats_url: str) -> None:
    nc = await nats.connect(nats_url)
    latest: dict = {}          # vid -> (graph, recv_monotonic)
    stop = asyncio.Event()

    async def on_fcd(msg: nats.aio.msg.Msg) -> None:
        try:
            g = json.loads(msg.data)
            latest[_strip(g.get('@id', ''))] = (g, time.monotonic())
        except Exception:
            pass

    async def on_end(_msg: nats.aio.msg.Msg) -> None:
        stop.set()

    await nc.subscribe(f'kg.{scenario}.fcd.>', cb=on_fcd)
    await nc.subscribe(f'sim.{scenario}.end', cb=on_end)

    period = 1.0 / FUSE_HZ
    while not stop.is_set():
        now = time.monotonic()
        fresh = {vid: g for vid, (g, ts) in latest.items() if now - ts <= FCD_TTL}
        # prune stale probes so they don't linger in memory
        for vid in [v for v, (_, ts) in latest.items() if now - ts > FCD_TTL]:
            latest.pop(vid, None)
        if fresh:
            ldm = _fuse(scenario, fresh)
            await nc.publish(f'kg.{scenario}.ldm', json.dumps(ldm).encode())
        await asyncio.sleep(period)

    await nc.drain()


if __name__ == '__main__':
    scenario = sys.argv[1]
    nats_url = sys.argv[2] if len(sys.argv) > 2 else 'nats://localhost:4222'
    asyncio.run(run(scenario, nats_url))
