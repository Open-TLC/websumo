# Bicycle Operations in SUMO — Deep Research (Verified)

**Date:** 2026-08-11
**Status:** Independent, source-verified research pass.
**Relationship to prior docs:** This supersedes the unsourced claims in
`docs/BICYCLE_TRAFFIC_RESEARCH.md` (2026-08-11, single-agent) and corrects two
blocking errors in graph2sumo's `docs/plan_bicycle_lanes.md` /
`docs/research_osm_bike_lanes.md` (2026-04-27). All three now carry a correction
banner pointing here, so the set is mutually consistent. Every external claim here was
verified by fetching the live SUMO documentation, the eclipse-sumo GitHub issue
tracker, or the cited paper's landing page. Claims that could not be verified are
marked ⚠️. Codebase claims cite real `file:line` references.

---

## Executive summary

**SUMO has no dedicated bicycle physics.** A bicycle is an ordinary *vehicle*
with `vClass="bicycle"`, driven by the standard routing, car-following, and
lane-change engines. The official docs state it outright: *"Currently, no
exclusive movement model for bicycles is implemented. Existing models need to be
re-purposed."* This one fact drives every consequence below — bikes behave like
small, slow cars, **not** like pedestrians. They are inserted as
`<vehicle>`/`<flow>`, route over edges/connections, and **cannot** use
walkingareas or `<crossing>` elements (which are pedestrian-only). A "bike lane"
is simply a lane whose permissions are `allow="bicycle"`.

For our pipeline, the good news is that **bikes map almost verbatim onto the
existing tram-lane extraction path** (a separate vehicle class with its own
approach/egress edges, allow-mask, and signalised connections). The bad news,
uncovered by grounding the plan against the actual data, is that **the cycleway
geometry is not currently loaded by the pipeline at all**, and the semantic
predicates the plan assumed (`oct:onApproach`, `oct:laneDirection`,
`oct:hasStopLine`, `oct:vehicleType`) **do not exist** on the `OsmCycleway`
objects — a *different*, real vocabulary does. The headline feature (a
signal-correct bike crossing sharing the pedestrian green) is achievable
**downstream with no upstream graph work**, because the flags it needs
(`oct:cyclewayCrossing`, `oct:segregated`, `oct:cyclistMinimumGreen`) are already
present. Full approach/egress cycle lanes want a small upstream vocabulary
addition, or a lower-fidelity downstream heuristic fallback.

Critical-path estimate: **Phase 0 loader fix (½ day) → Phase 1 bike crossing
(1–2 days, no upstream) → Phase 2 cycle lanes (1–2 days, wants upstream).**

---

## 1. How SUMO handles bicycles (verified against sumo.dlr.de)

### 1.1 The `bicycle` vehicle class and default vType parameters

Setting `vClass="bicycle"` applies bicycle defaults and sets
`guiShape="bicycle"`. Verified defaults from the *Vehicle Type Parameter
Defaults* page (comparison with pedestrian and car for context):

| Parameter | **bicycle** | pedestrian | passenger (car) |
|---|---|---|---|
| `accel` | 1.2 m/s² | 1.5 m/s² | 2.6 m/s² |
| `decel` | 3 m/s² | 2 m/s² | 4.5 m/s² |
| `emergencyDecel` | 7 m/s² | 5 m/s² | 9 m/s² |
| `length` | 1.6 m | 0.215 m | 5 m |
| `width` | 0.65 m | 0.478 m | 1.8 m |
| `minGap` | 0.5 m | 0.25 m | 2.5 m |
| `maxSpeed` | 50 km/h | 37.58 km/h | 200 km/h |
| `desiredMaxSpeed` | **20 km/h (5.56 m/s)** | 5 km/h | n/a |
| `mass` | 10 kg | 70 kg | 1500 kg |
| `guiShape` | bicycle | pedestrian | passenger |

