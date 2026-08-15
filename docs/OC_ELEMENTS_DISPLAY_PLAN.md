# Displaying Open Controller control-plane elements in WebSUMO — Initial Plan

*Initial planning doc, 2026-08-14. Not deep-research; grounded in a read-through
of the Open Controller (OC) codebase at `graph2sumo/vendor/open_controller`
(github.com/Open-TLC/open_controller, EUPL-1.2). Companion to the OC transport
work (`SIM_PROTOCOL.md`, `INTEGRATING_WITH_OC.md`) and the strategic direction in
`TODO.md` ("Open Controller interface extensions"). Status: **considered, not yet
scheduled.***

> **Revised 2026-08-15 after OC-side review** (Open-TLC/websumo **issue #1**).
> Three corrections were folded in and **verified against the OC code**: (1) OC's
> native subjects carry **no scenario/instance scoping** (a real collision risk —
> §4); (2) the OC model conf has **no geometry** — the earlier "lanes with
> coordinates" claim was wrong, the geo join comes from `net.xml` (§2.8, §6); and
> (3) the group→TLS-link mapping is **positional runtime logic, not a declarative
> table** (§4, §6). Net effect: the "just load the model file" framing is dropped,
> and the case for **OC owning the join (Option C)** is now the lead
> recommendation, not a fallback.

---

## 0. Implementation status (2026-08-15) — branch `oc-elements-display`

P1 is **built and demoed live** (junction 270, `http://localhost:8775` via
`run_oc_demo.sh`). What exists now, all committed on the branch (not yet merged):

- **`backend/oc_join.py`** — the validated group↔signal-index join (verified
  against the live OC bus + net; `group1 → links [0,1]`).
- **`--opencontroller` backend mode** — `GET /api/oc/join` serves the map; the WS
  relay forwards OC's `group.status.*` / `detector.status.*` as typed frames.
- **P1 frontend overlay** — stoplines coloured live by OC group substate, `G#`
  labels, and a bottom-left panel (per-group live GREEN/red + member links +
  min/max green + a green-count).
- **`run_oc_demo.sh`** — one env-configurable command that stages `oc270` from
  OC's own net, starts the OC-mode backend, and starts **the full OC control
  loop** (simengine **+ control engine / clockwork** — without the brain the
  signals sit red).
- **Coherent-sim mirror (`OC_MIRROR`)** — WebSUMO's own sim mirrors OC's live
  `group.status.<ctrl>.<idx>` onto its TLS each step, so **the shown vehicles obey
  OC's control**. Uses the exact per-index mapping (not the positional
  `group_outputs`), so no fragile re-derivation. Verified 16/16 indices.

**This went beyond the originally-documented P1** (a *read-only monitor*): the
mirror is a first step toward interactive/coherent operation (it resolves open
question 4 in the "show OC controlling real traffic" direction).

### Known limitations of the current demo
- **Actuation source nuance.** OC actuates on *its own* simengine sim's
  detectors; WebSUMO's sim mirrors the resulting signals. So the shown cars obey
  OC's signals, but OC is not yet reacting to *those specific* cars' queues. Full
  coherence = one sim: WebSUMO's adapter publishes `detector.status.*` and OC
  actuates the shown sim (needs the positional `group.control` application OC
  owns — Option C territory). See Next steps.
- **group8 shares group4's stopline** (same approach lane) so it has no separate
  bar — the per-lane-stopline artifact (§6). 14/15 groups get their own bar.
- **No scenario scoping** on OC subjects (§4) — fine for the single-engine demo,
  must be resolved before multi-engine/production.

### Next steps (revised)
1. **Close the actuation loop** (full single sim): adapter publishes
   `detector.status.*` in OC's format → OC actuates the *shown* sim → drop the
   mirror. OC owns the `group.control`→link resolution (Option C), served over
   NATS. This is the honest "watch OC control real traffic" endpoint.
2. **P2 — detectors & indicators**: detector roles (request/extender/e3) and the
   fused `group.e3.*` approach queues on the map (§3 P2).
3. **P3 — phase ring / intergreen panel** and the controller-status HUD (§3 P3).
4. **Per-group stoplines** to fix the group8/shared-lane artifact.
5. **Scenario scoping + Option C** before this is more than a single-junction
   demo (§4).
