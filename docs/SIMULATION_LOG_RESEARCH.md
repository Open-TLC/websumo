# Simulation Log Messages in the Viewer
## Feasibility research

*Researched and verified 2026-07-02 against fi.helsinki.269 with libsumo 1.27.0.*

> **Status: IMPLEMENTED (2026-07-03).** Both channels shipped as designed,
> plus a load-time check (one-step SUMO run on Load so warnings show before
> Start). Verification: structured events matched stderr warnings 70/70 on a
> full 269 run, timestamps offset by exactly one step (SUMO stamps step begin,
> the adapter stamps step end). See README for the final subject/endpoint schema.

## The question

sumo-gui shows a message log panel (warnings, teleports, collisions, errors)
during the run. Can equivalent information be fetched via libsumo and NATS,
shown behind a log button rather than a permanent panel?

## Feasibility: CONFIRMED — two complementary channels

### Channel 1: structured events via libsumo API (preferred)

Verified live against 269 (400 steps → 14 events captured):

```python
libsumo.simulation.getStartingTeleportIDList()   # vehicles teleporting this step
libsumo.simulation.getCollisions()               # Collision objects: collider, victim, lane, pos, type
libsumo.simulation.getDepartedIDList()           # vehicles that entered this step
libsumo.simulation.getArrivedIDList()            # vehicles that finished this step
libsumo.simulation.getEmergencyStoppingVehiclesIDList()
libsumo.simulation.getPendingVehicles()          # queued, cannot insert
```

Sample captured output:
```
(7.0,   'teleport',  'flow_18.0')
(7.0,   'collision', 'flow_18.0 vs flow_12.0')
(146.0, 'teleport',  'flow_12.1')
```

These are **structured** — timestamped, typed, with vehicle IDs — better than
parsing sumo-gui's text log. They cover the operationally interesting events
(collisions, teleports, insertion problems). Cost: a few extra libsumo calls
per step, each ~µs (verified negligible against the 0.08 ms/step baseline).

### Channel 2: SUMO's free-text warnings (already captured)

Two findings:

1. **`--log FILE` is buffered** — tested: the file stays at 0 bytes during the
   run and is only flushed on `close()`. Not usable for live display.

2. **stderr is live.** libsumo runs SUMO in-process, so SUMO's C++ warning
   output goes to the adapter process's stderr — which FastAPI already
   redirects to `/tmp/sumo_adapter_{scenario}.log`. C++ stderr is unbuffered,
   so this file updates in real time. This is where one-time startup warnings
   land (e.g. "Unsafe green phase...", detector validation messages) that the
   structured API doesn't expose.

A simple `GET /api/adapter/log/{scenario}` endpoint returning the tail of
that file covers channel 2 with ~10 lines of backend code.

## Design

### Adapter (~25 lines)

Collect events in `_do_step()` and publish them on a dedicated subject —
only when non-empty, so the subject stays quiet in normal operation:

```
sim.{scenario}.log    payload: {"t": 146.0, "events": [
                        {"type": "collision", "text": "flow_12.1 vs flow_18.1", "lane": "..."},
                        {"type": "teleport",  "text": "flow_12.1"}
                      ]}
```

Departed/arrived counts are high-volume and low-interest — include only
teleports, collisions, emergency stops, and insertion-blocked events.

### FastAPI (~10 lines)

`GET /api/adapter/log/{scenario}` — returns the last N lines of
`/tmp/sumo_adapter_{scenario}.log` (startup warnings, crash output).

### Frontend (~60 lines)

- **LOG button** in the control panel title row (next to BLK/OSM), with an
  unread-count badge that increments when events arrive
- Clicking opens a dismissible overlay listing events newest-first:
  `T=146.0  ⚠ collision  flow_12.1 vs flow_18.1`
- The WebSocket relay already forwards any `sim.{scenario}.*` subject the
  backend subscribes to — add `sim.{scenario}.log` to the relay subscriptions
  and tag messages with `{"type": "log"}` for the frontend to route
- Log panel also shows the startup warnings fetched once from the FastAPI
  endpoint when opened

### Effort estimate

| Piece | Size |
|-------|------|
| Adapter event collection + publish | ~25 lines |
| Relay subscription + message tagging | ~10 lines |
| FastAPI log-tail endpoint | ~10 lines |
| LOG button + overlay panel | ~60 lines |
| **Total** | **~half a day** |

## Caveats

- `getCollisions()` requires SUMO ≥ 1.13 (we run 1.27 — fine)
- The teleport warnings in 269 are a known network artefact (vehicles
  colliding at `exit_2688cbe2a0f0`); the log panel will make these visible
  to users — arguably a feature, since they indicate network quality issues
- Event volume is bounded: only exceptional events are published, so no
  throttling needed even at 50× speed
- stderr log file grows unbounded on very long runs — rotate or cap the
  tail endpoint read (last 200 lines suffices)
