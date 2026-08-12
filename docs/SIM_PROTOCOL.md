# WebSUMO Simulation Protocol

**Version: 1.0** | **Last updated: 2026-08-11**

This document specifies the NATS-based protocol for publishing and controlling simulation state. Any simulation engine (SUMO via libsumo, TraCI, or other) that publishes to this protocol can be visualized in WebSUMO.

---

## Overview

The protocol uses **NATS** as the message broker. A simengine publishes simulation state after each step; clients (UI, controller, recorder) subscribe to state and publish commands. **One simengine per scenario is authoritative; multiple subscribers are allowed.**

The subject hierarchy is:

```
sim.{scenario}.state       ← simengine publishes each step
sim.{scenario}.log         ← simengine publishes events (collisions, etc.)
sim.{scenario}.end         ← simengine publishes when sim ends
sim.{scenario}.cmd.*       ← clients publish commands (pause, speed, scale, etc.)
```

Example scenario IDs: `fi.helsinki.269`, `test.intersection`, etc. — any string without dots-or-hyphens in the subject path.

---

## Message Schemas

### `sim.{scenario}.state` — Simulation step snapshot (publish after each step)

**Payload:** JSON object. **Frequency:** ~10 Hz (when full snapshot requested); steps proceed faster internally.

```json
{
  "v": 1,
  "t": 123.4,
  "vehicles": [
    ["veh0", 24.9384567, 60.1699001, 90.0, 5.0, 2.0, "passenger"],
    ["veh1", 24.9385000, 60.1699100, 45.5, 5.0, 2.0, "truck"]
  ],
  "persons": [
    ["ped0", 24.9384600, 60.1699050, 180.0, 1.2],
    ["bike1", 24.9384700, 60.1699200, 0.0, 5.5]
  ],
  "tls": {
    "tl0": "GGrrGGrr",
    "tl1": "rGrG"
  },
  "detectors": {
    "loop0": true,
    "loop1": false,
    "loop2": true
  },
  "events": [
    {"type": "collision", "text": "veh0 vs veh1", "lane": "edge_0_0"},
    {"type": "teleport", "text": "veh2"}
  ],
  "maxRate": 1.0,
  "_empty": false,
  "inspect": {...}
}
```

**Field definitions:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `v` | int | yes | Protocol version (1) |
| `t` | float | yes | Simulation time (seconds) |
| `vehicles` | array | yes | Each vehicle: `[id, lon, lat, angle_deg, length_m, width_m, vclass]`. Empty array if no vehicles. |
| `persons` | array | yes | Each pedestrian/cyclist: `[id, lon, lat, angle_deg, speed_m_s]`. Empty array if no persons. |
| `tls` | object | yes | Junction TLS ID → SUMO phase state string (e.g., "GGrrGGrr"). Empty object if no TLS. |
| `detectors` | object | yes | Detector ID → boolean (active/inactive this step). Empty object if no detectors. |
| `events` | array | no | Exceptional events (collisions, teleports, emergency stops). Each: `{type, text, lane?}`. |
| `maxRate` | float | no | Actual sim speed as multiple of real-time (e.g., 1.0 = 1× speed). Omit if not rate-limited. |
| `_empty` | bool | no | True if no more vehicles expected and sim should end (when reached configured end time or flows end). |
| `inspect` | object | no | If a client selected an element (vehicle or TLS), its static + live properties. See schema below. |

**Coordinate system:** lon/lat in WGS84 (EPSG:4326), converted from the SUMO network's projected CRS via `sumolib.net.readNet(...).convertXY2LonLat(x, y)`.

**Vehicle class (vclass):** SUMO standard: `passenger`, `truck`, `bus`, `motorcycle`, `bicycle`, `pedestrian`, etc.

#### `state.inspect` — Element inspection (optional)

Published when a client selects a vehicle or TLS for detailed inspection. Example:

```json
{
  "kind": "vehicle",
  "id": "veh0",
  "type": "car",
  "vclass": "passenger",
  "speed": 12.5,
  "allowedSpeed": 13.9,
  "accel": 0.8,
  "lane": "approach_a1b2_car_1",
  "lanePos": 45.3,
  "route": "route_0",
  "routeEdges": ["approach_a1b2_car", "internal_jc_0_1", "exit_a1b2_car"],
  "routeIndex": 1,
  "departure": 10.0,
  "departDelay": 0.0,
  "waiting": 0.0,
  "accumWaiting": 0.0,
  "timeLoss": 0.0,
  "distance": 1234.5,
  "leader": ["veh1", 12.3],
  "nextTLS": ["tl0", 45.0, "GGrrGGrr"],
  "speedFactor": 1.0,
  "length": 5.0,
  "width": 2.0,
  "minGap": 2.5
}
```