**Critical nuance:** for bicycles the operative speed is **`desiredMaxSpeed`
(20 km/h ≈ 5.56 m/s)**, *not* `maxSpeed` (50 km/h). `maxSpeed` is deliberately
set to a high physical ceiling; realistic riding speed comes from
`desiredMaxSpeed` combined with `speedFactor`/`speedDev` for per-rider variation.
This corrects a common mistake of setting `maxSpeed="5.56"` — the earlier draft
`vType` did exactly that; it works but conflates the two knobs. Use
`desiredMaxSpeed` for realism, or keep it simple and set `maxSpeed` low for a
first cut.

### 1.2 How bikes differ from **pedestrians** (different subsystems entirely)

| Aspect | Pedestrian | Bicycle |
|---|---|---|
| Top element | `<person>` with `<walk>` stages | `<vehicle>` / `<flow>` / `<trip>` |
| Movement model | dedicated pedestrian model — `striping` (default), `nonInteracting`, `jupedsim` | re-purposed car-following (Krauss default; **IDM recommended**) + lane-change/sublane |
| Infrastructure | sidewalks, **walkingareas**, **crossings** | ordinary **edges/lanes** with `allow="bicycle"` |
| Routing | pedestrian router | standard vehicular router |

Concrete consequences: bikes obey car-following headways, change lanes, are never
`<person>`/`<walk>`, and **cannot travel on walkingareas or crossings** — a bike
needs a lane whose permissions include `bicycle`. (SUMO *can* model a bike as a
"fast pedestrian," but the docs explicitly warn that movement model is **not
validated** for bikes — a documented workaround, not idiomatic.)

### 1.3 How bikes differ from **cars** (same engine, bike-specific mechanisms)

- **Sublane model** (`--lateral-resolution <m>`) is the key realism tool: it
  enables bikes riding side-by-side and cars overtaking a bike *within one lane*.
  Docs' worked example: three bikes on a 3.6 m lane needs `--lateral-resolution`
  ≤ 1.2 m. Without it there is **no in-lane overtaking**, so one bike blocks a
  whole car lane on single-lane roads.
- **Bike lane = a lane permitting only `bicycle`.** Create via explicit
  `allow="bicycle"`, the edge attribute `bikeLaneWidth`, netedit (*add restricted
  lane → Bikelane*), or netconvert guessing.
- **Junction model has NO bicycle adaptations** — bikes negotiate junctions with
  the same right-of-way engine as cars, which produces *unrealistically large
  safety gaps* at big priority intersections (a documented limitation). One
  bike-specific junction feature exists: **indirect (two-stage / "Copenhagen")
  left turns** via connection attribute `indirect="true"` (+ `linkIndex2` for the
  second stage), since SUMO 1.10.0.

**Verified netconvert options (correcting the prior draft):**

| Option | Meaning | Default |
|---|---|---|
| `--default.bikelane-width` | width of added bike lanes | **1** m |
| `--bikelanes.guess` | guess bike lanes by edge speed | false |
| `--bikelanes.guess.max-speed` | add where speed ≤ | 22.22 m/s |
| `--bikelanes.guess.from-permissions` | add where a lane already allows bicycle | false |
| `--osm.bike-access` | import OSM bike lanes / fix directions (since v1.17.0) | false |

⚠️ **`--bike-lane-width` (as written in earlier notes and the original request)
does not exist** — the real option is **`--default.bikelane-width`**. (We write
net.xml directly and don't run netconvert, so this matters only if we ever use
the OSM-import path as a cross-check.)

### 1.4 Bicycles at intersections and traffic lights

- **Crossings are pedestrian-only — confirmed from PlainXML docs.** The
  `<crossing>` element has **no `vClass`/`allow` attribute** (only
  `node`/`edges`/`priority`/`width`/`shape`/`linkIndex`/`linkIndex2`/`discard`),
  and *"Pedestrians may only cross the street at a crossing."* **SUMO has no
  dedicated bicycle-crossing concept.** A bike does not use a pedestrian
  crossing.
- **A bike gets through a junction as a vehicle**, over a normal `<connection>`
  and its internal lane, provided the through-edge allows `bicycle`.
