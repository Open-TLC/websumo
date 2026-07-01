# SUMO Web Viewer — Implementation Plan

**Status**: Design / pre-implementation  
**Date**: July 2026  
**Predecessor documents**:
- [`SUMO_WEB_VISUALIZATION_RESEARCH.md`](./SUMO_WEB_VISUALIZATION_RESEARCH.md) — first-pass research on existing tools and communication protocols
- Deep-dive research session (July 2026, not separately persisted) — evaluated sumo-web3d, SimWrapper, CesiumJS/CZML, SUMO GitHub issue history, and licensing

---

## 1. Purpose and Scope

### What this is

An MVP web-based viewer that runs a SUMO traffic simulation headlessly and streams vehicle positions in real time to a browser. The browser renders the road network and moving vehicles on an interactive map, with basic playback controls (start, stop, pause, resume, speed).

The primary use case is: a developer or traffic engineer points the viewer at a `.sumocfg` file already produced by graph2sumo, and watches the simulation run in a browser without needing X11, sumo-gui, or a GUI-capable desktop.

### What this is NOT

- Not a replacement for sumo-gui for detailed inspection or debugging
- Not a network editor
- Not a statistics or analysis dashboard
- Not a port or fork of SimWrapper (though we use the same frontend stack)
- Not a multi-tenant cloud platform
- Not a 3D simulation (vehicles are 2D icons on a map at MVP)

### Prior art status