or for TLS:

```json
{
  "kind": "tls",
  "id": "tl0",
  "program": "0",
  "phase": 0,
  "state": "GGrrGGrr",
  "nextSwitch": 12.3,
  "spent": 8.1,
  "phases": [[30.0, "GGrrGGrr"], [5.0, "yyrryyRR"], [30.0, "rrGGrrGG"], [5.0, "rryyrrYY"]]
}
```

---

### `sim.{scenario}.log` — Events and diagnostics (publish immediately when present)

**Payload:** JSON object.

```json
{
  "type": "log",
  "t": 123.4,
  "events": [
    {"type": "collision", "text": "veh0 vs veh1", "lane": "edge_0_0"},
    {"type": "teleport", "text": "veh2"},
    {"type": "emergency", "text": "veh3"},
    {"type": "spawn-failed", "text": "car @ approach_a1b2_car: vehicle type not allowed"}
  ]
}
```

**Event types:**
- `collision` — vehicle(s) collided
- `teleport` — vehicle relocated (e.g., stuck)
- `emergency` — vehicle emergency-braked
- `spawn-failed` — injection failed (bad route, vclass mismatch, etc.)

---

### `sim.{scenario}.end` — Simulation ended (publish once when sim terminates)

**Payload:** Empty JSON object `{}`.

Indicates the simulation has reached its configured end time or run out of traffic. Clients should reset their state, hide playback controls, or prompt for a new scenario.

---

## Commands (simengine subscribes to `sim.{scenario}.cmd.*`)

### `sim.{scenario}.cmd.pause`

**Payload:** Empty object `{}` or omitted.

**Effect:** Pause the simulation (do not step). The simengine continues to process other commands and publish state if polled, but does not advance simulation time.

---

### `sim.{scenario}.cmd.resume`

**Payload:** Empty object `{}` or omitted.

**Effect:** Resume stepping after pause.

---

### `sim.{scenario}.cmd.stop`

**Payload:** Empty object `{}` or omitted.

**Effect:** Stop the simulation cleanly (as if end of scenario reached). Publish `sim.{scenario}.end` and exit.

---

### `sim.{scenario}.cmd.speed`

**Payload:** `{"v": <float>}` where `v ∈ [0.1, 1000.0]`.

**Example:** `{"v": 2.0}` = run at 2× real-time.

**Effect:** Adjust real-time speed multiplier. At 1.0, wall-clock time matches simulation time; at 2.0, the sim runs twice as fast as real-time.

---

### `sim.{scenario}.cmd.scale`

**Payload:** `{"v": <float>}` where `v ∈ [0.0, 5.0]`.

**Example:** `{"v": 0.5}` = reduce traffic volume to 50%.

**Effect:** Scale traffic demand (vehicle flow rates). At 0.0, no vehicles enter (only manual injections or spawns). At 1.0, full configured demand. Used to modulate load.

---

### `sim.{scenario}.cmd.select`

**Payload:** `{"kind": "vehicle" | "tls", "id": "<element_id>"}`.

**Example:** `{"kind": "vehicle", "id": "veh0"}` or `{"kind": "tls", "id": "tl0"}`.

**Effect:** Request inspection of a specific element. The simengine should immediately publish a `state` message with an `inspect` field containing that element's details (static + current live values). Used for the detail panel in the UI.

---

### `sim.{scenario}.cmd.spawn`

**Payload:** `{"edge": "<entry_edge>", "vtype": "<vtype_id>", "lane": <int> | null}`.

**Example:** `{"edge": "approach_a1b2_car", "vtype": "car", "lane": 0}` or `{"edge": "...", "vtype": "car"}` (lane omitted = free departure).

**Effect:** Inject one vehicle of type `vtype` at entry edge. If `lane` is specified, prefer that lane; if `null` or omitted, let SUMO choose. The simengine should:
- Validate the edge exists and is an entry edge (no incoming edges).
- Validate the vtype is defined.
- Inject with `departPos='free'` and `departSpeed='max'`.
- On failure, publish a `sim.{scenario}.log` message with a `spawn-failed` event.

