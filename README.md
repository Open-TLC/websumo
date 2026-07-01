# WebSUMO

Web-based viewer for SUMO traffic simulations. Streams vehicle positions from a headless SUMO process to a browser via WebSocket. No X11 required.

**Stack:** FastAPI + TraCI (backend) · deck.gl + MapLibre GL JS (frontend)

## Quick start

### Backend

```bash
cd backend
pip install -r requirements.txt
SCENARIOS_DIR=/tmp/shared/sumotest uvicorn main:app --reload
```

The server starts on http://localhost:8000.

`SCENARIOS_DIR` should point to a directory containing `.sumocfg` and `.net.xml` files
(as produced by graph2sumo's `build_and_extract.sh`).

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Opens on http://localhost:5173. API calls are proxied to the backend.

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
            ↕ TraCI (TCP, localhost)
         sumo -c scenario.sumocfg --remote-port N
```

See `docs/SUMO_WEB_VIEWER_IMPLEMENTATION_PLAN.md` for design rationale.
