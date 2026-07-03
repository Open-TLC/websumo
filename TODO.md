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

## 3. Element inspector — click any element, see its properties

Pickable vehicles/lanes/junctions/detectors; right-side inspector panel with a
static section (sumolib attributes, works after Load) and a live section
(streamed per step for the selected element via `sim.{scenario}.cmd.select` →
`inspect` block in state messages, ~0.13 ms/inspect verified). TLS view shows
the program table with current phase + next-switch countdown. No editing in
v1; runtime edits (lane speed, TLS durations — verified working via libsumo
setters) are the natural follow-up, then file-backed persistence for TLS
programs/flows/detectors.

**Effort:** ~1–1.5 days · **Research:** `docs/ELEMENT_INSPECTION_RESEARCH.md`

---

## Done

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