- **sumo-web3d** (Sidewalk Labs): archived 2023, last committed 2018. Architecture is the right shape (TraCI → WebSocket → WebGL) but TraCI API has drifted since 2018 — it is reference material, not reusable code.
- **SimWrapper** (TU Berlin VSP): actively developed (2,394+ commits as of 2026), GPL-3.0, Vue.js + deck.gl + MapLibre GL JS + Three.js, MATSim-focused. No live SUMO simulation support. Stack is directly relevant.
- **SUMO itself**: no web viewer and no plans for one (GitHub issue #15279 closed; issue #6673 open/backlog, 6+ years).

---

## 2. Repo Structure Decision

### Recommendation: separate repository

The web viewer should live in a new repository, provisionally named **`sumo-viewer`** (or `sumo-live-viewer`, `intersection-viewer`).

### Rationale

| Dimension | graph2sumo | web viewer |
|---|---|---|
| **Kind of program** | CLI batch pipeline | Persistent network service |
| **Run pattern** | Invoked once per intersection build | Runs continuously while user is viewing |
| **Python dependencies** | rdflib, pyproj, lxml, shapely | FastAPI, uvicorn, websockets, traci |
| **Frontend** | None | TypeScript/JavaScript, npm ecosystem (deck.gl, MapLibre GL JS) |
| **Deployment** | Developer workstation, CI, Docker build step | Docker container with open port, potentially Kubernetes |
| **Release cadence** | Changes when intersection model logic changes | Changes when UI features change |
| **Test surface** | Graph transformation correctness | WebSocket protocol, network geometry parsing, frontend rendering |

Mixing these in one repo means: anyone who clones to work on the graph pipeline pulls an npm project; anyone deploying the viewer must understand the RDF pipeline; Pipfile and package.json cohabit; CI must distinguish which jobs apply. The coupling between them is loose by design — the viewer consumes graph2sumo's file outputs.

graph2sumo already has a `vendor/` submodule pattern (open_controller) and its own docs/ discipline, so it is not a monorepo by nature.

### How the two repos interact

The web viewer does not depend on graph2sumo as a Python library. It consumes graph2sumo's **file outputs**: `.net.xml`, `.rou.xml`, and `.sumocfg`. The viewer is pointed at a scenario directory at startup:

```
graph2sumo (build step) → build/{intersection_id}/*.{net,rou,sumocfg} → sumo-viewer (runtime)
```

In practice:
- A developer runs `./build_and_extract.sh` to generate scenario files.
- They then start the viewer and pass it the path to the scenario directory (via env var, config file, or CLI flag).
- The viewer reads `.net.xml` at startup for geometry, then launches `sumo` as a subprocess.

There is no subprocess or import dependency in either direction. This is the right boundary: graph2sumo is a compiler; the viewer is a runtime.

---

## 3. Architecture Overview

```
┌───────────────────────────────────────────────────────────┐
│                      Browser                              │
│                                                           │
│  MapLibre GL JS (base map / road network tiles)           │
│  deck.gl ScatterplotLayer (vehicle positions)             │
│  Control panel (play/pause/speed/step counter)            │
│                                                           │
│  Native WebSocket connection                              │
│  REST GET /network → GeoJSON (one-shot at load)           │
└─────────────────────┬─────────────────────────────────────┘
                      │  WebSocket (ws://)
                      │  server-push: vehicle positions each step
                      │  client-push: play/pause/speed commands
                      │
┌─────────────────────┴─────────────────────────────────────┐
│              FastAPI server (Python, asyncio)              │
│                                                           │
│  POST /session/start → spawns SUMO, connects TraCI        │
│  GET  /network       → parses .net.xml via sumolib,       │
│                        returns GeoJSON FeatureCollection  │
│  WS   /session/{id} → per-session WebSocket handler       │
│                                                           │
│  Session manager: tracks {session_id → SimSession}        │
│  SimSession: asyncio task wrapping TraCI step loop        │
│  TraCI bridge: traci.start() + step loop in executor      │
└─────────────────────┬─────────────────────────────────────┘
                      │  TraCI (TCP, localhost)
                      │  traci.simulationStep()
                      │  traci.vehicle.getIDList()
                      │  traci.vehicle.getPosition()
┌─────────────────────┴─────────────────────────────────────┐
│         sumo (headless subprocess, no X11)                │
│                                                           │
│  sumo -c scenario.sumocfg --remote-port <PORT>            │
│  --no-step-log --quit-on-end                              │
└───────────────────────────────────────────────────────────┘
```

### Data flow summary

1. Browser loads, calls `GET /network` once. Server reads `.net.xml` with sumolib, returns GeoJSON of edges (polylines) and junctions. Cached; not repeated.
2. Browser calls `POST /session/start` with path to `.sumocfg`. Server assigns a session ID, spawns a SUMO subprocess on a free port, connects TraCI.
3. Browser opens `WS /session/{id}`. Server begins the step loop: each simulation step, it calls `traci.vehicle.getPositionList()` (bulk subscription), serialises positions as a compact JSON array, and pushes to the WebSocket.
4. Browser receives position array, updates a deck.gl `ScatterplotLayer` data prop. deck.gl re-renders on next animation frame — no full DOM update.
5. User sends `{"cmd": "pause"}` / `{"cmd": "resume"}` / `{"cmd": "speed", "value": 2.0}` over the same WebSocket. Server adjusts step timing or blocks the loop.
6. When simulation ends or user closes the tab, server calls `traci.close()`, kills the SUMO subprocess, cleans up session state.

---

## 4. TU Berlin / SimWrapper Alignment

### Why deck.gl + MapLibre

SimWrapper (TU Berlin VSP) uses deck.gl + MapLibre GL JS + Three.js. This is also the correct choice independently:

- **deck.gl** (MIT): GPU-instanced rendering, `ScatterplotLayer` handles hundreds of thousands of moving points at 60fps via WebGL2. Updates are data-driven (replace the `data` array prop), not imperative. Handles the vehicle animation loop cleanly.
- **MapLibre GL JS** (BSD-3-Clause): open-source fork of Mapbox GL JS, actively maintained, vector-tile base maps, can render `.net.xml` geometry as a custom layer or as GeoJSON. Used by SimWrapper, Protomaps, and many geospatial tools.

The alternative considered (three.js as in sumo-web3d) requires building a full camera, projection, and coordinate system from scratch for the geo-referenced use case. deck.gl + MapLibre handles all of that and is the better choice for 2D geospatial simulation.

### What "combining later" means in practice

If collaboration with TU Berlin VSP becomes relevant, the integration path is:

1. **Write a SimWrapper data provider** — SimWrapper's architecture separates data providers from visualization plugins. A live-SUMO provider would implement SimWrapper's plugin interface, connecting to our FastAPI backend's WebSocket instead of reading static files.
2. **Contribute the frontend layer as a SimWrapper plugin** — SimWrapper is GPL-3.0; contributing to it would require GPL-3.0 licensing for contributed code. This is acceptable for internal or open-source use.
3. **The FastAPI backend is reusable regardless** — it is MIT-licensable and SimWrapper-independent.

The MVP does not target SimWrapper compatibility; it leaves the door open by using the same rendering stack. Divergences that are acceptable: different frontend framework (React vs Vue), different state management, no YAML dashboard config system.

### SimWrapper plugin architecture note

SimWrapper is a Vue SPA where visualizations are implemented as plugins that declare which file patterns they handle. A future SUMO live-sim plugin would declare itself as handling `*.sumocfg` (or a custom `sumo-live.yaml` config), establish a WebSocket to the FastAPI backend, and feed position updates into a deck.gl layer already present in the SimWrapper layer system. The frontend work done in this MVP translates directly to that plugin's rendering code.

---

## 5. MVP Scope

### In scope

- Load and display SUMO road network from `.net.xml`: edges as polylines, junctions as points/polygons, projected to WGS84 for MapLibre display
- Start simulation from a `.sumocfg` file
- Real-time vehicle positions streamed per simulation step, rendered as dots (ScatterplotLayer)
- Pause, resume, stop controls
- Simulation speed control (adjusting inter-step delay on the server side)
- Step counter / simulation time display
- Single-session, single-user (one SUMO process per server instance)

### Explicitly out of scope for MVP

- Traffic light state visualisation
- Pedestrian and bicycle rendering
- Vehicle type differentiation (car vs bus vs tram)
- Multiple simultaneous sessions / multi-user
- Statistics or chart panels
- Scenario file browser / selector UI
- Network editing
- 3D rendering or extruded buildings
- Detector data display
- Replay from `.fcd.xml` output (offline playback mode)
- Authentication

---

## 6. Component Breakdown

### 6.1 FastAPI backend

**What it does**: HTTP and WebSocket server; manages SUMO subprocess lifecycle; drives TraCI step loop; serves network geometry as GeoJSON.

**Technology**: Python 3.12+, FastAPI, uvicorn (ASGI), traci (PyPI), sumolib (bundled with SUMO installation).

**Estimated effort**: 4–6 days.

**Key risks**:
- TraCI's Python bindings are synchronous and blocking. The step loop must run in a `ThreadPoolExecutor` (via `asyncio.run_in_executor`) to avoid blocking the FastAPI event loop. This is the central architectural constraint.
- Port allocation for multiple SUMO processes (even single-session MVP needs clean port management on restart).
- SUMO subprocess cleanup on unclean disconnect — need to register signal handlers and WebSocket disconnect callbacks.

**Dependencies**: `fastapi`, `uvicorn[standard]`, `traci`, `sumolib` (via `SUMO_HOME` or system install).

### 6.2 Network geometry service

**What it does**: Reads `.net.xml` once at startup (or on first request), extracts lane polylines and junction shapes, converts from SUMO's internal coordinate system to WGS84, returns as GeoJSON `FeatureCollection`.

**Technology**: sumolib (`sumolib.net.readNet()`), pyproj (already in graph2sumo's Pipfile — coordinate projection).

**Estimated effort**: 1–2 days.

**Key risks**:
- SUMO net files use a local XY coordinate system with an offset stored in the file. sumolib handles this transparently via `net.convertXY2LonLat()`. Must verify projection matches base map tiles.
- Large networks (multi-intersection): GeoJSON payload can be several MB. Compress with gzip (FastAPI supports this natively) and cache the result; only computed once per session.

### 6.3 TraCI step loop and WebSocket bridge

**What it does**: Runs the SUMO simulation step by step, collects vehicle positions after each step, serialises them, and pushes to the connected WebSocket client. Accepts control commands (pause/resume/speed/stop) from the client.

**Technology**: Python asyncio, `asyncio.Queue` for command ingestion, `concurrent.futures.ThreadPoolExecutor` for TraCI calls, FastAPI WebSocket.

**Estimated effort**: 3–4 days.

**Key risks**:
- TraCI subscriptions (`traci.vehicle.subscribeContext` or per-vehicle `subscribe`) are faster than polling `getIDList()` + `getPosition()` in a loop. Use `traci.vehicle.getAllSubscriptionResults()` after subscribing to `tc.VAR_POSITION` for all vehicles — this is a single TCP round-trip per step.
- Step timing: target 10–25 simulation steps per second for smooth human-visible playback. A configurable `step_delay` (default 50ms) on the server gives speed control without needing TraCI's `--step-length` changes.
- Delta encoding (only sending changed positions) is a worthwhile optimisation but is NOT required for MVP at small-intersection scale. Add if bandwidth or rendering becomes the bottleneck.

**Message format** (initial, uncompressed JSON):
```
server → client: {"t": 1234.5, "vehicles": [[id, lon, lat], ...]}
client → server: {"cmd": "pause"} | {"cmd": "resume"} | {"cmd": "speed", "v": 2.0} | {"cmd": "stop"}
```

### 6.4 Frontend — network layer

**What it does**: On load, fetches GeoJSON from `GET /network`, renders road edges as a MapLibre `GeoJSONSource` + `line` layer and junctions as a `circle` layer. Static; does not update after load.

**Technology**: MapLibre GL JS (BSD-3-Clause), TypeScript.

**Estimated effort**: 2–3 days.

**Key risks**:
- Coordinate system: if sumolib projection is correct, GeoJSON is already WGS84 and MapLibre renders it correctly. Verify against OSM tile background.
- Styling: lane-level polylines may overlap visually. Render at edge (road) level for MVP; lane-level detail is a later enhancement.

### 6.5 Frontend — vehicle layer

**What it does**: Receives vehicle position messages over WebSocket, updates a deck.gl `ScatterplotLayer` data array, relies on deck.gl's reactive update to re-render on each animation frame.

**Technology**: deck.gl (MIT) `ScatterplotLayer`, MapLibre GL JS as base map, native browser WebSocket.

**Estimated effort**: 2–3 days.

**Key risks**:
- deck.gl must be integrated with MapLibre in "interleaved" or "overlaid" mode. The official `@deck.gl/maplibre` module handles this. Use overlaid mode for simplicity at MVP.
- Ensure the vehicle position update rate (server-push, ~10–25 Hz) does not cause excessive React re-renders. Keep vehicle data in a `useRef` and update the deck.gl layer directly rather than through component state.

### 6.6 Frontend — control panel

**What it does**: Play/pause/stop buttons, speed slider, simulation time display, connection status indicator.

**Technology**: React (or plain TypeScript if keeping dependencies minimal), no UI component library required at MVP scale.

**Estimated effort**: 1–2 days.

**Key risks**: Low. This is straightforward UI.

### 6.7 Session lifecycle and process management

**What it does**: On `POST /session/start`, find a free TCP port, spawn `sumo` as a subprocess with `--remote-port`, wait for TraCI to become available, return session ID. On disconnect or `{"cmd": "stop"}`, terminate subprocess and free port.

**Technology**: Python `subprocess.Popen`, `asyncio.subprocess`, `asyncio.Event` for lifecycle signals.

**Estimated effort**: 1 day.

**Key risks**:
- SUMO takes ~0.5–2 seconds to start and begin listening. Need a retry/poll loop on `traci.init()` with a timeout.
- Zombie processes if server crashes. Use `atexit` and signal handlers to clean up child processes.

### Total estimated effort

| Component | Days |
|---|---|
| FastAPI backend skeleton + session management | 2 |
| TraCI step loop + WebSocket bridge | 3–4 |
| Network geometry service (sumolib → GeoJSON) | 1–2 |
| Frontend — network layer (MapLibre) | 2–3 |
| Frontend — vehicle layer (deck.gl) | 2–3 |
| Frontend — control panel | 1–2 |
| Integration, Docker, basic docs | 2 |
| **Total** | **13–18 days** |

This is a 3–4 week effort for one developer. The two highest-risk items are the TraCI-asyncio integration and the coordinate projection for the network layer; both are well-understood patterns with reference implementations to draw from.

---

## 7. Key Technical Decisions

### TraCI vs libsumo

**Decision: TraCI.**

libsumo embeds the SUMO simulation engine directly into the Python process via C++ bindings. It eliminates TCP socket overhead (measured at 1–10ms per round-trip) but restricts to a single client process and complicates multiprocessing: libsumo is not safe to use with Python's `multiprocessing` fork model, and it cannot be loaded more than once per process.

For a web viewer running at human-visible rates (10–25 steps/second), a 5ms TraCI round-trip is negligible. The architectural flexibility of TraCI (separate process, clean crash isolation, future multi-session support) outweighs the performance difference. The SUMO team itself recommends TraCI for web/distributed use cases.

### Python async framework

**Decision: FastAPI with uvicorn.**

FastAPI provides:
- Native `async def` WebSocket endpoints without an additional library
- Automatic OpenAPI docs for the REST endpoints (useful during development)
- Pydantic request validation with no boilerplate
- `run_in_executor` for running blocking TraCI calls off the event loop

Flask with Flask-SocketIO was the pattern used in older SUMO web tutorials but it requires eventlet/gevent monkey-patching or a threading model that does not compose well with asyncio. FastAPI is the correct choice for a new project in 2026.

**Key constraint**: TraCI's Python client is synchronous (blocking socket calls). The step loop MUST be run via `loop.run_in_executor(thread_pool, traci_step_fn)` — never called directly from a coroutine. Failure to do this will freeze the entire FastAPI event loop.

### Frontend framework

**Decision: React + TypeScript + Vite.**

React is well-understood, has a large ecosystem, and deck.gl's official examples use React hooks (`useRef` for layer updates). Vue.js (SimWrapper's choice) would be equally viable technically but adds unfamiliarity for most developers.

Vite replaces webpack/Create React App — faster HMR, simpler config, good TypeScript support out of the box.

If keeping dependencies minimal is a priority, the frontend can be written as vanilla TypeScript with Vite (no React) — the vehicle layer update path with deck.gl's imperative API is actually simpler without React. This is worth considering for MVP.

### Vehicle state streaming

**Decision: full position list per step, no delta encoding at MVP.**

For small-intersection scale (tens to low hundreds of vehicles), a JSON array of `[id, lon, lat]` triples per step is tens of kilobytes at most — well within WebSocket bandwidth. Delta encoding (only sending vehicles that moved) is a meaningful optimisation at 1,000+ vehicle scale and should be added if needed.

Use TraCI subscriptions rather than per-vehicle polling: subscribe to `traci.constants.VAR_POSITION` for all vehicles, then call `traci.vehicle.getAllSubscriptionResults()` once per step. This is a single TCP exchange regardless of vehicle count.

Positions should be converted from SUMO's XY to WGS84 lon/lat on the server before sending, using the same projection derived from the `.net.xml` offset. This keeps the frontend coordinate-system-agnostic.

### Session isolation

**Decision: one SUMO process per server instance at MVP.**

MVP does not support multiple concurrent sessions. A second `POST /session/start` while one is running should return 409 Conflict. This simplifies port management, resource limits, and the TraCI connection lifecycle.

Multi-session support (allocating a port range, managing a session map keyed by UUID) is architecturally straightforward to add later — the `SimSession` abstraction already encapsulates it.

---

## 8. Future Path to SimWrapper

### What a SimWrapper SUMO live-sim provider would look like

SimWrapper is a Vue SPA where each visualization type is a plugin. A plugin declares:
1. A set of file patterns it can handle (e.g., `*.sumocfg`, `sumo-live.yaml`)
2. A Vue component that renders the visualization

A SUMO live-sim plugin for SimWrapper would:
1. Detect a `sumo-live.yaml` config file (which specifies the path to a `.sumocfg` and the URL of the FastAPI backend)
2. Open a WebSocket to the FastAPI backend's `/session/{id}` endpoint
3. Feed incoming position messages into a deck.gl `ScatterplotLayer` already present in the SimWrapper rendering context
4. Expose play/pause/speed controls via SimWrapper's dashboard panel system

The FastAPI backend developed in this MVP is fully reusable for that integration — no changes needed. The rendering code (MapLibre + deck.gl) is directly portable from this MVP's frontend into a SimWrapper plugin component, with adaptations to Vue's reactivity model.

### Translation of MVP work to SimWrapper plugin

| MVP component | Maps to SimWrapper |
|---|---|
| FastAPI backend + TraCI bridge | Reused as-is (independent service) |
| GeoJSON network endpoint | Reused as-is |
| deck.gl ScatterplotLayer update logic | Portable to Vue component (same JS API) |
| MapLibre base map integration | Already present in SimWrapper |
| Control panel | Reimplemented as SimWrapper dashboard widget |

### Licensing note for SimWrapper contribution

SimWrapper is GPL-3.0. Contributing code to SimWrapper requires that contributed code also be GPL-3.0. The FastAPI backend remains MIT (or Apache-2.0) — it is a separate service. Only the Vue plugin component contributed to SimWrapper would be GPL-3.0. This is acceptable for open-source use; verify with any commercial licensing constraints before contributing.

---

## 9. Licensing Summary

| Component | License | Notes |
|---|---|---|
| SUMO (sumo binary, sumolib, traci) | EPL-2.0 | Building a web app over TraCI is explicitly exempted from copyleft per SUMO's NOTICE.md. The web app code is not a "derivative work" under EPL-2.0. |
| deck.gl | MIT | No restrictions. |
| MapLibre GL JS | BSD-3-Clause | No restrictions. |
| FastAPI | MIT | No restrictions. |
| uvicorn | BSD-3-Clause | No restrictions. |
| React | MIT | No restrictions. |
| SimWrapper | GPL-3.0 | Only triggered if code is contributed TO SimWrapper. Using the same tech stack does not trigger GPL-3.0. Running SimWrapper alongside this viewer does not trigger GPL-3.0. |

**Summary**: The MVP web viewer can be MIT or Apache-2.0 licensed with no conflicts. GPL-3.0 only enters the picture if code is upstreamed into the SimWrapper repository itself.

---

## References

- [SimWrapper source code](https://github.com/simwrapper/simwrapper) — Vue + deck.gl + MapLibre reference
- [deck.gl documentation — Using with MapLibre](https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre)
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/)
- [FastAPI WebSocket documentation](https://fastapi.tiangolo.com/advanced/websockets/)
- [SUMO TraCI documentation](https://sumo.dlr.de/docs/TraCI.html)
- [SUMO Libsumo documentation](https://sumo.dlr.de/docs/Libsumo.html) — see for comparison, not for use here
- [sumo-web3d (archived)](https://github.com/sidewalklabs/sumo-web3d) — architecture reference only; code is stale
- [SUMO GitHub issue #6673](https://github.com/eclipse-sumo/sumo/issues/6673) — web viewer feature request (open/backlog)
- [SUMO Docker documentation](https://sumo.dlr.de/docs/Developer/Docker.html)
- [FastAPI WebSocket patterns for live dashboards](https://medium.com/@connect.hashblock/10-fastapi-websocket-patterns-for-live-dashboards-3e36f3080510)
