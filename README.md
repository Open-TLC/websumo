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
  └── WS   /api/ws/{scenario}      → stream per-step state (vehicles + TLS)
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
./nats-server -c nats-server.conf   # TCP :4222 · WS :9222

# 3. Build the frontend
cd frontend && npm install && npm run build

# 4. Start the backend (serves frontend + API + WebSocket relay)
cd ../backend
SCENARIOS_DIR=/tmp/shared/sumotest python -m uvicorn main:app --host 0.0.0.0 --port 8775
```

Open **http://localhost:8775**.

The `nats-server` binary is included in the repo root. `SCENARIOS_DIR` should
contain `.sumocfg` and `.net.xml` files (produced by `graph2sumo`).

## NATS subject schema

```
sim.{scenario}.state     ← adapter publishes after each step
sim.{scenario}.end       ← adapter publishes when simulation finishes
sim.{scenario}.cmd.pause
sim.{scenario}.cmd.resume
sim.{scenario}.cmd.stop
sim.{scenario}.cmd.speed    payload: {"v": <float 0.1–20>}
sim.{scenario}.cmd.scale    payload: {"v": <float 0.1–5>}
```

Any NATS client (OC, recorder, custom tool) can subscribe to `sim.{scenario}.state`
or publish commands to `sim.{scenario}.cmd.*` alongside the browser.

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
| Vehicles | Oriented rectangles at actual SUMO dimensions (deck.gl) | libsumo per step |

Stop line colours: **green** (G/g), **red** (r/R), **yellow** (y/Y), grey otherwise.
Vehicle colour by class: orange = car, blue = tram, green = bus, brown = truck.

## Controls

| Control | Effect |
|---------|--------|
| Load | Render network GeoJSON, fit map to bounds |
| ▶ Start | Launch libsumo adapter, connect WebSocket |
| ⏸ / ▶ | Pause / resume simulation |
| ■ Stop | Stop simulation, clear vehicles |
| ↺ Reset | Force-stop adapter, return to idle |
| Speed slider | Wall-clock rate (0.1× – 10×) |
| Traffic slider | Vehicle insertion scale (0.1× – 5×) via `simulation.setScale` |
| BLK / OSM | Toggle CartoDB Light basemap |

## Integration with Open Controller

See `docs/INTEGRATION_ROADMAP.md` and `docs/NATS_TRACI_REPLACEMENT_RESEARCH.md`.
OC's control engine is already NATS-native; the adapter publishes on the same
subjects OC expects (`detector.control.*`, `group.status.*`).
