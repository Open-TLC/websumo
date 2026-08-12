# WebSUMO

Web-based viewer for SUMO traffic simulations. No X11 required.

**Stack:** FastAPI + libsumo + NATS (backend) · deck.gl + MapLibre GL JS (frontend)

## Architecture

```
Browser (deck.gl + MapLibre)
  ├── GET  /api/scenarios          → list available scenarios
  ├── GET  /api/network/{scenario} → GeoJSON (lanes, junctions, stop lines)
  ├── POST /api/adapter/start      → launch libsumo adapter subprocess
  ├── POST /api/adapter/stop       → stop adapter
  ├── GET  /api/adapter/log/{scenario} → tail of adapter stderr (startup warnings)
  └── WS   /api/ws/{scenario}      → stream per-step state + log events
                  ↕ NATS (localhost:4222)
        sumo_adapter.py  [libsumo embedded, one process per simulation]
                  ↕ libsumo (in-process, ~8× faster than TraCI socket)
             SUMO simulation
```

The libsumo adapter publishes simulation state to NATS after each step and
subscribes to command subjects from any connected client (browser, Open
Controller, recording tools). FastAPI relays NATS ↔ browser WebSocket on the
same port (8775), so only one port needs to be reachable from the browser.

## Quick start

```bash
# 1. Install Python dependencies
cd backend
pip install -r requirements.txt   # fastapi, uvicorn, nats-py, libsumo

# 2. Install and start NATS broker
./nats-server -c nats-server.conf   # TCP :4222 (backend ↔ NATS)

# 3. Build the frontend
cd frontend && npm install && npm run build

# 4. Start the backend (serves frontend + API + WebSocket relay)
cd ../backend
SCENARIOS_DIR=/tmp/shared/sumotest python -m uvicorn main:app --host 0.0.0.0 --port 8775
```

Open **http://localhost:8775**.

The `nats-server` binary is included in the repo root. `SCENARIOS_DIR` should
contain `.sumocfg` and `.net.xml` files (produced by `graph2sumo`).

### Access control

The `scenario` name in every request is validated against the built scenarios
(`GET /api/scenarios`) and a safe-character allowlist before it touches the
filesystem, subprocess argv, or NATS subjects — unknown or path-like names are
rejected with 404. The production build is served same-origin from this app, so
CORS is only needed for the Vite dev server; `ALLOWED_ORIGINS` (comma-separated)
defaults to the dev origins and should list your real frontend origin(s) — it is
never `*`, because the adapter endpoints spawn processes. Since those endpoints
start/stop SUMO, bind to `--host 127.0.0.1` unless the server must be reachable
from other machines (and add auth if it does).

## NATS subject schema

### Implemented

```
sim.{scenario}.state     ← adapter publishes after each step
sim.{scenario}.end       ← adapter publishes when simulation finishes
sim.{scenario}.log       ← adapter publishes exceptional events (sparse — only
                           on steps with collisions/teleports/emergency stops)
sim.{scenario}.cmd.pause
sim.{scenario}.cmd.resume
sim.{scenario}.cmd.stop
sim.{scenario}.cmd.speed    payload: {"v": <float>}  ×-real-time (1 = real time)
sim.{scenario}.cmd.scale    payload: {"v": <float 0–5>}  (0 = no flow insertion)
sim.{scenario}.cmd.select   payload: {"kind": "vehicle"|"tls", "id": ..., "client": ...}
                            empty payload deselects
sim.{scenario}.cmd.spawn    payload: {"edge": "approach_...", "vtype": "car",
                                      "lane": 0 (optional lane index; else 'free')}
                            inject one vehicle of vtype at that entry edge/lane
```

`select` makes the adapter attach an `inspect` block (vehicle: ~24 fields —
speed, route, leader, next signal, time loss…; tls: program table, current
phase, next switch) to every state message, plus one immediate
`{"type": "inspect", ...}` message so panels fill while paused.

> **Known limitation (multi-user):** the selection is a single global slot per
> adapter — every subscriber sees the same inspect block, and concurrent
> clients (second browser, OC tooling) overwrite each other's selection. Fine
> for the current single-operator use; a multi-user setup needs per-client
> selections keyed by the `client` field (already in the payload for forward
> compatibility) or request-reply inspection. Tracked in TODO.md.