---

## Semantics and guarantees

### Step flow

Each simulation step in the simengine should:

1. **Collect pending commands** from `sim.{scenario}.cmd.*` (non-blocking).
2. **Apply commands** (pause flag, speed, scale, TLS state changes, etc.) — most are idempotent.
3. **Advance simulation:** `traci.simulationStep()` (or equivalent).
4. **Serialize state** and publish to `sim.{scenario}.state` (every step or decimated for UI frames).
5. **Publish log** if events occurred (collision, teleport, etc.).
6. **Check termination:** if the simulation has ended (configured end time or no more vehicles + scale > 0), publish `sim.{scenario}.end` and exit.

### Timing and frame rates

- **Step frequency:** Simulation can step as fast as CPU allows; a typical intersection might step at 10–100 Hz depending on load and `--step-length`.
- **State publish frequency:** Simengine decides. WebSUMO's UI can display at ~10 Hz refresh (browser frame rate); publishing every step is fine (NATS and WebSocket handle the decimation). Some publishers may skip frames when under load, or publish only on "full" snapshots for performance.
- **Command latency:** Commands are best-effort. They land in the simengine's message queue, processed before the next step. Fire-and-forget semantics are acceptable (simengine does not ack each command).

### Atomicity

All fields in a `state` message are from the same simulation step — i.e., they are atomic. A vehicle's position, TLS state, and detector readings all refer to time `t`.

### Errors

If a simengine encounters an unrecoverable error:
- Publish a `log` message describing the error.
- Do **not** publish further `state` messages; terminate gracefully or wait for `stop` command.
- The simengine is responsible for cleanup (closing SUMO, etc.).

If a command is malformed or unsupported:
- Silently ignore it (backward compatibility).
- Do not publish an error message (to avoid coupling).

---

## Example: integrating a simengine

Pseudocode for an OC simengine step loop (the module owning the SUMO steps —
e.g. `simengine.py`):

```python
import nats
import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
import libsumo as traci

scenario = "fi.helsinki.269"
nc = await nats.connect("nats://localhost:4222")
paused = False
speed = 1.0
scale = 1.0

async def on_cmd(msg):
    global paused, speed, scale
    cmd = msg.subject.split('.')[-1]
    data = json.loads(msg.data or '{}')
    if cmd == 'pause':
        paused = True
    elif cmd == 'resume':
        paused = False
    elif cmd == 'speed':
        speed = max(0.1, min(data.get('v', 1.0), 1000.0))
    elif cmd == 'scale':
        scale = max(0.0, min(data.get('v', 1.0), 5.0))

await nc.subscribe(f'sim.{scenario}.cmd.*', cb=on_cmd)

# Start SUMO
traci.start(['sumo', '-c', 'scenario.sumocfg', '--step-length', '0.1'])
traci.simulation.setScale(scale)

# Step loop (simplified)
while True:
    if paused:
        await asyncio.sleep(0.05)
        continue
    
    traci.simulationStep()
    
    # Serialize state
    vehicles = [
        [v, lon, lat, angle, length, width, vclass]
        for v in traci.vehicle.getIDList()
    ]
    tls = {
        tid: traci.trafficlight.getRedYellowGreenState(tid)
        for tid in traci.trafficlight.getIDList()
    }
    state = {
        "v": 1,
        "t": round(traci.simulation.getTime(), 1),
        "vehicles": vehicles,
        "persons": [],
        "tls": tls,
        "detectors": {},
        "_empty": traci.simulation.getMinExpectedNumber() == 0
    }
    
    # Publish
    await nc.publish(f'sim.{scenario}.state', json.dumps(state).encode())
    
    if state['_empty']:
        await nc.publish(f'sim.{scenario}.end', b'{}')
        break

traci.close()
```

For a production implementation, use the `simbridge.py` module provided by WebSUMO (see the integration guide).

---

## Versioning

This protocol is versioned via the `v` field in the state message. Future incompatible changes will bump the version number. Clients should:
- Accept `v: 1` messages.
- Ignore messages with unknown versions (or log a warning).
- Support version negotiation if needed in the future.

---

## References

- NATS: https://nats.io/
- SUMO TraCI: https://sumo.dlr.de/docs/TraCI/
- libsumo: https://sumo.dlr.de/docs/Libsumo.html