- **Signalisation:** a bike movement is signalised exactly like a car's — the
  controlling `<connection>` carries `tl` + `linkIndex` into the TLS phase
  string. There is no separate bicycle-signal primitive; give the bike
  connection its own `linkIndex`, **or reuse the pedestrian crossing's index** so
  bikes go green with the pedestrian phase (our chosen approach — see §3).

### 1.5 Infrastructure representation options (tradeoffs)

| Option | How | When |
|---|---|---|
| (a) Mixed traffic | add `bicycle` to a car lane's `allow` | calm/low-speed streets; needs sublane or bikes block cars |
| (b) Dedicated bike lane on the road edge | extra lane `allow="bicycle"` (via `bikeLaneWidth`) | idiomatic for an **on-carriageway** lane; shares junction geometry |
| (c) Separate bike-path edge | standalone bicycle-only edge | **independent / kerb-separated cycle track** with its own geometry ← *our Helsinki case* |
| (d) `laneType`-based | typed lanes carrying bike permissions | bulk assignment across many edges |

⚠️ SUMO has **no named "protected cycle track" element**; separation is expressed
purely through lane permissions + geometry. For Helsinki's physically separate,
`segregated=true` cycle tracks, **option (c) — a separate bicycle-only edge — is
correct**, which is exactly what the tram-lane pattern already gives us.

### 1.6 Known limitations (from the official Bicycles page)

- No bi-directional movement on a bike lane (one-way lanes only).
- No shared bike/pedestrian space by default (workaround: sublane + a lane
  allowing both).
- No vehicle overtaking on single-lane roads (workaround: sublane).
- *"The intersection model has no special adaptations for bicycles → unrealistic
  (large) safety gaps when bicycles approach a large priority intersection."*
- Overarching: no exclusive bike movement model; **IDM recommended over Krauss**
  for smoother bike acceleration.

**Verified open/relevant GitHub issues** (eclipse-sumo/sumo): **#7685** (open —
temporary adjacent-lane access for bike/ped overtaking); **#16643** (right-turning
car stops inside a bike crossing); **#16414** (2025 — car keeps yielding to a bike
even with foe-ignore = 1, illustrating the junction-model limitation); **#16576**
(car+bike+pedestrian pass simultaneously and collide); **#13101** (closed —
sublane bike-to-road merge collision warning); **#16805** (closed, fixed 1.24.0 —
KraussPS capped cyclist speed downhill). *Note: the prior doc's citation of
"#16643" and "Roosta et al. 2023" turned out to be **real** — both are verified
here.*

---

## 2. Existing projects and literature (verified, with confidence flags)

**The root problem everyone reports:** because bikes reuse car/pedestrian models,
default cyclists "behave either like slow cars or fast pedestrians," which casts
doubt on bike-traffic results. The concrete calibration failures (from the SimRa
analysis, arXiv 2305.01763): default accel 1.2 m/s² is reached by only ~15% of
real maneuvers; default decel −3 m/s² by *none*; default speed 5.56 m/s is
*exceeded* by 77% of real rides; and fixed scalar params make simulated cyclists
unrealistically uniform.

### 2.1 Most citable verified literature

- **SimRa lineage (best for calibration):**
  - Karakaya et al. 2022, *"A Realistic Cyclist Model for SUMO Based on the SimRa
    Dataset"*, IEEE MedComNet — arXiv 2205.04538.
  - Karakaya et al. 2023, *"Achieving Realistic Cyclist Behavior in SUMO using the
    SimRa Dataset"*, Elsevier *Computer Communications* 205:97–107 — arXiv
    2305.01763. (Contains the quantitative critique above.)
  - Ostendorf et al. 2025, *"Enhancing Car-Following Models with Bike Dynamics"*,
    IEEE MOST — arXiv 2507.00062. Introduces the **Realistic Bicycle Dynamics
    Model (RBDM)**, "the first dedicated bicycle model for SUMO." Code:
    github.com/boschresearch/RealisticBicycleDynamicsModel.