State message:
```json
{
  "t": 123.4,
  "vehicles": [["id", lon, lat, angle, length, width, "vclass"], ...],
  "tls": {"<junction_id>": "GGrrGGrr"},
  "detectors": {"<det_id>": true},
  "maxRate": 303.0
}
```
`detectors` maps each induction loop ID to whether it was occupied on **any
step of the displayed frame** — occupancy is sampled every 0.1 s step and
unioned per frame, so brief crossings aren't missed at high playback speed
(sampling only the frame's last step misses ~95% of activity at 20×). Note:
this is a *viewer* aggregation; OC integration will need the per-step detector
stream on its own subject, not this frame-unioned value. `maxRate` is the sustained playback rate in
×-real-time while the loop is throughput-limited (running flat out), or a high
sentinel (`9999`) when it is keeping up with the requested speed; the UI uses it
to clamp and redden the speed slider at the machine's ceiling.

Log message (only published on steps where something exceptional happened):
```json
{
  "type": "log",
  "t": 146.0,
  "events": [
    {"type": "collision", "text": "flow_12.1 vs flow_18.1", "lane": "exit_..._car_0"},
    {"type": "teleport",  "text": "flow_12.1"}
  ]
}
```
Event types: `collision`, `teleport`, `emergency` (emergency stop). These come
from libsumo's structured APIs (`getCollisions`, `getStartingTeleportIDList`,
`getEmergencyStoppingVehiclesIDList`) — verified to match SUMO's stderr
warnings 1:1 (timestamps differ by one step: SUMO stamps step begin, the
adapter stamps step end). SUMO's free-text startup warnings are served
separately via `GET /api/adapter/log/{scenario}` (tail of the adapter's stderr
log — `--log FILE` is buffered until close and unusable live). That endpoint
filters out runtime teleport/emergency warnings by default since they
duplicate the structured event stream; pass `?full=true` for the raw tail.
Load runs a one-step SUMO check in the background so the same warnings are
available before Start (skipped while an adapter is running).

Any NATS client (OC, recorder, custom tool) can subscribe to `sim.{scenario}.state`
or publish commands to `sim.{scenario}.cmd.*` alongside the browser. Commands are
fire-and-forget; they are buffered and applied before the next simulation step.

### Open Controller integration

WebSUMO exposes a stable NATS interface — the `sim.{scenario}.*` subjects above,
frozen (versioned `v: 1`) in `docs/SIM_PROTOCOL.md`. Integration is implemented
on the **OC side** against that interface: OC's simengine publishes
`sim.{scenario}.state` and consumes `sim.{scenario}.cmd.*` via
`backend/simbridge.py` (see `docs/INTEGRATING_WITH_OC.md`; hand-off summary in
`docs/OC_INTEGRATION_HANDOFF.md`). WebSUMO is then a pure NATS subscriber; the
`sumo_adapter.py` in this repo is the standalone (no-OC) simengine.

Other approaches — the adapter republishing OC's `detector.control.*` /
`group.control.*` subjects, or a drop-in `nats_traci` transport (see
`docs/NATS_TRACI_REPLACEMENT_RESEARCH.md`) — were considered but are not planned
at this stage.

## Development (hot reload)

```bash
# Terminal 1 — NATS
./nats-server -c nats-server.conf

# Terminal 2 — FastAPI backend
cd backend && SCENARIOS_DIR=/tmp/shared/sumotest uvicorn main:app --reload --port 8000

# Terminal 3 — Vite dev server (proxies /api and /api/ws to :8000)
cd frontend && npm run dev
```

Open **http://localhost:5173**. The Vite proxy forwards API and WebSocket traffic to the
backend automatically.

## Preparing scenarios

SUMO scenarios require `.sumocfg` and `.net.xml` files. These can be:

1. **Generated from intersection graphs** (Helsinki use case):
   - Use `graph2sumo` (https://github.com/Open-TLC/graph2sumo) to extract scenarios from intersection graphs.
   - Outputs land in `{SCENARIOS_DIR}` (default: `/tmp/shared/sumotest/`).

2. **Obtained from standard SUMO tools:**
   - Use SUMO's `netgenerate`, `netedit`, or other network generation tools.
   - Place `.sumocfg` and `.net.xml` files in `{SCENARIOS_DIR}`.

3. **Public test scenarios:**
   - Download SUMO's built-in scenarios from the SUMO repository.

Place all scenario files in the directory specified by the `SCENARIOS_DIR` environment variable (defaults to `/tmp/shared/sumotest/`).

## What is visualised

| Layer | Rendering | Source |
|-------|-----------|--------|
| Junction areas | Filled polygons (MapLibre) | Node shapes from `.net.xml` |
| Lane centrelines | Lines (MapLibre) | Edge/lane shapes from `.net.xml` |
| Stop lines | Coloured bars at lane ends (deck.gl) | TLS links; colour = live signal state |
| Detectors | Cross-lane bars at loop positions (deck.gl) | `{scenario}.detectors.xml`; live occupancy per step |
| Vehicles | Oriented rectangles at actual SUMO dimensions (deck.gl) | libsumo per step |
| Generators | Green circles per input lane at entries that start a route (deck.gl, clickable) | `.rou.xml` routes + per-lane vClass masks |

Stop line colours: **green** (G/g), **red** (r/R), **yellow** (y/Y), grey otherwise.
Detector colours: steel blue when clear, **bright cyan** (wider) when occupied.
Vehicle colour by class: orange = car, blue = tram, green = bus, brown = truck.

### Detector files

Each scenario *optionally* needs a `{scenario}.detectors.xml` (inductionLoop definitions)
next to its `.sumocfg` in `SCENARIOS_DIR`. If provided, detectors are rendered as bars 
on the map and their occupancy is live-updated in the UI.

Detectors can be:
- Generated by `graph2sumo` (if using the Helsinki intersection pipeline)
- Created with SUMO's standard tools (`netedit`, custom scripts)
- Omitted entirely (the scenario runs without detector visualization)

Name the file to match the scenario: `{scenario}.detectors.xml`. If the file is missing, 
the scenario runs without detectors — the viewer and adapter degrade gracefully.

## Controls

| Control | Effect |
|---------|--------|
| Load | Render network GeoJSON, fit map to bounds; runs a one-step SUMO check in the background so load warnings show in LOG immediately |
| Length | Simulation duration (1 h / 4 h / 8 h / 24 h) — flow rates are stretched to cover the chosen span |
| ▶ Start | Launch libsumo adapter, connect WebSocket |
| ⏸ / ▶ | Pause / resume simulation |
| ■ Stop | Stop simulation, clear vehicles |
| ↺ Reset | Force-stop adapter, return to idle |
| Speed slider | **×-real-time** playback, **logarithmic** (1× = real time … up to a high max; default 20×). If the machine can't sustain the requested rate the slider **clamps to the achievable ceiling and turns red**. Tunable **before** Start; applied from t=0 |
| Traffic slider | Vehicle insertion scale (**0× – 5×**) via `simulation.setScale`. **0 = no flow insertion** — an empty sim you populate with the generators (it stays running until the duration/Stop rather than ending on empty). Tunable before Start; applied from t=0 |
| BLK / OSM | Toggle CartoDB Light basemap |
| LOG | Open simulation log overlay — startup warnings (amber, from SUMO stderr) + live events (collisions red, teleports orange, emergency stops yellow); unread badge while closed |
| Click vehicle / junction | Element inspector (right side, closes LOG and vice versa): vehicles show live state incl. leader gap, next signal, time loss; traffic lights show the program table with current phase + next-switch countdown (works statically after Load too — the click target is the junction's area polygon around the intersection centre). Click empty map to deselect. Units are SUMO-native (m/s) |
| Inject selector + click green marker | Green markers appear after Load — **one per input lane** of each entry that starts a route, at that lane's upstream end. Click one to inject a vehicle of the selected vType **onto that specific lane**. Each marker offers only the vTypes its lane allows (a bike/bus-only lane with no matching vType gets no marker); if the selected type isn't allowed there, the lane's first accepted type is used. Requires a running/paused sim. Manual vehicles get `manual_N` IDs. Adjacent lane markers sit close together — zoom in to target a specific lane |

Demand is defined as flows (`vehsPerHour` per route), not explicit vehicle
lists. Longer durations repeat the same hourly rates — there are no diurnal
peaks unless the upstream demand generation (graph2sumo) adds time-windowed
flows. Speed is ×-real-time: at the default 20× a 1 h simulation takes ~3 min
wall; the practical ceiling is whatever the host can render (a few hundred × on
a typical machine, shown by the red slider clamp).

## Integration with Open Controller

WebSUMO is designed to work alongside Open Controller (OC). Both tools connect to the 
same NATS broker and can visualize and control the same SUMO simulation.

### For OC users

- See `docs/SIM_PROTOCOL.md` for the NATS contract.
- See `docs/INTEGRATING_WITH_OC.md` for step-by-step integration into OC's `simengine_integrated.py`.
- See `docs/OC_INTEGRATION_HANDOFF.md` for a quick handoff summary.

The integration requires copying `backend/simbridge.py` into OC and adding ~15 lines 
of code to OC's simengine loop. No changes to SUMO or OC's control logic.

### For WebSUMO standalone users

WebSUMO works independently without OC. Run `backend/main.py` to visualize any SUMO 
scenario. The OC integration is optional and has no impact on standalone usage.

### OpenController-specific features

Some features in `backend/sumo_adapter.py` are specific to the Helsinki Open Controller 
project (IRI grounding for the V2X knowledge graph, ego-centric FCD graphs). These are 
optional and controlled by environment variables (`OCT_GRAPH_DIR`, `FCD_SELECTOR`). 
External users can ignore these features or disable them.
