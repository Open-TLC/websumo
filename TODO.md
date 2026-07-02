# WebSUMO — TODO

Planned features, each with completed feasibility research. Ordered by
priority; effort estimates from the linked research docs.

## 1. Generator nodes — click-to-inject vehicles

Clickable markers at approach entries; clicking injects a single vehicle of
the selected type (car/truck/tram). Verified feasible via `libsumo.vehicle.add()`
with `departLane='free'` (default `'base'` silently queues under load).

- network.py: `generator` Point features at entry edges with allowed vclasses (~25 lines)
- sumo_adapter.py: `sim.{scenario}.cmd.spawn` subject, route cache, unique `manual_{n}` IDs (~30 lines)
- MapView.tsx: pickable markers, click → publish spawn (~40 lines)
- Controls.tsx: vehicle type selector (~20 lines)

**Effort:** ~1 day · **Research:** `docs/GENERATOR_NODES_RESEARCH.md`

## 2. Open Controller integration

Make the adapter a drop-in replacement for OC's `simengine_integrated.py`.
Detector occupancy is already read every step — only the republish and the
command path are missing.

- Republish detectors on `detector.control.{det_id}` in OC's format:
  `{"id", "loop_on", "tstamp"}` (~10 lines)
- Subscribe to OC's signal commands (`group.control.*`), apply via
  `trafficlight.setRedYellowGreenState` before next step
- Validate detector IDs in `oc_controller.json` against `{scenario}.detectors.xml`
  at startup; log mismatches
- End-to-end test: OC control engine driving signals on fi.helsinki.269,
  visible in the viewer

**Research:** `docs/NATS_TRACI_REPLACEMENT_RESEARCH.md`, `docs/INTEGRATION_ROADMAP.md`

## 3. Simulation log viewer — LOG button + event stream

Structured events (collisions, teleports, emergency stops) published on a
sparse `sim.{scenario}.log` subject; LOG button with unread badge opens a
dismissible overlay. Startup warnings served from the adapter's stderr log
(live — `--log FILE` is buffered until close and unusable).

- sumo_adapter.py: per-step event collection, publish only when non-empty (~25 lines)
- main.py: relay `sim.{scenario}.log` + `GET /api/adapter/log/{scenario}` tail endpoint (~20 lines)
- Frontend: LOG button + badge + overlay (~60 lines)

**Effort:** ~half a day · **Research:** `docs/SIMULATION_LOG_RESEARCH.md`

---

## Longer-term (researched, not yet scheduled)

- **Web network editor** (netedit replacement): TLS phase editing first
  (no netconvert needed), then lane properties, then structural edits via
  netconvert round-trip. Terra Draw for geometry editing.
  See `docs/NETEDIT_WEB_RESEARCH.md`, `docs/NETEDIT_EDITING_ARCHITECTURE.md`
- **nats_traci client library**: drop-in `import nats_traci as traci` for OC,
  routing TraCI calls over NATS request-reply.
  See `docs/NATS_TRACI_REPLACEMENT_RESEARCH.md` §3
- **Day-long demand profiles**: diurnal flow rates (morning/evening peaks)
  belong in graph2sumo demand generation; viewer already supports 24 h runs
  with constant rates
