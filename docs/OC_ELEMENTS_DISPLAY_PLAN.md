# Displaying Open Controller control-plane elements in WebSUMO — Initial Plan

*Initial planning doc, 2026-08-14. Not deep-research; grounded in a read-through
of the Open Controller (OC) codebase at `graph2sumo/vendor/open_controller`
(github.com/Open-TLC/open_controller, EUPL-1.2). Companion to the OC transport
work (`SIM_PROTOCOL.md`, `INTEGRATING_WITH_OC.md`) and the strategic direction in
`TODO.md` ("Open Controller interface extensions"). Status: **considered, not yet
scheduled.***

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
Per-intersection config: `signal_groups` (with `channel: group.control.270.1`),
`detectors`, `extenders`, `lanes` (with **coordinates**!), `phases` (the ring),
`intergreens` (the conflict matrix), and `sumo_name` (the SUMO TLS id). **This is
the join key**: it maps OC group N ↔ SUMO TLS `sumo_name` ↔ link indices.

**Consolidated subjects to consume:** `group.status.*`, `group.control.*`,
`detector.status.*`, `group.e3.*`, `radar.*`, `controller.status.*`.

---

## 3. What to display — mapped to WebSUMO, phased by value

Each OC element maps onto WebSUMO's existing render/inspector primitives.

| # | OC element | Data source | WebSUMO rendering | Reuses | Effort |
|---|---|---|---|---|---|
| **P1** | **Signal groups on the map** — colour each group's stoplines by OC `substate`, labelled by group id | `group.status.*` + model group→TLS-link map | Extend the existing stopline/TLS-colour layer to group by OC group, show group id badges | stopline layer, TLS colour logic | **M** |
| **P1** | **Group inspector** — click a group: state-machine state, min/max green, request/permit, time-in-state, next-switch | `group.status.*` (+ richer fields if published, §4) | New inspector kind alongside vehicle/TLS | InspectorPanel, cmd.select | **M** |
| **P2** | **Detectors by role** — request vs extender vs e3, live on/off, which group they serve | `detector.status.*` + model detector map | Recolour/shape existing detector bars by role; link line to owning group | detector bars layer | **S–M** |
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

Three options; they trade "clean WebSUMO interface" against "OC-side work".

**Option A — WebSUMO subscribes to OC's native subjects directly (recommended
for a monitor).** In `--opencontroller` mode WebSUMO connects to the same NATS and
subscribes `group.status.*`, `detector.status.*`, `group.e3.*`, `group.control.*`,
`controller.status.*`. It loads the OC model `contr/*.json` (or a derived mapping)
to join group↔TLS↔lane. **Zero OC changes.** WebSUMO is a pure read-only monitor,
exactly what it already is for `sim.*`. Downside: WebSUMO must understand OC's
flat subject scheme and per-intersection numbering, and needs the model file for
the geographic join.

**Option B — OC publishes an overlay on the scoped interface
(`sim.{scenario}.oc.state`).** The bridge/simengine republishes a *pre-joined*,
WebSUMO-shaped OC snapshot (groups with geometry-ready ids, indicator counts,
phase index) under the existing `sim.{scenario}.*` namespace. Keeps WebSUMO's
clean contract; keeps WebSUMO dumb about OC internals. Costs ~a screenful of
publisher code on the OC/bridge side and a `v:1` schema addition to
`SIM_PROTOCOL.md`. This is the same shape as our existing net/detectors/routes
request-reply.

**Option C — hybrid.** WebSUMO consumes native OC subjects (A) for the live
stream but fetches the **static join map** once via a request-reply
(`sim.{scenario}.oc.model`) so it doesn't need the model file on disk. Best
disk-less story; small OC-side addition.

**Recommendation:** prototype with **A** (nothing to change in OC, fastest path to
a demo), then, if it graduates from monitor to product, move the join/scoping to
**C** so WebSUMO keeps its clean, disk-less, scoped interface and OC stays the
authority. Either way this is the concrete content of the currently-vague
"detector/group control forwarding" bullet in `TODO.md` — and it supersedes the
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

