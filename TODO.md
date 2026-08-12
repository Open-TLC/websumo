# WebSUMO — TODO

Planned features, each with completed feasibility research. Ordered by
priority; effort estimates from the linked research docs.

## 1. Open Controller integration (Option 3 — OC owns the sim)

Integrated mode: OC's `simengine_integrated.py` becomes the simulation master
and adopts WebSUMO's `sim.{scenario}.*` protocol via `backend/simbridge.py`
(publishes `sim.{scenario}.state`, drains `sim.{scenario}.cmd.*`). WebSUMO is
then a **pure NATS subscriber** in integrated mode — no TraCI ownership, no
`--num-clients` barrier. The adapter (`sumo_adapter.py`) stays as WebSUMO's
*standalone* (no-OC) simengine only.

> **Do NOT** build the adapter as a drop-in for OC's simengine — i.e. the
> adapter republishing `detector.control.*` and applying `group.control.*` via
> `setRedYellowGreenState`. That is **Option 2**, which was dropped in favour of
> Option 3 (the bridge). Rebuilding it re-creates the mistake the handoff docs
> exist to prevent.

The deliverable is mostly on the OC side, and is hand-off ready:

- OC vendors `backend/simbridge.py` and adds ~15 lines to its step loop
  (publish state after `simulationStep()`, drain commands) —
  see `docs/INTEGRATING_WITH_OC.md`.
- The `sim.{scenario}.*` contract is frozen in `docs/SIM_PROTOCOL.md`
  (versioned `v: 1`); hand-off summary in `docs/OC_INTEGRATION_HANDOFF.md`.
- **Open question** (`docs/INTEGRATION_ROADMAP.md`): whether OC can run
  control-engine-only (self-clocked adapter + fire-and-forget signal writes),
  or needs strict per-step lockstep (roadmap Option C). Confirm before wiring.
- End-to-end test: OC control engine driving signals on fi.helsinki.269,
  visible in the viewer, both attached to the same NATS broker.

**Docs:** `docs/SIM_PROTOCOL.md`, `docs/INTEGRATING_WITH_OC.md`,
`docs/OC_INTEGRATION_HANDOFF.md`, `docs/INTEGRATION_ROADMAP.md`

## 2. Element inspector — extend beyond vehicles + TLS

v1 (vehicles + traffic lights) is done — see Done below. Remaining scope:

- **Lanes and detectors** as inspectable kinds (static attrs are researched;
  lanes need an invisible wide hit-area layer for clicking)
- **Runtime edits** from the panel: lane speed, TLS phase durations
  (`setProgramLogic` verified working) — marked "this run only"; then
  file-backed persistence for TLS programs/flows/detectors
- **Multi-user selection**: `cmd.select` is a single global slot per adapter;
  concurrent clients overwrite each other and all see the same inspect block.
  Must be addressed before any multi-user deployment — per-client selections
  keyed by the (already sent) `client` field, or request-reply inspection.

**Research:** `docs/ELEMENT_INSPECTION_RESEARCH.md`

## 3. Generator enhancements (base feature shipped — see Done)

- **Destination choice**: click a generator then an exit to pick the route
  (`cmd.spawn` already accepts an optional `dest`; adapter route-matching +
  a two-click UI flow remain)
- **Demand display**: show the flows feeding an approach (from `.rou.xml`) in a
  generator marker's tooltip/panel — the deferred element-inspector "demand"
  idea, now that generator markers exist
- **Spawn feedback**: surface queued/failed injections in the UI (adapter
  already emits `spawn-failed` on the log subject)

---

## Done

- **Generator nodes** (2026-07-03) — green markers at entry edges that start a
  route (network.py filters by `.rou.xml` route origins + lane vClass masks,
  listing accepted `vtypes`); click a marker to inject one vehicle of the
  selected vType via `sim.{scenario}.cmd.spawn` (`vehicle.add` with
  `departLane/Pos='free'`, `manual_N` ids). Controls has an Inject vType
  selector; failures surface on the log subject as `spawn-failed`. Verified:
  truck/tram/car inject correctly on 269, route-less entries get no marker.
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
  See `docs/NATS_TRACI_REPLACEMENT_RESEARCH.md` §3.
  *(Superseded by the `simbridge.py` approach in item 1 — kept only as a
  researched alternative, not a planned build.)*
- **Day-long demand profiles**: diurnal flow rates (morning/evening peaks)
  belong in graph2sumo demand generation; viewer already supports 24 h runs
  with constant rates
