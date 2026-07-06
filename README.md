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
sim.{scenario}.cmd.speed    payload: {"v": <float 0.1–50>}
sim.{scenario}.cmd.scale    payload: {"v": <float 0.1–5>}
sim.{scenario}.cmd.select   payload: {"kind": "vehicle"|"tls", "id": ..., "client": ...}
                            empty payload deselects
sim.{scenario}.cmd.spawn    payload: {"edge": "approach_...", "vtype": "car"}
                            inject one vehicle of vtype at that entry edge
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
  "detectors": {"<det_id>": true}
}
```
`detectors` maps each induction loop ID to its occupancy (vehicle present or
passed during the last step).

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

### Planned (for Open Controller integration)

The command set is intentionally minimal — new subjects are added as needed
(each is a few lines in `sumo_adapter.py`'s `on_cmd` handler). Detector
occupancy is already read every step and included in the state message; the
remaining increment for a drop-in replacement of OC's
`simengine_integrated.py`:

```
detector.control.{det_id}   ← adapter republishes detector occupancy in OC's
                              format: {"id": ..., "loop_on": bool, "tstamp": ISO8601}
                              (OC's control engine subscribes to these)
group.control.{group_id}    ← OC publishes its computed signal states here;
                              adapter subscribes and applies them via
                              trafficlight.setRedYellowGreenState
```

**Not yet implemented, and the names above are provisional.** Unlike our
`sim.{scenario}.*` subjects, OC's detector/group subjects are *flat* (not
scenario-scoped), so a single broker serves one scenario at a time — running
two scenarios against one OC would cross-talk. Confirm the exact subject
spellings and payload shapes against OC's real code before building; `group.*`
vs the older `group.status.*` naming in particular is unverified here.

A generic request-reply layer (`sumo.{sim}.get/set.{domain}.{var}`) was
researched (see `docs/NATS_TRACI_REPLACEMENT_RESEARCH.md`) but is deliberately
not built — specific, validated subjects are added incrementally instead.

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

Scenarios are built from intersection graphs in `helsinki_intersections`.
Always use the `--repo` flag — never pass a local `graph.ttl` (stale, missing signal data):

```bash
cd /repos/graph2sumo
./build_and_extract.sh --repo fi.helsinki.266
./build_and_extract.sh --repo fi.helsinki.269
./build_and_extract.sh --repo fi.helsinki.270
```

Outputs land in `/tmp/shared/sumotest/`.

## What is visualised

| Layer | Rendering | Source |
|-------|-----------|--------|
| Junction areas | Filled polygons (MapLibre) | Node shapes from `.net.xml` |
| Lane centrelines | Lines (MapLibre) | Edge/lane shapes from `.net.xml` |
| Stop lines | Coloured bars at lane ends (deck.gl) | TLS links; colour = live signal state |
| Detectors | Cross-lane bars at loop positions (deck.gl) | `{scenario}.detectors.xml`; live occupancy per step |
| Vehicles | Oriented rectangles at actual SUMO dimensions (deck.gl) | libsumo per step |
| Generators | Green circles at entry edges that start a route (deck.gl, clickable) | `.rou.xml` routes + lane vClass masks |

Stop line colours: **green** (G/g), **red** (r/R), **yellow** (y/Y), grey otherwise.
Detector colours: steel blue when clear, **bright cyan** (wider) when occupied.
Vehicle colour by class: orange = car, blue = tram, green = bus, brown = truck.

### Detector files

Each scenario needs a `{scenario}.detectors.xml` (inductionLoop definitions)
next to its `.sumocfg` in `SCENARIOS_DIR`. These are generated per scenario by
graph2sumo into `build/{scenario}/additional_detectors.xml` — copy them with
the per-scenario name:

```bash
cp /repos/graph2sumo/build/fi.helsinki.269/additional_detectors.xml \
   /tmp/shared/sumotest/fi.helsinki.269.detectors.xml
```

**Do not share one `additional_detectors.xml` between scenarios** — detector
lane IDs are scenario-specific and a mismatched file makes SUMO refuse to
start. (This was a real bug: builds copied every scenario's detector file to
the same shared filename, last extraction winning.)

If the file is missing, the scenario runs without detectors — the viewer and
adapter degrade gracefully.

## Controls

| Control | Effect |
|---------|--------|
| Load | Render network GeoJSON, fit map to bounds; runs a one-step SUMO check in the background so load warnings show in LOG immediately |
| Length | Simulation duration (1 h / 4 h / 8 h / 24 h) — flow rates are stretched to cover the chosen span |
| ▶ Start | Launch libsumo adapter, connect WebSocket |
| ⏸ / ▶ | Pause / resume simulation |
| ■ Stop | Stop simulation, clear vehicles |
| ↺ Reset | Force-stop adapter, return to idle |
| Speed slider | Wall-clock rate (0.1× – 50×) |
| Traffic slider | Vehicle insertion scale (0.1× – 5×) via `simulation.setScale` |
| BLK / OSM | Toggle CartoDB Light basemap |
| LOG | Open simulation log overlay — startup warnings (amber, from SUMO stderr) + live events (collisions red, teleports orange, emergency stops yellow); unread badge while closed |
| Click vehicle / junction | Element inspector (right side, closes LOG and vice versa): vehicles show live state incl. leader gap, next signal, time loss; traffic lights show the program table with current phase + next-switch countdown (works statically after Load too — the click target is the junction's area polygon around the intersection centre). Click empty map to deselect. Units are SUMO-native (m/s) |
| Inject selector + click green marker | Click a green entry marker (shown after Load) to inject one vehicle of the selected vType at that approach. The selector lists the vTypes the network accepts; if the selected type isn't allowed at the clicked entry, the entry's first accepted type is used. Requires a running/paused sim. Manual vehicles get `manual_N` IDs and appear in the state stream like any other |

Demand is defined as flows (`vehsPerHour` per route), not explicit vehicle
lists. Longer durations repeat the same hourly rates — there are no diurnal
peaks unless the upstream demand generation (graph2sumo) adds time-windowed
flows. At 50× a full 24 h simulation takes ~30 min wall time.

## Integration with Open Controller

See `docs/INTEGRATION_ROADMAP.md` and `docs/NATS_TRACI_REPLACEMENT_RESEARCH.md`.
OC's control engine is already NATS-native. The adapter does **not** yet publish
or consume OC subjects — the detector republish and the signal-command path are
the remaining work (TODO item 2). The planned contract is under
[Planned](#planned-for-open-controller-integration) above; its exact subject
names and payloads must be confirmed against OC's `simengine_integrated.py` /
`clockwork.py` before implementing.