6. **Visual/UX polish** — folds into the TODO "graphics & UI design revision".
7. **Merge the branch** once P1 + the demo are signed off.

---

## 1. Motivation — the gap

WebSUMO today renders **what SUMO sees**: per-link TLS colours (`GGrrGGrr`), raw
induction-loop occupancy bars, vehicles, lanes. The OC integration we shipped
(`simbridge.py` + `sim.{scenario}.*`) streams exactly that.

It renders **nothing of what *Open Controller* sees** — the control plane:
- **signal groups** (OC groups signals; SUMO only has per-link states),
- **why** a group is green (request? extension? which detector fired?),
- **phase ring** and **intergreen/conflict matrix** (what can run together, and
  the safety delays between groups),
- **indicators** (OC's fused field-of-view: radar + loop counts per approach),
- **detector *roles*** (request vs extender vs e3), not just on/off,
- the **controller state machine** (Green_Extending, Red_WaitIntergreen, …).

Crucially, **OC's own UI does not fill this gap geographically.** OC ships a
Dash/Plotly UI (`services/user_interfaces`, `:8050`) that shows **tables and
status strings** — a groups table, an intergreen table, a message log, an
indicators table (`REQ:01010 EXT:10000 PERM:00000`). It has **no map**. WebSUMO's
network view is therefore genuinely additive: **put OC's control logic on the
geography**, where a signal group is a place, a detector is a spot on a lane, an
indicator is an approach.

> **The one-line pitch:** WebSUMO already draws the intersection; OC already
> knows the control state. Join them and you get the first *geographic* live view
> of Open Controller — something neither tool has today.

---

## 2. What OC exposes (grounded catalog)

OC is a set of services communicating over NATS (flat, per-intersection
subjects). The elements and their live data:

### 2.1 Signal groups — `group.status.<intersection>.<group_id>`
Published by simengine (SUMO TLS state, fed back). Payload:
```json
{ "id": "group.status.270.7", "tstamp": "...", "substate": "g" }
```
- `substate` is a **single char** state code (`r`/`g`/`a`/`b`/… red/green/amber/…).
- The controller's richer view lives in `control_engine` `SignalGroup`
  (`signal_group.py`): hierarchical state machine
  (`Red_MinimumTime`, `Green_Extending`, `Green_RemainGreen`,
  `Red_WaitIntergreen`, …), `_request_green`, `_permit_green`, `min_green`,
  `max_green`, `conflicting_groups` (with intergreen delay), `delaying_groups`.
  *(Not all of this is on the wire yet — see §4.)*

### 2.2 Group control commands — `group.control.<intersection>.<group_id>`
Published by control_engine → simengine. Payload:
```json
{ "id": "group.control.270.1", "tstamp": "...", "substate": "1", "group": 1, "green": true }
```
This is the actuation stream (the controller telling the sim to set a group).

### 2.3 Detectors — `detector.status.<detector_id>`
Published by simengine. Payload:
```json
{ "id": "detector.status.1-001", "tstamp": "...", "loop_on": true }
```
Detector **roles** live in the controller config (`detector.py` /
model `contr/*.json`): `request` (triggers a group's green), `extender`
(pulses that hold green), `e3detector` (area count). Each carries `sumo_id`,
`owngroup_name`, `request_groups`, priority, vtype filter.

### 2.4 Indicators (fused field-of-view) — `group.e3.<intersection>.<group_id>`
Published by the **indicators** service. Payload:
```json
{ "count": 1, "radar_count": 1, "det_vehcount": 1, "group_substate": "r",
  "view_name": "group5_view",
  "objects": { "92": { "speed": 8.85, "sumo_id": "F_Jatk2Sat.30", "vtype": "car_type" } },
  "offsets": { "Group 5 lane 1": 0 }, "tstamp": ... }
```
An **indicator** is OC's abstraction over an approach: it fuses loop detectors +
radar objects into a per-group **queue / approaching-vehicle count**. This is the
"holistic traffic situation" that drives the smart green extender. Config
(`indicators/*.json`) maps each view's `lanes → in_dets/out_dets/object_lists`.

### 2.5 Radars — `radar.<intersection>.<radar_id>.objects_port.json`
Object lists (lat/lon/speed/class/sumo_id) within an area of interest. Feeds
indicators; also directly mappable to the map.

### 2.6 Controller status — `controller.status.<name>` / `clockwork.status.<name>`
Aggregate status line (`REQ:… EXT:… PERM:…`) the OC UI shows as text.

### 2.7 Safety extender — `detector.status.<id>_ext_normal` / `_ext_safety`
Synthetic detector streams representing safe vs safety-constrained extension —
consumed by the control engine as extender inputs.

### 2.8 The static model — `models/<JS>/contr/*.json`
Per-intersection config. Verified `controller` keys (JS270_DEMO.json): `name`,
`sumo_name` (the SUMO TLS id), `group_outputs`, `signal_groups` (timing only —
`min/max green/amber/red`, `request_type`, `green_end`; each group's actuation
channel is `group.control.270.N`), `detectors`
(`type`/`sumo_id`/`channel`/`request_groups`), `group_list`, `phases` (the ring),
`intergreens` (the conflict matrix).

> ⚠️ **Correction (issue #1, verified).** An earlier draft said this file has
> "lanes (with coordinates)". **It does not** — there is no lanes section and
> **no geometry anywhere in an OC model conf**. (The `Lane` *dataclass* in
> `control_engine/src/lane.py` has a `coordinates` field, but the model confs
> don't populate one.) So the model is **not** a geographic join key.
> **The geo join must come from `net.xml`** — exactly as the existing `sim.*`
> interface already does for vehicles/persons via
> `libsumo.simulation.convertGeo`. And the group→link half of the join is not a
> readable field either — see §4/§6: it is OC's positional runtime logic.

**Consolidated subjects to consume:** `group.status.*`, `group.control.*`,
`detector.status.*`, `group.e3.*`, `radar.*`, `controller.status.*` — noting
(§4) that **none of these carry a scenario qualifier**.

---

## 3. What to display — mapped to WebSUMO, phased by value

Each OC element maps onto WebSUMO's existing render/inspector primitives.

| # | OC element | Data source | WebSUMO rendering | Reuses | Effort |
|---|---|---|---|---|---|
| **P1** | **Signal groups on the map** — colour each group's stoplines by OC `substate`, labelled by group id | `group.status.*` + **group→link join** (§4: OC-resolved, or re-derived positionally for a demo) | Extend the existing stopline/TLS-colour layer to group by OC group, show group id badges | stopline layer, TLS colour logic | **M** |
| **P1** | **Group inspector** — click a group: state-machine state, min/max green, request/permit, time-in-state, next-switch | `group.status.*` (+ richer fields if published, §4) | New inspector kind alongside vehicle/TLS | InspectorPanel, cmd.select | **M** |
| **P2** | **Detectors by role** — request vs extender vs e3, live on/off, which group they serve | `detector.status.*` + detector→group map from OC conf (`detectors`.`request_groups`/`group`) | Recolour/shape existing detector bars by role; link line to owning group | detector bars layer | **S–M** |
| **P2** | **Indicators (approach queues)** — per-group count / approaching vehicles as an approach overlay or badge | `group.e3.*` | New overlay: an approach "gauge" near each group; number + colour by count | deck.gl layer + inspector | **M** |
| **P3** | **Phase ring + intergreen** — a panel showing current/next phase and the conflict matrix, with the active group highlighted on the map | model `phases`/`intergreens` + live `group.status.*` | New side panel (matrix/ring widget); hover a cell → highlight the two groups on the map | new panel | **M–L** |
| **P3** | **Radar objects** — OC's radar-detected objects (may differ from SUMO ground truth) | `radar.*` | Scatter layer (like persons); toggle | vehicle/person layer | **S** |
| **P3** | **Controller status HUD** — the `REQ/EXT/PERM` line + which controller is authoritative | `controller.status.*` | Small HUD/status strip | log panel pattern | **S** |
| **P4** | **Extension "why" trace** — visualise that group X is extending because detector Y is pulsing / indicator over threshold | join `group.status`+`detector.status`+`group.e3` | Animated link detector→group while extending | overlay | **L** |

*S ≈ days, M ≈ 1–2 wks, L ≈ weeks.* **P1 alone** (groups on the map + group
inspector) already delivers the headline value: the first geographic live view of
OC control.

---

## 4. Data-source strategy — how OC state reaches WebSUMO

Two hard constraints from the OC review (issue #1) shape this section — both
**verified against the OC code**:

- **No scenario scoping on OC subjects.** OC subjects are built as
  `topic_prefix + "." + id` in `simengine/src/outputs.py` (e.g.
  `messages[self.topic_prefix + "." + group_id]`) — there is **no per-run or
  per-scenario qualifier at all**. This is not hypothetical: the `sumo_name`
  `270_Tyyn_Vali` is reused across **six** controller confs pointing at **three**
  different sumocfgs (`JS270_DEMO`, `FIELD_DEMO_1124`, two `testmodel` variants).
  Two OC engines with overlapping intersection numbering publish **interleaved
  state on the same subjects**, with nothing to detect it. Whatever
  collision-handling we design for `sim.{scenario}.*` needs a **separate,
  stricter answer here**, because these subjects carry no identity to key on.
- **The group→SUMO-link mapping is positional runtime logic, not a table.**
  `PhaseRingController.get_sumo_states()`
  (`control_engine/src/signal_group_controller.py`) builds the RYG string by
  concatenating each output group's state **in `group_outputs` order**, matched
  *positionally* against SUMO's own `getControlledLinks()` order — and
  `group_outputs` **repeats** a group name when it drives more than one link
  (verified: JS270's `group_outputs` starts `["group1","group1","group2",…]`).
  There is no field to read; reconstructing the join externally means
  **replicating OC's positional logic exactly**.

Three options, now re-weighted by those constraints:

**Option A — WebSUMO subscribes to OC's native subjects directly (fastest demo
only).** In `--opencontroller` mode WebSUMO connects to the same NATS and
subscribes `group.status.*`, `detector.status.*`, `group.e3.*`, `group.control.*`,
`controller.status.*`. **Zero OC changes.** But it inherits *both* problems above:
WebSUMO would have to (a) assume a single unambiguous OC engine on the bus (no
scenario key to disambiguate) and (b) **re-derive the positional group→link
mapping** itself from `group_outputs` + `getControlledLinks()`. Acceptable for a
one-intersection demo on a controlled bus; **not** safe as a product.

**Option B — OC publishes an overlay on the scoped interface
(`sim.{scenario}.oc.state`).** The bridge/simengine republishes a *pre-joined*,
scenario-scoped OC snapshot (each group already resolved to its SUMO link
indices, plus indicator counts and phase index) under the existing
`sim.{scenario}.*` namespace. Fixes **both** constraints at once: it inherits the
scenario scope of `sim.{scenario}.*`, and OC — the only party that knows its own
positional logic — resolves the group→link mapping. Costs a screenful of
publisher code on the OC side and a `v:1` schema addition to `SIM_PROTOCOL.md`.

**Option C — hybrid (recommended target).** Live OC state still flows on the
scoped overlay (or, for a lean start, native subjects on a known-single-engine
bus), but the **group→link join is resolved once by OC** and served via
request-reply `sim.{scenario}.oc.model` (same shape as the existing
`.net`/`.detectors`/`.routes` serving). This is the OC team's own suggested
path in issue #1: OC owns the positional resolution; WebSUMO just reads the
resolved map and does the **geo** half from `net.xml` (`convertGeo`), exactly as
it already does for vehicles/persons.

**Recommendation (revised):** prototype the **P1 demo** with **A** on a single,
known intersection with one OC engine on the bus — accepting that WebSUMO
re-derives the positional mapping for that one case. For anything beyond the demo,
**go to C**: OC owns the group→link join (it's OC's logic) and the scenario
scope, WebSUMO owns the geography. Do **not** ship Option A as a product — the
no-scoping collision risk and the externally-re-derived positional mapping are
both foot-guns. This is the concrete content of the currently-vague
"detector/group control forwarding" bullet in `TODO.md`, and it supersedes the
old `NATS_TOPOLOGY_RESEARCH.md` leaf-node bridging sketch (that doc's `deny`
rules were about *not* leaking `sim.*`; here we deliberately bridge the OC
control-plane subjects the other way).

---

## 5. UI approach — expand WebSUMO vs a separate app

**Recommendation: expand the current WebSUMO UI, gated behind a startup flag /
mode — `websumo --opencontroller` (or `?oc=1` / a mode toggle).** Not a separate
app.

Why expand, not fork:
- **Same geography, same render stack.** OC elements *are* SUMO network features
  wearing control-plane meaning (a group = a set of TLS links; a detector = a
  spot on a lane; an indicator = an approach). They belong on the map we already
  draw. A separate app would re-implement the network render, the NATS relay, the
  inspector — all of which exist.
- **OC's own UI is the tabular view; ours is the map view.** We shouldn't rebuild
  OC's Dash tables — we should be the thing OC's UI *isn't*.
- **The flag keeps standalone WebSUMO clean.** Without `--opencontroller`,
  nothing changes: no OC subjects subscribed, no OC panels, the sumo-gui-style
  viewer is unaffected. With it, WebSUMO additionally connects to the OC
  subjects and light up the OC layers/panels. This mirrors how the V2X overlays
  are already optional toggles.

Concretely the flag would: (1) subscribe to the OC subject set, (2) obtain the
group→link join (§4: OC-served map, or re-derived positionally for a demo) and
do the geo half from `net.xml`, (3) enable the OC render layers (group colouring,
detector roles, indicator gauges) and the OC panels (group inspector,
phase/intergreen).
Everything is **read-only** first; interactive control (publishing
`group.control.*` to force a group — like OC's UI "Control Messages" buttons)
is a later, clearly-gated step.

---

## 6. Alignment with the rest of WebSUMO — how hard, what it touches

**Overall: moderate, and it rides existing seams — this is not a rewrite.** The
architecture already assumes "many subscribers on NATS, one authoritative
engine," so adding an OC consumer is in-grain.

What it touches, and the difficulty:

- **`backend/main.py` NATS relay** — add the OC subject subscriptions (behind the
  flag) and fold OC state into the WebSocket frames (or a parallel `oc` frame).
  *Low–medium.* Same pattern as the existing `sim.*` relay.
- **`backend/network.py`** — the **geo** side of the join: it already extracts
  TLS links, stoplines and lane geometry from `net.xml`, and geo-converts (the
  same `convertGeo`/`sumolib` path used for the existing interface). What it must
  *add* is grouping those links by OC group id — using the **group→link map that
  OC resolves** (§4 Option C), **not** an OC model file (which has no geometry and
  no readable link map). *Medium.* Note: graph2sumo also carries signal-group data
  (`map_extraction*.ttl`); whether the authoritative join comes from OC at runtime
  or from graph2sumo at build time is [open question 1](#8-open-questions) — but
  it does **not** come from the OC model conf.
- **Frontend `MapView` / layers** — new deck.gl layers (group colouring, detector
  roles, indicator gauges, radar scatter). *Medium*, additive; the layer model is
  already data-driven.
- **`InspectorPanel`** — a new "group" inspect kind next to vehicle/TLS. *Low*,
  the panel is already multi-kind.
- **New phase-ring / intergreen panel** — genuinely new UI. *Medium*.
- **`SIM_PROTOCOL.md`** — only if we take Option B/C: add a versioned `oc.*`
  schema. *Low.*

Risks / landmines:
1. **The group→link join is the crux — and it's OC's positional logic, not a
   table** (issue #1, verified). The RYG string is `group_outputs`-order
   concatenation matched against `getControlledLinks()`, with `group_outputs`
   repeating a group per extra link. Re-deriving it externally must replicate that
   exactly. *Mitigation:* have **OC resolve and serve** the map (§4 Option C);
   only re-derive it for a single-intersection demo, validated visually on 270.
2. **No scenario scoping on OC subjects** (issue #1, verified). `topic_prefix+id`
   with no run qualifier, and intersection numbers reused across confs/sumocfgs —
   two engines can interleave on one subject undetected. *Mitigation:* the scoped
   overlay (§4 Option B/C) inherits `sim.{scenario}.*` identity; for a demo,
   guarantee a single OC engine on the bus.
3. **Substate vocabulary.** OC's single-char substates (`r/g/a/b/B/F/…`) and the
   controller's rich state-machine states are two different granularities; decide
   which we show (wire has substates; rich states need §4 Option B/C to be
   published).
4. **Multi-intersection.** OC runs several controllers (266-267 coordinated); OC
   subjects are per-intersection. WebSUMO is single-scenario today — coordinated
   junctions may need multi-controller display. *Defer past P1.*
5. **Two UIs, one story.** Keep clear that OC's Dash UI owns config/tables and
   WebSUMO owns the geographic live view — avoid re-implementing OC's editable
   tables.
6. **Licensing.** OC is **EUPL-1.2**; WebSUMO is Apache-2.0. Consuming OC over
   NATS (no code linking) is fine; if we ever vendor OC parsing code, check
   EUPL↔Apache compatibility.

---

## 7. Suggested first slice (a demo, not a product)

1. **Build the group→link join** for one intersection (270). The geo half comes
   from `net.xml` (`getControlledLinks()` + `convertGeo`); the group→link half is
   **re-derived from OC's positional logic** (`group_outputs` order vs
   `getControlledLinks()`, honouring repeats) for this one case — see §4. Validate
   visually. *(This is a throwaway demo derivation; the product path is OC serving
   the resolved map.)*
2. **`--opencontroller` flag** subscribes `group.status.270.*` and
   `detector.status.*` on a bus with a **single** OC engine (no scenario key yet);
   relay to the browser (Option A).
3. **P1 render**: colour stoplines by OC group + group-id badges; **group
   inspector** (state, request/permit, timers) on click.
4. **P2 add**: detector role colouring + indicator (`group.e3.270.*`) count badges
   per approach.
5. Demo against the running OC stack (266/270). If it lands, move to **Option C**:
   OC serves the resolved group→link map via `sim.{scenario}.oc.model`
   request-reply and publishes scenario-scoped OC state; freeze an `oc` schema in
   `SIM_PROTOCOL.md`. This also resolves the no-scoping and positional-logic
   landmines for good.

---

## 8. Open questions

1. **Join source** (the OC conf is ruled out — no geometry, no readable link map).
   Two live candidates: **(a)** OC resolves and serves the group→link map at
   runtime via `sim.{scenario}.oc.model` (§4 Option C — OC owns its positional
   logic, issue #1's recommendation); **(b)** graph2sumo emits a group↔TLS-link
   map at build time (it already owns the signal-group RDF in
   `map_extraction*.ttl`) — but this must be validated to match OC's *runtime*
   `group_outputs` ordering, since that's what actually drives the links. (Leaning
   **a** for correctness — OC is the authority on its own link ordering; **b** is
   attractive only if it can be proven equivalent.)
2. **Scenario scoping** (issue #1): what identifier disambiguates two OC engines
   with overlapping intersection numbers on one bus? The scoped overlay (Option
   B/C) inherits `sim.{scenario}.*` identity — is that the answer, or does OC need
   a scenario/instance qualifier on its native subjects too?
3. **How rich a group state** do we show — wire substates only, or does OC publish
   the controller state machine (`Green_Extending`, `Red_WaitIntergreen`) too?
   Requires an OC-side publish decision (Option B/C).
4. **Read-only monitor vs interactive** — *partly answered (§0)*: we added the
   `OC_MIRROR` coherent-sim step (WebSUMO's sim obeys OC's live signals), which is
   beyond a pure viewer. Still open: do we let WebSUMO *publish* `group.control.*`
   (force a group), and do we close the actuation loop so OC drives the shown sim?
5. **Multi-controller scenes** (266-267 coordinated) — in scope, or single
   intersection only for v1?
6. **Relationship to the sumo-gui drop-in direction** — the `--opencontroller`
   mode and the standalone `websumo <sumocfg>` drop-in are two front doors on the
   same engine; keep the OC layers strictly optional so the drop-in stays generic.

---

## References (OC codebase, read 2026-08-14)

- OC overview + subject table: `vendor/open_controller/README.md`
- Signal group state machine: `services/control_engine/src/signal_group.py`
- Phase ring / intergreens: `services/control_engine/src/signal_group_controller.py`
- Detectors / extenders: `services/control_engine/src/{detector,extender}.py`
- Indicators (fused FoV): `services/indicators/src/fusion2.py`,
  `services/indicators/doc/inputs_outputs.md`
- Simengine (SUMO↔NATS): `services/simengine/src/{simengine,outputs}.py`
- OC's existing Dash UI: `services/user_interfaces/src/clockwork_ui.py`
- Model (join key): `models/JS270_DEMO/contr/JS270_DEMO.json`
- WebSUMO side: `backend/network.py`, `backend/main.py`, `frontend/src/MapView.tsx`,
  `docs/SIM_PROTOCOL.md`