Concretely the flag would: (1) subscribe to the OC subject set, (2) load/fetch
the OC join map, (3) enable the OC render layers (group colouring, detector
roles, indicator gauges) and the OC panels (group inspector, phase/intergreen).
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
- **`backend/network.py`** — needs the **group↔TLS-link↔lane join**. Today it
  already extracts TLS links and stoplines; it must additionally group them by OC
  group id from the OC model. *Medium* — this is the real new logic. graph2sumo
  already carries signal-group data (`map_extraction*.ttl`), so the mapping exists
  upstream; the question is threading it through (model file vs a request-reply).
- **Frontend `MapView` / layers** — new deck.gl layers (group colouring, detector
  roles, indicator gauges, radar scatter). *Medium*, additive; the layer model is
  already data-driven.
- **`InspectorPanel`** — a new "group" inspect kind next to vehicle/TLS. *Low*,
  the panel is already multi-kind.
- **New phase-ring / intergreen panel** — genuinely new UI. *Medium*.
- **`SIM_PROTOCOL.md`** — only if we take Option B/C: add a versioned `oc.*`
  schema. *Low.*

Risks / landmines:
1. **The join map is the crux.** OC group numbering ↔ SUMO `sumo_name` ↔ TLS link
   indices ↔ lanes must be exact or the map lies. Needs the OC model (or a
   graph2sumo-emitted mapping). *Mitigation:* build the join once, validate
   against a known intersection (269/270) visually.
2. **Substate vocabulary.** OC's single-char substates (`r/g/a/b/B/F/…`) and the
   controller's rich state-machine states are two different granularities; decide
   which we show (wire has substates; rich states need §4 Option B/C to be
   published).
3. **Multi-intersection.** OC runs several controllers (266-267 coordinated); OC
   subjects are per-intersection. WebSUMO is single-scenario today — coordinated
   junctions may need multi-controller display. *Defer past P1.*
4. **Two UIs, one story.** Keep clear that OC's Dash UI owns config/tables and
   WebSUMO owns the geographic live view — avoid re-implementing OC's editable
   tables.
5. **Licensing.** OC is **EUPL-1.2**; WebSUMO is Apache-2.0. Consuming OC over
   NATS (no code linking) is fine; if we ever vendor OC parsing code, check
   EUPL↔Apache compatibility.

---

## 7. Suggested first slice (a demo, not a product)

1. **Build the join** for one intersection (270): OC model `contr/JS270_DEMO.json`
   → `{group_id → [TLS link indices], → lanes, → detectors}`. Validate visually.
2. **`--opencontroller` flag** subscribes `group.status.270.*` and
   `detector.status.*`; relay to the browser (Option A).
3. **P1 render**: colour stoplines by OC group + group-id badges; **group
   inspector** (state, request/permit, timers) on click.
4. **P2 add**: detector role colouring + indicator (`group.e3.270.*`) count badges
   per approach.
5. Demo against the running OC stack (266/270). If it lands, promote the join to a
   `sim.{scenario}.oc.model` request-reply (Option C) and freeze an `oc` schema in
   `SIM_PROTOCOL.md`.

---

## 8. Open questions

1. **Join source**: ship WebSUMO the OC `contr/*.json`, or have graph2sumo emit a
   group↔TLS↔lane map (it already has the signal-group RDF), or add a
   `sim.{scenario}.oc.model` request-reply? (Leaning: graph2sumo-emitted map — it
   already owns the signal-group data via `map_extraction*.ttl`.)
2. **How rich a group state** do we show — wire substates only, or does OC publish
   the controller state machine (`Green_Extending`, `Red_WaitIntergreen`) too?
   Requires an OC-side publish decision (Option B/C).
3. **Read-only monitor vs interactive** — do we ever let WebSUMO publish
   `group.control.*` (force a group), duplicating OC UI's control buttons, or stay
   strictly a viewer?
4. **Multi-controller scenes** (266-267 coordinated) — in scope, or single
   intersection only for v1?
5. **Relationship to the sumo-gui drop-in direction** — the `--opencontroller`
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