- **SUMO Conference 2023 (best for state-of-the-art):**
  - Roosta et al. 2023, *"The State of Bicycle Modeling in SUMO"*, TIB SCP Vol. 4
    — the DLR position paper prioritising future bike-model work.
  - Kaths & Roosta 2023, *"A Framework for Simulating Cyclists in SUMO"*, TIB SCP
    Vol. 4 — a 2D social-force cyclist model (`CyclistModel` Python package).
- **Infrastructure modeling:** Grigoropoulos et al. 2019, *"Modelling Bicycle
  Infrastructure in SUMO"*, EPiC Vol. 62:187–198, DOI 10.29007/6cs5 — five
  categories of bicycle intersection approaches (cycle lanes, advanced stop lines,
  bike boxes, …).
- **Non-lane-based flow:** Brunner et al. 2024, *Simulation Modelling Practice and
  Theory* 135:102986, DOI 10.1016/j.simpat.2024.102986.

### 2.2 Open-source tools (repo pages fetched)

| Repo | What | Maintenance |
|---|---|---|
| boschresearch/RealisticBicycleDynamicsModel | calibrated bike dynamics (RBDM paper) | recent, small |
| HeatherAnne85/CyclistModel | 2D social-force cyclist via TraCI | 2023 |
| lcodeca/SUMOActivityGen (SAGA) | activity-based multimodal demand from OSM (bikes among modes) | **best-maintained** |
| TUM-VT/sumo_ingolstadt | full multimodal Ingolstadt scenario **incl. bicycles** | maintained |
| simra-project/SimRaXSUMO | Berlin left-turn reproduction | research artifact |

Native SUMO OSM-cycleway import lives in eclipse-sumo/sumo via `--osm.bike-access`
+ typemap `osmNetconvertBicycle.typ.xml`.

### 2.3 Which public city scenarios actually model bikes

- **MoST (Monaco)** — **yes** (README: "Bike: 3455" rides).
- **Bologna large-scale (Acosta et al., IJGI 2021)** — **yes** (car/bus/**bicycle**/
  scooter/pedestrian). The smaller `Bologna_small` distribution is motor+bus only.
- **InTAS (Ingolstadt), LuST (Luxembourg), TAPASCologne (as shipped)** — **no**
  bikes. (The separate TUM-VT `sumo_ingolstadt` repo *does* include them.)

**Takeaway for us:** there is **no existing OSM→SUMO bike *network extraction*
pipeline** that does what we do (graph-driven, direct net.xml, signal-linked).
Our approach is novel; the literature is about *behavioral calibration* (which we
can adopt later via a better `vType` or the RBDM), not about *network building*
(which we already solve via the tram pattern).

---

## 3. How our graph data maps to a SUMO bike model (grounded in the real data)

> This section **corrects** `plan_bicycle_lanes.md`. The plan is architecturally
> right (share the pedestrian signal group; segregated crossings; bikes are
> vehicles not pedestrians) but **wrong on two facts that block implementation**,
> both verified against the code and data.

### 3.1 Correction 1 — the cycleway geometry is NOT loaded today

The 6 `OsmCycleway` ways exist **only in `map_extraction_vector.ttl`**
(`helsinki_intersections/.../fi.helsinki.269/map_extraction_vector.ttl:2954-3031`).
But `scripts/build_demand.py:57-63` (`_ttl_files`) loads only *the single newest*
`map_extraction*.ttl`, and `map_extraction.ttl` is **newer** than
`map_extraction_vector.ttl` — so the cycleway triples **never enter the rdflib
graph**. Any `_Q_BICYCLE_*` query run today returns zero rows. This is the true
first blocker (**Phase 0**), and it's a pure downstream loader fix.
⚠️ The network-build entrypoint (`controller.py` / build scripts) likely has its
own loader that needs the same fix — grep before implementing.

### 3.2 Correction 2 — the real predicates differ from the plan's vocabulary

The plan assumed `oct:onApproach`, `oct:laneDirection`, `oct:hasStopLine`,
`oct:vehicleType vt:bicycle`, `oct:withinZebraCrossing`. **None of these exist on
the actual `OsmCycleway` instances.** What *actually* exists:

