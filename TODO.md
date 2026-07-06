# WebSUMO — TODO

Planned features, each with completed feasibility research. Ordered by
priority; effort estimates from the linked research docs.

## 1. Generator nodes — click-to-inject vehicles

Clickable markers at approach entries; clicking injects a single vehicle of
the selected type (car/truck/tram). Verified feasible via `libsumo.vehicle.add()`
with `departLane='free'` (default `'base'` silently queues under load).

- network.py: `generator` Point features at entry edges listing accepted `vtypes` (~25 lines)
- sumo_adapter.py: `sim.{scenario}.cmd.spawn` subject, route cache, unique `manual_{n}` IDs (~30 lines)
- MapView.tsx: pickable markers, click → publish spawn (~40 lines)
- Controls.tsx: vType selector (~20 lines)

Naming contract settled (fix list #12): spawn payload uses `vtype` (a typeID),
generator features list accepted `vtypes`, state stream keeps `vclass` — see the
"Naming contract" section in the research doc. Do not conflate the three.

**Effort:** ~1 day · **Research:** `docs/GENERATOR_NODES_RESEARCH.md`

## 2. Open Controller integration

Make the adapter a drop-in replacement for OC's `simengine_integrated.py`.
Detector occupancy is already read every step — only the republish and the
command path are missing.

- Republish detectors on `detector.control.{det_id}` in OC's format:
  `{"id", "loop_on", "tstamp"}` (~10 lines)
- Subscribe to OC's signal commands (`group.control.*`), apply via
  `trafficlight.setRedYellowGreenState` before next step
- **First: confirm subject names + payloads against OC's real
  `simengine_integrated.py` / `clockwork.py`** — `group.control` vs
  `group.status` is unverified, and OC's subjects are flat (not
  `sim.{scenario}.*`-scoped), so one broker = one scenario. Decide whether to
  adopt OC's flat namespace or bridge to scenario-scoped subjects.
- Validate detector IDs in `oc_controller.json` against `{scenario}.detectors.xml`
  at startup; log mismatches
- End-to-end test: OC control engine driving signals on fi.helsinki.269,
  visible in the viewer

**Research:** `docs/NATS_TRACI_REPLACEMENT_RESEARCH.md`, `docs/INTEGRATION_ROADMAP.md`

## 3. Element inspector — extend beyond vehicles + TLS

v1 (vehicles + traffic lights) is done — see Done below. Remaining scope:

- **Lanes and detectors** as inspectable kinds (static attrs are researched;
  lanes need an invisible wide hit-area layer for clicking)
- **Runtime edits** from the panel: lane speed, TLS phase durations
  (`setProgramLogic` verified working) — marked "this run only"; then
  file-backed persistence for TLS programs/flows/detectors
- **Demand display** (flows per approach, from .rou.xml) — goes into the
  generator-node markers when those exist (item 1)
- **Multi-user selection**: `cmd.select` is a single global slot per adapter;
  concurrent clients overwrite each other and all see the same inspect block.
  Must be addressed before any multi-user deployment — per-client selections
  keyed by the (already sent) `client` field, or request-reply inspection.

**Research:** `docs/ELEMENT_INSPECTION_RESEARCH.md`

---

## Done

- **Element inspector v1** (2026-07-03) — click a vehicle or traffic light:
  right-side panel (mutually exclusive with LOG), static section from
  network GeoJSON (TLS program tables embedded at Load), live section via
  `sim.{scenario}.cmd.select` → `inspect` block in state messages + one-shot
  on selection. TLS view: program table, current phase, next-switch
  countdown. m/s units, no emissions (decisions 2026-07-03). Known
  single-selection limitation documented in README + above.
- **Simulation log viewer** (2026-07-03) — structured events on sparse
  `sim.{scenario}.log`, LOG button + unread badge + overlay, startup warnings
  via `GET /api/adapter/log/{scenario}`; Load runs a one-step SUMO check so
  warnings show before Start. Verified: structured events match SUMO stderr
  warnings 1:1 (70/70 teleports on a 269 run; timestamps offset by exactly
  one step). See `docs/SIMULATION_LOG_RESEARCH.md`.

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
