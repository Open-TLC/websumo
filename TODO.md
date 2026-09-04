# WebSUMO — TODO

Planned features, each with completed feasibility research. Ordered by
priority; effort estimates from the linked research docs.

## 1. Open Controller integration

WebSUMO exposes a stable NATS interface — the `sim.{scenario}.*` subjects,
frozen (versioned `v: 1`) in `docs/SIM_PROTOCOL.md`. Integration is implemented
on the **OC side**, against that interface: OC's simengine publishes
`sim.{scenario}.state`, consumes `sim.{scenario}.cmd.*`, and serves the static
files on `sim.{scenario}.net/detectors/routes` (vendor `backend/simbridge.py`,
~15 lines in its step loop — see `docs/INTEGRATING_WITH_OC.md`, hand-off summary
in `docs/OC_INTEGRATION_HANDOFF.md`). WebSUMO stays a pure NATS subscriber;
`sumo_adapter.py` here is the standalone (no-OC) simengine.

The WebSUMO side is complete and tested **disk-less**: it discovers scenarios
from live state, fetches the network + detector/route overlays over NATS on Load,
and attaches to an externally-owned sim on Start (no local `SCENARIOS_DIR`
needed). Remaining work is OC-side.

**Next chapter (planned, not scheduled): display OC control-plane elements.**
Today WebSUMO shows what SUMO sees (per-link TLS, raw detector occupancy), not
what OC sees — signal groups, phase ring/intergreens, indicators (fused
field-of-view), detector roles, controller state. Initial plan in
`docs/OC_ELEMENTS_DISPLAY_PLAN.md`: a `--opencontroller` mode that overlays OC's
NATS state on the network view (the first *geographic* live view of OC, which
OC's own tabular Dash UI lacks). This is the concrete content of the old
"detector/group control forwarding" idea below.

Other approaches — the adapter republishing OC's `detector.control.*` /
`group.control.*` subjects, or a drop-in `nats_traci` transport — were
considered but are not planned at this stage.

**Docs:** `docs/SIM_PROTOCOL.md`, `docs/INTEGRATING_WITH_OC.md`,
`docs/OC_INTEGRATION_HANDOFF.md`, `docs/OC_ELEMENTS_DISPLAY_PLAN.md`

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

## Strategic directions (not yet planned in detail)

Two possible future trajectories for the project, worth thinking through before
committing to either:

- **sumo-gui replacement**: WebSUMO as a general-purpose, community-shareable
  alternative to `sumo-gui` — i.e. `websumo <sumocfg>` as a drop-in CLI
  replacement that any SUMO user could install and use. Distinct from the
  current focus (our own intersection toolchain). Would require broader
  compatibility testing, packaging, and community positioning.
  Feasibility studied in detail: `docs/SUMO_GUI_DROPIN_FEASIBILITY.md`
  (viewer drop-in = feasible small delta; full parity = large web-build;
  netedit = narrow MVP only). See also `docs/SUMO_GUI_COMMUNITY_RESEARCH.md`
  for what the SUMO community actually wants from a GUI replacement.

- **Open Controller interface extensions**: the current OC integration
  (NATS sim.* subjects, `simbridge.py`) is complete and in use. Possible
  expansions: detector/group control forwarding, a `nats_traci` drop-in
  transport, or multi-scenario orchestration. Not planned — depends on OC
  roadmap.

- **Graphics & UI design revision**: the current UI is functional but not
  visually polished. Worth a dedicated design pass covering colour scheme,
  layer styling (lanes, crossings, cyclelanes, detectors), panel layout,
  and mobile/embed-friendliness before any wider sharing.

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
- **Basemap tiles — productionize** (currently ad-hoc): the demo uses Stadia
  `alidade_smooth` raster (switched after CARTO began watermarking keyless
  tiles). Stadia's free tier is **non-commercial** and forbids server-side
  caching, so the current setup is a demo config, not shippable. Recommended
  path: self-host **vector PMTiles** (Planetiler → `.pmtiles` → Cloudflare
  R2/CDN → MapLibre `pmtiles://` + open grayscale style), with Finnish CC-BY
  government basemaps (NLS/MML, City of Helsinki) as an authoritative Helsinki
  layer; avoid Mapbox/Google (renderer + anti-caching + "non-Google map")
  and never hotlink `tile.openstreetmap.org`. Immediate must-do: compliant
  OSM attribution (`AttributionControl({compact:true})`, linked "© OpenStreetMap
  contributors"). Full options/legal/next-steps in
  `docs/BASEMAP_TILES_STRATEGY.md`.