**Approach/departure arms** carry `oct:approachesIntersection`,
`oct:departsIntersection`, `oct:bearing`, `oct:osmId` (e.g. way `44810323`
bearing 98.3; `7846068` bearing 291.0 with `oct:oneway false`; `930820890`
bearing 79.1).

**Crossing stripes** carry `oct:cyclewayCrossing true`, `oct:segregated true`,
`oct:crossingWayOnRoad → <road way>`, `oct:osmId` (ways `58015515`, `930820889`,
`930820891`). So the approach-vs-crossing split the plan wanted to *infer from
geometry* is **already explicit** via `oct:cyclewayCrossing` — better than
assumed.

**Already loaded and usable (in `graph.ttl`):**
- `oct:ZebraCrossing` with `oct:bicycle true`, `oct:segregated true`,
  `oct:cyclistMinimumGreen 18.0`, `oct:nearStopLine` — for crossing
  `cd4baa3f80aa`, arm `94e93366af74`. `cyclist_min_green` is **already extracted**
  into `ZebraCrossing.cyclist_min_green` (`extract.py:180`, populated at
  `extract.py:1168`) and currently unused → a clean per-arm "has a cycle track"
  flag (only `cd4baa3f80aa` at 269 has it).
- 40× `oct:sharedWithBicycle true` on `oct:WalkwaySegment` (pedestrian walk graph,
  `graph.ttl:9300-9313`) — a *third* bike signal the plan never mentioned:
  shared-use paths.
- Signal groups carry `oct:mode` of only `car`/`tram`/`pedestrian` — **no bicycle
  group exists**, so "bikes share the pedestrian group" is **forced by the data**,
  confirming the plan's core decision.

### 3.3 Gap analysis ([U] = upstream graph work, [D] = downstream in graph2sumo)

| Need | Reality | Owner |
|---|---|---|
| Cycleways loaded at all | in `map_extraction_vector.ttl`, not loaded | **[D]** loader fix (Phase 0) |
| Approach vs crossing split | explicit via `oct:cyclewayCrossing` | — (present) |
| Which arm a cycleway serves | only `approachesIntersection`→intersection + `oct:bearing` | **[U]** preferred / **[D]** bearing+proximity fallback |
| Ingress vs egress | both `approachesIntersection` & `departsIntersection` (two-way) + 1 `oct:oneway` | **[U]** preferred / **[D]** derivable |
| `vehicleType=bicycle` | absent (typed `oct:OsmCycleway`) | **[D]** query keys off rdf:type |
| Stop-line linkage | absent on way; `ZebraCrossing.nearStopLine` present | **[D]** reuse arm's stop line |
| stripe→ZebraCrossing link | absent; only `crossingWayOnRoad` | **[U]** preferred / **[D]** spatial match |
| Crossing signal presence | `cyclist_min_green` extracted | — (present) |
| Bike signal group/linkIndex | share pedestrian index | — (present, confirmed) |

**Exact upstream vocabulary to request** (mirrors what `oct:Lane` car/tram already
carry, so extraction becomes a verbatim tram copy):

```turtle
# on each OsmCycleway APPROACH arm:
<.../way/44810323>
    oct:onApproach    <.../approach/94e93366af74> ;
    oct:laneDirection "ingress" ;      # extract.py:396 accepts "ingress" or ".../ingress"
    oct:vehicleType   vt:bicycle ;
    oct:hasStopLine   <.../stopline/94e93366af74> .   # reuse the arm's stop line
# on each crossing STRIPE:
<.../way/58015515>
    oct:withinZebraCrossing <.../zebra/cd4baa3f80aa> ;
    oct:vehicleType         vt:bicycle .
```

---

## 4. Practical implementation recommendations

The design mirrors the **tram lane path** (`_Q_TRAM_APPROACH_LANES` at
`extract.py:420`; tram edge emission in `direct_network.py`) because bikes are
structurally a third vehicle class with segregated infrastructure — exactly like
trams.

### Phase 0 — Unblock data loading (½ day, [D], mandatory first)
Fix `_ttl_files` (`scripts/build_demand.py:51`) — and any sibling loader in
`controller.py`/build scripts — to also parse `map_extraction_vector.ttl`. Verify
the 6 cycleways enter the graph; ⚠️ check for conflicting triples between the two
`map_extraction*` files before merging. **Nothing else is testable until this is
done.**

