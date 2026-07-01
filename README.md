# WebSUMO

Web-based viewer for SUMO traffic simulations. Streams vehicle positions from a headless SUMO process to a browser via WebSocket. No X11 required.

**Stack:** FastAPI + TraCI (backend) · deck.gl + MapLibre GL JS (frontend)

## Quick start (production — single server)

```bash
# 1. Install Python dependencies (includes WebSocket support)
cd backend
pip install -r requirements.txt

# 2. Build the frontend
cd ../frontend
npm install
npm run build

# 3. Serve everything from one port
cd ../backend
SCENARIOS_DIR=/tmp/shared/sumotest uvicorn main:app --host 0.0.0.0 --port 8775
```

Open **http://localhost:8775** in your browser.

`SCENARIOS_DIR` should point to a directory containing `.sumocfg` and `.net.xml` files
(as produced by graph2sumo's `build_and_extract.sh`).

> **Note:** `uvicorn[standard]` must be installed (not bare `uvicorn`) — it pulls in the
> `websockets` library that handles WebSocket upgrades. Without it, the browser's WS
> connection is silently rejected and vehicles will not appear.

## Development (hot reload)

Run the backend and the Vite dev server separately:

```bash
# Terminal 1 — backend on :8000
cd backend
SCENARIOS_DIR=/tmp/shared/sumotest uvicorn main:app --reload

# Terminal 2 — frontend dev server on :5173 (proxies /api and /ws to :8000)
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**.

## Usage

1. Select a scenario from the dropdown
2. Click **Load** to render the road network on the map
3. Click **▶ Start** to launch the simulation
4. Use **⏸ Pause** / **▶ Resume** / **■ Stop** to control playback
5. Drag the speed slider to adjust simulation rate

## Architecture

```
Browser (deck.gl + MapLibre)
  ├── GET /api/scenarios        → list .sumocfg files
  ├── GET /api/network/{name}   → GeoJSON road network
  ├── POST /api/session/start   → spawn SUMO subprocess, return session_id
  └── WS /ws/{session_id}       → stream vehicle positions per step
            ↕ TraCI (TCP, localhost, port chosen by traci.start())
         sumo -c scenario.sumocfg
```

In production mode the backend also serves the built frontend from `frontend/dist/`
via FastAPI's `StaticFiles` mount, so a single uvicorn process handles everything.

See `docs/SUMO_WEB_VIEWER_IMPLEMENTATION_PLAN.md` for design rationale.