### Phase 1 — Bike crossing + signal sharing (1–2 days, [D], NO upstream needed)
This delivers the headline, signal-correct bike crossing at arm `94e93366af74`
with zero upstream dependency, because `oct:cyclewayCrossing`, `oct:segregated`,
and `cyclist_min_green` are all present.
- **extract.py:** add `_Q_BICYCLE_CROSSINGS` keyed on `a oct:OsmCycleway ;
  oct:cyclewayCrossing true` (no new predicates needed); add a `BikeCrossing`
  dataclass (mirror `CrossingSegment` at `extract.py:154`) + `bike_crossings`
  field on `NetworkData`. Link stripe→zebra by proximity if
  `oct:withinZebraCrossing` is absent.
- **direct_network.py:** emit each stripe as a **normal short vehicle edge**
  `bikecross_{id}` with `allow="bicycle"` (NOT a `<crossing>` — those are
  pedestrian-only and the crossing junction forbids vehicle `incLanes`,
  `direct_network.py:417-430`). Add `"bicycle": "bicycle"` to `_ALLOW`
  (`direct_network.py:45`). Wire the bike connection to the **same TLS with the
  pedestrian crossing's `linkIndex`** (`crossing_offsets[z.id]`), so it goes green
  with the pedestrian phase — guard on `z.cyclist_min_green is not None`.
- **demand.py:** add a `bicycle` vType and one small `flow` across the crossing.

### Phase 2 — Full approach/egress cycle lanes (1–2 days; wants [U], or [D] fallback)
- With upstream (§3.3): add `_Q_BICYCLE_APPROACH_LANES` / `_EGRESS_LANES` as
  verbatim tram-query copies filtered to bicycles; reuse the existing
  `ingress_lane_geoms`/`egress_lane_geoms` with `vehicle_type="bicycle"` and edge
  ids `approach_{arm}_bike` / `exit_{arm}_bike`. Bikes are single-lane (skip the
  tram lane-renumbering at `extract.py:939`).
- Without upstream (**[D] fallback**): match each approach cycleway to the nearest
  `oct:Approach` by `oct:bearing` (98.3 / 291.0 / 79.1) + stop-line proximity;
  emit both ingress and egress from the two-way geometry. Lower fidelity but
  self-contained.
- **direct_network.py:** bike edges flow through the existing generic
  approach/egress loops once `_ALLOW["bicycle"]` exists; add a
  `_BIKE_LANE_WIDTH_M = 1.5` and a low bike priority in `_edge_priority`. Full
  route becomes `approach_{arm}_bike → bikecross_{zebra} → exit_{arm}_bike`.
- **demand.py:** bike flows per qualifying arm (only `94e93366af74` at 269 today →
  a deliberate 1–2-flow trickle, matching the pedestrian philosophy).

### Phase 3 — Shared-use paths (optional, [D])
Exploit the 40 `oct:sharedWithBicycle true` walkway segments to allow bikes on
those footpaths (`allow="pedestrian bicycle"`). ⚠️ Scope carefully: this
re-introduces the walkingarea-vs-vehicle conflict at walk junctions (bikes must
stay off walkingarea internal edges). Not needed for signal-timing validation.

### WebSUMO rendering
- **backend/network.py:224:** a bike-only lane (`allow="bicycle"`) allows neither
  `pedestrian` nor `passenger`, so today it falls through to `'lane'` and renders
  as a car lane. Add a `cyclelane` branch **before** the footpath check:
  ```python
  elif lane.allows('bicycle') and not lane.allows('passenger') and not lane.allows('pedestrian'):
      ptype = 'cyclelane'
  ```
- **frontend/src/MapView.tsx:** add `case 'bicycle': return [230,60,60,240]` to
  `vehicleColor` (live bikes arrive as vclass `"bicycle"`, `sumo_adapter.py:304`,
  field `d[6]`); add a dashed-red `cyclelane` line layer mirroring the footpaths
  layer.
- **Generators:** `_generator_features` already accepts any vType a lane allows,
  so bike approach lanes auto-get click-to-inject markers once a `bicycle` vType
  exists — no change.

### Testing strategy
1. **Network validity:** `sumo -c ...` starts without connection/permission
   errors; bike edges have `allow="bicycle"`.
2. **Routing:** a bike injected on `approach_{arm}_bike` reaches
   `exit_{arm}_bike` via `bikecross_*` (libsumo trace, directed ~5.56 m/s).
3. **Signal compliance:** the bike waits at the crossing during pedestrian red and
   crosses on green (share the ped linkIndex → verify same state char).
4. **Visualisation:** cycle lanes render distinctly; live bikes are red and move
   along the cycleway, never onto a walkingarea.
5. **Regression:** car/tram/pedestrian networks unchanged (bike additions are
   purely additive — new edges, new allow entry, new queries).

### Pitfalls (from the verified research)
- **Don't route bikes over `<crossing>` or walkingareas** — pedestrian-only; use a
  vehicle `bikecross_*` edge.
- **Junction safety gaps** are unrealistically large for bikes (SUMO limitation) —
  acceptable for signal-timing work; note it if analysing conflicts.
- **Single-lane blocking:** without the sublane model a bike blocks following
  cars. Our cycle tracks are *separate* bike-only edges, so this mostly doesn't
  arise — but if bikes ever share a car lane, enable `--lateral-resolution`.
- **`desiredMaxSpeed` vs `maxSpeed`:** use `desiredMaxSpeed` for realistic speed;
  don't just clamp `maxSpeed`.
- **Behavioral realism** (accel/decel/speed distributions) is a *later* upgrade —
  adopt the SimRa-calibrated `vType` or the Bosch RBDM if fidelity matters; the
  default vType is fine for network/signal validation.

---

## 5. Open questions and risks

- ⚠️ **Second loader:** confirm whether `controller.py`/`build_network.py` load
  TTLs the same way as `build_demand.py` (both need the Phase 0 fix).
- ⚠️ **File conflict:** do `map_extraction.ttl` and `map_extraction_vector.ttl`
  define overlapping triples for the same subjects? Diff before merging in the
  loader.
- ⚠️ **`oct:laneDirection` literal form** to request upstream — bare `"ingress"`
  vs `.../ingress` (both accepted at `extract.py:396`); pin it with the graph
  team.
- ⚠️ **Bike through-movement parallel to the road** (not the crossing): recommend
  letting parallel bike traffic ride shared car edges rather than building
  dedicated internal bike lanes through the junction box; a fully separated
  through-path needs its own internal-edge work not covered here.
- **Behavioral fidelity** is explicitly out of scope for network building; flagged
  as a future calibration task with concrete off-the-shelf options (SimRa vType,
  RBDM).

---

## Sources

**SUMO documentation (fetched & verified):** Vehicle_Type_Parameter_Defaults;
Simulation/Bicycles; Simulation/Pedestrians; Simulation/SublaneModel;
Networks/PlainXML; netconvert. **GitHub issues (states verified individually):**
eclipse-sumo/sumo #7685, #16643, #16414, #16576, #13101, #16805. **Literature
(landing pages verified):** arXiv 2205.04538, 2305.01763, 2507.00062; TIB SCP Vol.
4 (Roosta et al.; Kaths & Roosta); EasyChair/EPiC 10.29007/6cs5; DOI
10.1016/j.simpat.2024.102986. **Scenarios:** MoSTScenario, Bologna IJGI 2021
(10.3390/ijgi10030165), InTAS, LuSTScenario, TAPASCologne docs. **Codebase
(file:line verified):** graph2sumo `extract.py`, `direct_network.py`, `demand.py`,
`scripts/build_demand.py`; helsinki_intersections `.../fi.helsinki.269/*.ttl`;
websumo `backend/network.py`, `backend/sumo_adapter.py`, `frontend/src/MapView.tsx`.

Full per-URL source tables and confidence flags are preserved in the research
agents' raw output for this session.
