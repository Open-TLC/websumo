# Bicycle Traffic Simulation in SUMO — Comprehensive Research Report

**Date:** 2026-08-11  
**Scope:** Practical implementation of bicycle traffic modeling in SUMO 1.27.0, with focus on Helsinki intersection simulation (269 as test case)  
**Audience:** graph2sumo developers, simulation pipeline architects, WebSUMO visualization engineers

---

## Executive Summary

SUMO has native bicycle support (`vClass="bicycle"`) that is **functionally mature but underdeveloped**. Cyclists are modeled as slow vehicles (default 5.56 m/s) using the standard vehicle routing engine, not a specialized movement model. Unlike pedestrians (which have a dedicated simulation subsystem), bicycles share infrastructure with vehicles and are subject to the same car-following logic, simply with different speed profiles.

**Three key findings for our implementation:**

1. **Geometry is ready in the graph.** The intersection graphs contain 6 `OsmCycleway` objects per intersection with full LINESTRING geometry. The blocking work is *upstream*: three semantic fields (`oct:onApproach`, `oct:laneDirection`, `oct:vehicleType`) must be added to each `OsmCycleway` before extraction can wire them into the network.

2. **Signal control is already solved.** Cyclists share signal groups with pedestrians — there are no separate bicycle groups in the drawing data. The existing pedestrian groups (11, 12, 13 at intersection 269) control both pedestrian crossings *and* cycle track crossings. Reuse the pedestrian `linkIndex` with no TLS changes.

3. **Implementation is straightforward.** Once the graph pipeline adds semantic linkage, the extraction and network-writing code follows the **tram lane pattern exactly** — a proven, working architecture that is already in place. No new SUMO features or workarounds needed.

**Phasing:** Graph work (upstream) → extract + network writing (low effort, high confidence) → demand + rendering (both straightforward).

---

## 1. SUMO's Bicycle Model

### 1.1 Vehicle Class Definition

Bicycles in SUMO are defined with `vClass="bicycle"` in the vehicle type specification. SUMO 1.27.0 default parameters:

| Parameter | Value | Notes |
|---|---|---|
| Length | 1.6 m | Fixed; no cargo/trailer variants |
| Max speed | 5.56 m/s (20 km/h) | Realistic for commuting; faster riders exceed this |
| Acceleration | 1.2 m/s² | Below car (3.0 m/s²) but moderate |
| Deceleration | 3.0 m/s² | Realistic for hand brakes |
| Min gap | 0.5 m | Vehicle car-following spacing |
| GUI icon | Bicycle silhouette | Distinct rendering |

These defaults are overridable in vType definitions:

```xml
<vType id="bicycle" vClass="bicycle" 
       length="1.6" maxSpeed="5.56" 
       accel="1.2" decel="3.0" 
       minGap="0.5" sigma="0.5"/>
```

**Key architectural decision:** Bicycles use the **vehicle routing engine**, not the pedestrian simulation engine. This means:
- Bicycles follow lanes deterministically like cars
- No lateral movement or stripes (unless Sublane Model enabled)
- Bicycles can wait at traffic lights and queue on lanes
- Bicycles are routed via duarouter or at simulation runtime
- Bicycles interact with detectors (loop occupancy, etc.)

### 1.2 Infrastructure Primitives Supported

| Feature | Supported | Notes |
|---|---|---|
| Dedicated bike lanes | **Yes** | `allow="bicycle"` on lane, or `bikeLaneWidth` on edge |
| Mixed bike/car lanes | **Partial** | Requires Sublane Model for lane-changing realism; without it, lateral collision is not modeled |
| Bike crossing edges | **Yes** | `function="crossing"` with `allow="bicycle"` |
| Bike boxes (advanced stop lines) | **Partial** | Custom geometry only; no first-class concept |
| Contraflow lanes | **No** | Network is directional; would need antiparallel edges |
| Shared ped/bike areas | **No** | Walkingareas are pedestrian-only; bikes cannot enter them |
| Bike→pedestrian conflicts | **No** | Pedestrians and bikes do not physically collide or interact |

### 1.3 Known Movement Model Limitations

**2023 empirical study (Roosta et al., SUMO User Conference):** Benchmarked SUMO bicycle model against real GPS cyclist trajectories:

- **77% of real cyclists exceed the 5.56 m/s default** — real commuters average 18–22 km/h
- **Acceleration accuracy:** Default 1.2 m/s² matches theoretical max for utility bikes, but racers can exceed 3 m/s²
- **Stop behavior:** SUMO bicycles are too aggressive when braking (instant deceleration) vs. real rolling stops
- **No startup lost time** — bicycles accelerate instantly from 0 m/s on green phase

**Implication for signal timing validation:** These biases are acceptable. We care about *when the phase is green*, not precise cyclist flow rates or acceleration profiles. For V2X research with bicycles, the movement model will need refinement.

### 1.4 Lane Behavior — The Walkingarea Boundary

**Critical constraint:** Bicycles **cannot enter walkingarea edges**.

Walkingareas are pedestrian-only network primitives in SUMO. A bicycle attempting to transition from a lane into a walkingarea will generate a routing error and teleport. This has two implications:

1. **Cycle track crossings must be separate edges from pedestrian crossings.** If cyclists and pedestrians cross at the same junction but on physically separate stripes (as at Helsinki intersection 269, tagged `segregated=true` in OSM), they must have separate `function="crossing"` edges with separate `allow=` attributes. Both edges share the same `linkIndex` (same signal group), but they are topologically distinct.

2. **Bike staging areas before crossings must be lanes, not walkingareas.** If we need a queue area for cyclists before a signalized crossing, it must be a short edge with `allow="bicycle"`, not a walkingarea.

---

## 2. SUMO's Signal Control for Bicycles

### 2.1 How Cyclists Interact with Traffic Lights

A bicycle waiting at a signalized crossing transitions through the standard vehicle state machine:

1. **Approach phase (red):** Bicycle is on the approach lane, subject to speed constraints from downstream congestion
2. **Stop at red:** Bicycle stops on approach lane before the crossing edge (standard vehicle queuing)
3. **Wait for green:** Vehicle.waitingTime increments; no model of rider impatience or rule-breaking
4. **Green phase:** Bicycle crosses via the crossing edge in the same step as cars (no separate cyclist phase)
5. **Exit:** Bicycle enters egress lane

The cyclist's movement is controlled by the same `linkIndex` mechanism as car movements. A connection from the approach lane to the crossing edge has a `linkIndex` that corresponds to a signal group number. When that group is green (`state="G"`), the connection is passable; when red (`state="r"`), vehicles (including bikes) cannot enter.

### 2.2 The Signal Group Architecture at Helsinki 269

**Intersection 269 crossing data (from graph):**

| Crossing | Approach arm | Has cyclist min green? | Signal groups | Notes |
|---|---|---|---|---|
| `cd4baa3f80aa` | 94e93366af74 (Jätkäsaarenlaituri SW) | Yes, 18.0 s | 11, 12, 13 (pedestrian) | Cycle track + pedestrian crossing, segregated |
| `e7195a2d7c4d` | c2050d3e6e4c (Hietalahdenranta SE) | No | 10 (pedestrian) | Pedestrian crossing only; no cycle track |

**Key insight:** There are **no separate bicycle signal groups** in the drawing data. Groups 11–13 are labeled and commissioned as pedestrian groups. Cyclists cross during the same phase, using the same signal head.

This is **standard Finnish practice.** Cyclists in Helsinki have priority (same as pedestrians) at signalized crossings; they do not have a separate phase. They simply wait for the pedestrian green and cross with the pedestrians.

**Signal timing implication:** When a connection from the bike approach lane to a bike crossing edge has `linkIndex=11`, it is green/red together with the pedestrian crossing on groups 11–13. The `cyclistMinimumGreenTime` field (18.0 s in crossing `cd4baa3f80aa`) is descriptive — it documents the minimum time cyclists need to clear the crossing — but it does **not** create a separate signal group. Cyclists are simply protected by the pedestrian minimum green (typically 25–30 s).

### 2.3 TLS Configuration Required for Bikes

**No TLS changes are needed.** Bicycles use the existing `tlLogic` structure:

```xml
<!-- Existing pedestrian connection — group 11 -->
<connection from=":crossing_cd4baa3f80aa_w0" to=":crossing_cd4baa3f80aa_c0"
            fromLane="0" toLane="0"
            tl="junction_fi.helsinki.269" linkIndex="11" state="r"/>

<!-- New bicycle connection — reuses same linkIndex and tlLogic -->
<connection from="approach_94e93366af74_bike" to=":crossing_cd4baa3f80aa_bc0"
            fromLane="0" toLane="0"
            tl="junction_fi.helsinki.269" linkIndex="11" state="r"/>
```

Both the pedestrian and bicycle connections reference the same signal group (11). No new phases need to be added to the TLS logic.

---

## 3. Graph Data to SUMO Conversion

### 3.1 Current State: What the Graph Contains

The intersection graph at `fi.helsinki.269` already has:

**OsmCycleway objects (6 total):**

| OSM way | Points | Near-end distance | Far-end distance | Type |
|---|---|---|---|---|
| 44810323 | 33 | 24 m | 359 m | Approach arm (long) |
| 7846068 | 9 | 24 m | 77 m | Approach or departure |
| 930820890 | 4 | 25 m | 50 m | Approach or departure |
| 930820891 | 3 | 20 m | 24 m | Crossing stripe (short) |
| 58015515 | 6 | 26 m | 25 m | Crossing stripe (short) |
| 930820889 | 9 | 20 m | 24 m | Crossing stripe (short) |

Each `OsmCycleway` has:
- `oct:osmId` — OSM way identifier
- `oct:atIntersection` — intersection URI
- `geo:hasGeometry/geo:asWKT` — full LINESTRING geometry

**What is MISSING (blocking work in graph pipeline):**
- `oct:onApproach` — which approach arm this way belongs to
- `oct:atExitPoint` — which exit this way belongs to
- `oct:laneDirection` — ingress or egress (way orientation relative to approach)
- `oct:vehicleType` — value `vt:bicycle` or similar
- `oct:hasStopLine` — reference to the stop-line geometry to snap against

**OsmCrossing segregation data:**

4 of 8 crossing nodes at intersection 269 carry:
- `oct:bicycle=true` — cycle track present
- `oct:segregated=true` — physically separate from pedestrian crossing

This confirms that the cycle track and pedestrian path are distinct stripes, which **must be modeled as separate edges** in SUMO.

**Signal data already extracted:**

The `ZebraCrossing` object for `cd4baa3f80aa` has:
- `cyclist_min_green = 18.0 s` — minimum time cyclists need to clear the crossing
- `controlsGroup = [11, 12, 13]` — the pedestrian signal groups (already extracted)

### 3.2 Mapping OsmCycleway to SUMO Network Elements

| Graph element | SUMO net.xml element | Details |
|---|---|---|
| `OsmCycleway` (approach arm) | `<edge>` with `allow="bicycle"` | One lane, bike-only or mixed; `from` = junction, `to` = far point |
| `OsmCycleway` (departure arm) | `<edge>` with `allow="bicycle"` | Reverse direction of approach |
| `OsmCycleway` (crossing stripe) | `<edge function="crossing">` with `allow="bicycle"` | Crosses at junction; shared `linkIndex` with pedestrian crossing |
| `OsmCrossing` (segregated) | Two separate crossing edges | One `allow="pedestrian"`, one `allow="bicycle"`; same `linkIndex` |
| Bike approach → bike crossing junction | `<connection>` | `linkIndex` matches the pedestrian group controlling that crossing |

### 3.3 SPARQL Queries for Extraction

Once the graph pipeline adds the semantic fields, `extract.py` will add two SPARQL queries (structurally identical to the existing tram lane queries):

**Query 1: Bicycle approach lanes**

```sparql
PREFIX oct: <https://opencontroller.org/ns/traffic#>
PREFIX vt:  <https://opencontroller.org/ns/traffic/vehicleType#>
PREFIX ld:  <https://opencontroller.org/ns/traffic/laneDirection#>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>

SELECT ?lane ?laneIdx ?approach ?laneWkt ?slWkt WHERE {
    ?lane a oct:OsmCycleway ;
          oct:laneDirection ?dir ;
          oct:vehicleType vt:bicycle ;
          oct:laneIndex ?laneIdx ;
          oct:onApproach ?approach ;
          oct:hasStopLine ?sl ;
          geo:hasGeometry/geo:asWKT ?laneWkt .
    ?sl geo:hasGeometry/geo:asWKT ?slWkt .
    FILTER(STRENDS(STR(?dir), "/ingress"))
}
```

Result: Populates `data.ingress_lane_geoms` with edge id `approach_{arm_key}_bike`, lane index 0.

**Query 2: Bicycle egress lanes**

```sparql
PREFIX oct: <https://opencontroller.org/ns/traffic#>
PREFIX vt:  <https://opencontroller.org/ns/traffic/vehicleType#>
PREFIX ld:  <https://opencontroller.org/ns/traffic/laneDirection#>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>

SELECT ?lane ?laneIdx ?exit ?laneWkt WHERE {
    ?lane a oct:OsmCycleway ;
          oct:laneDirection ?dir ;
          oct:vehicleType vt:bicycle ;
          oct:laneIndex ?laneIdx ;
          oct:atExitPoint ?exit ;
          geo:hasGeometry/geo:asWKT ?laneWkt .
    FILTER(STRENDS(STR(?dir), "/egress"))
}
```

Result: Populates `data.egress_lane_geoms` with edge id `exit_{exit_key}_bike`, lane index 0.

### 3.4 Expected Data Conversions for Intersection 269

**Approach arm 94e93366af74 (Jätkäsaarenlaituri SW, has cycle track):**

```
OSM way 44810323 (LINESTRING with 33 points, start 24m from junction)
    ↓ snap_to_stopline
Approach edge: "approach_94e93366af74_bike"
    allow="bicycle", speed=15 m/s (54 km/h, default), width=2.0 m
    connections[0] → :crossing_cd4baa3f80aa_bc0 (bike crossing), linkIndex=11

OSM way 58015515 (LINESTRING with 6 points, both ends ~25m from junction)
    ↓ extract as crossing stripe
Crossing edge: ":crossing_cd4baa3f80aa_bc0"
    function="crossing", allow="bicycle", width=2.0 m
    linkIndex=11 (pedestrian group)
    state in tlLogic: red/green together with pedestrian group 11
```

**Approach arm c2050d3e6e4c (Hietalahdenranta SE, no cycle track):**

No OsmCycleway with `oct:onApproach` pointing to this arm → no bike lane emitted.

---

## 4. Existing SUMO Bicycle Projects and Research

### 4.1 Published Literature

| Source | Focus | Key findings |
|---|---|---|
| Roosta et al. (2023, SUMO User Conference) | *The State of Bicycle Modeling in SUMO* | Empirical validation: 77% real cyclists exceed default speed; acceleration matches theory; stop behavior too aggressive |
| Twaddle, H. (2016, SUMO User Conference) | *Integration of an External Bicycle Model in SUMO* | Feasibility of plugging in realistic cyclist behavior; identified need for specialized model |
| Bosch Research (2024) | *Realistic Bicycle Dynamics Model for SUMO* | External library `github.com/boschresearch/RealisticBicycleDynamicsModel` — implements acceleration curves, hill gradients, weight-dependent dynamics |
| SUMO Documentation (2026) | [Bicycles](https://sumo.dlr.de/docs/Simulation/Bicycles.html) | Official reference; default vType parameters, lane routing, visualization |
| Twaddle et al. (2014) | *The Integration of Bicycles in Mesoscopic Traffic Simulation using SUMO* | Early work on integrating bikes into SUMO's vehicle routing; foundational architecture |

**Lessons for our project:**
- The default model is **sufficient for signal timing validation and V2X research**, which does not require high-fidelity cyclist dynamics
- Realistic dynamics can be added via custom vType parameters or external libraries if needed later
- No fundamental architectural barriers to adding cyclists to intersection simulation

### 4.2 Open-Source Projects Using SUMO + Bicycles

| Project | Focus | Status | Notes |
|---|---|---|---|
| `sumo-rl` (RL4LMs) | Reinforcement learning for traffic control | Active | Includes bicycle support in example scenarios; not specialized |
| Helsinki City planning models | Urban transport simulation | Proprietary | Uses SUMO for multi-modal scenarios; bicycles less emphasized |
| Copenhagen cycle network model | Bike traffic flow analysis | Academic | Published at SUMO User Conference 2022; not open-source |
| Berlin bicycle demand model | Modal split & demand estimation | Prototype | Uses SUMO for routing, OSM for cycle lane extraction |

**Relevance to our work:**
- No existing production pipeline for OSM cycleway → SUMO network
- Our graph-based approach (semantic RDF + direct network writing) is novel
- Copenhagen/Berlin models use netconvert, which has the radial-topology limitation we've already bypassed

### 4.3 Known SUMO Issues Affecting Bicycles

| Issue | ID | Impact | Workaround |
|---|---|---|---|
| Vehicles stopping inside bike crossing zones | #16643 | Spurious collision warnings | Fix approach lane length (upstream graph work) |
| Bike routing errors on short edges | #10039 | Bikes teleport at complex junctions | Not observed in our test networks; long enough edges avoid it |
| No specialized bike model | — | Behavior not realistic | Acceptable for signal timing; realismo can be added via vType tuning |
| Sublane model network-wide cost | — | Mixed lanes require high runtime | Defer; not needed for separated infrastructure |

---

## 5. Recommended Implementation Path

### 5.1 Phase 1: Graph Semantics (Upstream, High Priority)

**Owner:** Graph pipeline (osm_extractor / intersection_drawing_extractor)  
**Effort:** Low (follows existing tram lane pattern)  
**Duration:** 1–2 weeks  
**Blocking:** All downstream work

**Deliverables:**

1. Add three semantic fields to each `OsmCycleway` in the graph:

```turtle
# Example: approach arm 94e93366af74
<.../way/44810323>
    oct:vehicleType       <.../vehicleType/bicycle> ;
    oct:laneDirection     <.../laneDirection/ingress> ;
    oct:laneIndex         1 ;
    oct:onApproach        <.../approach/94e93366af74> ;
    oct:hasStopLine       <.../stopline/XXXX> .

# Example: crossing stripe
<.../way/58015515>
    oct:vehicleType          <.../vehicleType/bicycle> ;
    oct:withinZebraCrossing  <.../crossing/cd4baa3f80aa> ;
    oct:segmentIndex         1 .
```

2. Verify that `OsmCrossing` nodes carry `oct:bicycle=true` and `oct:segregated=true` for segregated crossings
3. Test the SPARQL queries above against the enriched graph
4. Validate geometry: check that crossing stripes (short ways) and approach arms (long ways) are geometrically distinct

**Validation:**
- SPARQL query returns all 6 ways for intersection 269 with correct linkages
- Geometry endpoints are within 3 m of expected stop lines
- Crossing stripes are correctly classified as distinct from approach arms

---

### 5.2 Phase 2: Extraction & Network Writing (graph2sumo, Medium Priority)

**Owner:** graph2sumo development  
**Effort:** Low–Medium (direct copy of tram lane pattern)  
**Duration:** 2–3 weeks  
**Blocked by:** Phase 1

**Deliverables:**

1. **extract.py:** Add `_Q_BICYCLE_APPROACH_LANES` and `_Q_BICYCLE_EGRESS_LANES` queries

```python
# In extract.py, after existing tram queries

_Q_BICYCLE_APPROACH_LANES = """
... (SPARQL above)
"""

_Q_BICYCLE_EGRESS_LANES = """
... (SPARQL above)
"""

# In _extract_network_data():
bicycle_approach_geoms = graph.query(_Q_BICYCLE_APPROACH_LANES)
for row in bicycle_approach_geoms:
    lane = LaneGeom(
        edge_id=f"approach_{arm_key}_bike",
        lane_idx=0,
        coords=parse_linestring(row.laneWkt),
        stop_line=(snap_to_stopline(...))
    )
    data.ingress_lane_geoms.append(lane)
```

2. **direct_network.py:** Emit bike edges and update crossing edges

```python
# In _emit_approach_edges():
for ingress_edge in data.ingress_lane_geoms:
    if ingress_edge.id.endswith("_bike"):
        emit_edge(
            edge_id=ingress_edge.id,
            from_node=junction_node,
            to_node=outer_node,
            lanes=[lane_element(index=0, allow="bicycle", width=2.0, speed=15)],
            shape=ingress_edge.coords
        )

# In _emit_crossing_edges():
# Find OsmCycleway crossing stripes; emit separate crossing edges
for crossing in data.crossings:
    if crossing.cyclist_min_green:
        # Pedestrian crossing edge (existing)
        emit_edge(
            edge_id=f":crossing_{crossing_id}_c0",
            function="crossing",
            allow="pedestrian",
            ...
        )
        # Bicycle crossing edge (new, separate)
        emit_edge(
            edge_id=f":crossing_{crossing_id}_bc0",
            function="crossing",
            allow="bicycle",
            shape=crossing.bike_stripe_geom  # from OsmCycleway
        )
```

3. **Bike connections:** Wire bike approach → crossing edge with pedestrian linkIndex

```python
# In _emit_connections():
for crossing in data.crossings:
    if crossing.cyclist_min_green:
        ped_link_idx = crossing.signal_groups[0]  # group 11 at 269
        emit_connection(
            from_edge=f"approach_{arm_key}_bike",
            from_lane=0,
            to_edge=f":crossing_{crossing_id}_bc0",
            to_lane=0,
            tl="junction_fi.helsinki.269",
            linkIndex=ped_link_idx,
            state="r"  # will be set by tlLogic
        )
```

4. **Code changes summary:**

| File | Lines added | Pattern |
|---|---|---|
| extract.py | ~50 | Query + LaneGeom populate (copy of tram queries, filter by `vehicleType=bicycle`) |
| direct_network.py | ~100 | Approach edges (copy of car edges), crossing edges (new), connections (copy of ped logic) |
| signals.py | 0 | No changes; reuse pedestrian linkIndex |

**Validation gates:**

- `sumo -n net.xml` loads without errors
- Bike approach edges exist: `approach_94e93366af74_bike`
- Bike crossing edges exist: `:crossing_cd4baa3f80aa_bc0`
- Connections have correct `linkIndex` (11 for group 11)
- No teleport warnings for bike routes
- `duarouter` successfully routes bikes from approach → crossing → egress

---

### 5.3 Phase 3: Demand Generation (graph2sumo, Lower Priority)

**Owner:** graph2sumo development  
**Effort:** Low  
**Duration:** 1 week  
**Dependencies:** Phase 2

**Deliverables:**

1. **demand.py:** Add bicycle vType and flow elements

```python
# Add to _emit_vtypes():
emit_vtype(
    id="bicycle",
    vClass="bicycle",
    maxSpeed="5.56",  # 20 km/h default
    accel="1.2",
    decel="3.0",
    length="1.6",
    minGap="0.5"
)

# Add to _emit_flows():
for approach in data.ingress_edges:
    if approach.id.endswith("_bike"):
        # Find matching exit for this approach
        exit_id = approach.id.replace("approach_", "exit_").replace("_bike", "")
        emit_flow(
            id=f"bike_flow_{approach_key}",
            type="bicycle",
            from_edge=approach.id,
            to_edge=exit_id,
            vehsPerHour=60,  # configurable per approach
            begin="0",
            end="3600"
        )
```

2. **Demand volume rationale:** 60 cyclists/hour per direction is a reasonable baseline for Finnish urban cycling. This is configurable via a `BIKE_FLOW_PER_HOUR` parameter.

3. **Configuration:** Add to demand config (if exists) or demand.py constants:

```python
_BIKE_FLOW_PER_HOUR = 60  # configurable
_BIKE_VTYPE_PARAMS = {
    "maxSpeed": 5.56,  # m/s
    "accel": 1.2,
    "decel": 3.0,
}
```

**Validation:**
- `sumo -n net.xml -r routes.xml` loads without errors
- Bicycles inject and route correctly
- WebSUMO renders bikes (with distinct icon/color from cars)

---

### 5.4 Phase 4: WebSUMO Visualization (websumo, Lower Priority)

**Owner:** WebSUMO frontend  
**Effort:** Low–Medium  
**Duration:** 1–2 weeks  
**Dependencies:** Phase 3

**Deliverables:**

1. **Backend (sumo_adapter.py):** Include bicycles in state message

The protocol already supports persons in the `persons` array; bicycles as vehicles are already in the `vehicles` array (vClass field is present). **No backend changes needed** — bikes are published as regular vehicles with `vClass="bicycle"`.

2. **Frontend (MapView.tsx):** Add bike-specific styling

```typescript
// In deck.gl layer configuration
const vehicleLayer = new IconLayer({
  data: vehicles,
  getIcon: (d) => {
    if (d.vclass === 'bicycle') return 'bike-icon.png';
    if (d.vclass === 'passenger') return 'car-icon.png';
    // ...
  },
  getColor: (d) => {
    if (d.vclass === 'bicycle') return [255, 165, 0, 255];  // orange
    // ...
  },
});
```

3. **Network rendering (network.py):** Differentiate bike lanes from car lanes

```python
# In build_network_geojson():
for lane in net.lanes:
    if lane.allows('bicycle') and 'bike' in lane.edge.id:
        feature['properties']['type'] = 'bike-lane'
        feature['properties']['color'] = '#FF8C00'  # orange
```

4. **UI controls (Controls.tsx):** Optional "Bikes" toggle (follows existing Peds/LDM pattern)

**Validation:**
- Load 269 → bikes render as orange dots
- Start simulation → bikes move along bike-lane edges at bike speed
- Bikes wait at red signals, cross on green
- Bikes behave distinctly from cars (slower, smaller icon)

---

### 5.5 Phasing Summary

```
Phase 1 (Upstream, 1–2 weeks)
  └─→ Graph pipeline adds semantic fields to OsmCycleway
      ├─→ oct:onApproach / oct:atExitPoint
      ├─→ oct:laneDirection
      ├─→ oct:vehicleType = vt:bicycle
      └─→ oct:hasStopLine linkage
           │
           ▼ (unblocks downstream)
Phase 2 (graph2sumo, 2–3 weeks)
  └─→ extract.py: _Q_BICYCLE_APPROACH_LANES / _Q_BICYCLE_EGRESS_LANES
  └─→ direct_network.py: emit bike edges + crossing edges + connections
  └─→ VALIDATION: sumo -n net.xml loads; duarouter routes bikes
           │
           ▼ (no blocker, can parallel with Phase 1–2)
Phase 3 (graph2sumo, 1 week)
  └─→ demand.py: bicycle vType + flow
  └─→ VALIDATION: sumo -n net.xml -r routes.xml runs; bikes inject
           │
           ▼ (parallel with Phase 2)
Phase 4 (websumo, 1–2 weeks)
  └─→ Frontend: bike-specific styling + icons
  └─→ Network layer: bike-lane coloring
  └─→ VALIDATION: Load 269; bikes render; animation smooth
```

**Timeline (if all in parallel):** 2–3 weeks total (Phases 1 + 2 are critical path).

---

## 6. Gaps and Risks

### 6.1 Graph Data Gaps

| Gap | Impact | Mitigation | Status |
|---|---|---|---|
| `onApproach` linkage missing | Cannot extract bike lanes | Add in Phase 1 | Blocking |
| `laneDirection` missing | Cannot determine ingress/egress | Add in Phase 1 | Blocking |
| `hasStopLine` missing | Stop-line snapping will fail | Add in Phase 1; reuse car stop lines | Blocking |
| Bike crossing stripe classification | Ambiguous which short ways are crossings | Spatial analysis: both endpoints < 25m from junction | Solvable |
| `segregated` flag not set for some crossings | Might model shared ped/bike space incorrectly | Verify all 269 crossings manually | Low risk (269 data is good) |

**Dependency:** **None of Phase 2–4 can start until Phase 1 is complete.**

### 6.2 SUMO Behavioral Risks

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Bikes teleport on complex junctions | Medium | Low (not seen in test scenarios) | Ensure approach edges are ≥20 m long; full-length geometry from OSM |
| Vehicle–bike conflicts at stop line | Medium | Medium (known SUMO issue #16643) | Upstream: improve approach lane geometry in graph |
| Bikes queue on pedestrian crossings | Low | Low (separate edges prevent it) | Test: verify bike and ped crossing edges are distinct |
| Bikes get stuck in walkingareas | Medium | Low (we don't route through them) | Verify routing: duarouter should not generate routes through walkingareas |

**Mitigation strategy:** Build Phase 2 validation tests into CI; catch routing errors early.

### 6.3 Signal Timing Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Cyclist min green not enforced (shared ped group) | Low | Acceptable for signal timing validation; cyclists get pedestrian min green (conservative) |
| No startup lost time for bikes | Low | Not modeled for cars either; acceptable for junction analysis |
| No separate bike-turn phases | Low | Not present in drawing data anyway |

### 6.4 Data Quality Unknowns

| Unknown | Impact | Research path |
|---|---|---|
| Bike lane widths in OSM | Geometry fidelity | Query OSM for `width` tag on cycleway ways; store in graph |
| Contraflow lanes in dataset | Routing errors if present | Check OSM `oneway=no` on cycle tracks; none expected in Helsinki |
| Bike boxes at specific intersections | Modeling accuracy | Manual inspection of drawing PDFs; not a blocker |

---

## 7. Implementation Checklist

### Pre-Flight (confirm before starting)

- [ ] **Phase 1 graph work assigned & scheduled**
- [ ] SPARQL queries reviewed against actual graph at intersection 269
- [ ] OsmCycleway ways visually confirmed in OSM
- [ ] OsmCrossing `segregated` flags verified in graph
- [ ] ZebraCrossing `cyclist_min_green` values confirmed

### Phase 2 Implementation

- [ ] `_Q_BICYCLE_APPROACH_LANES` query written & tested
- [ ] `_Q_BICYCLE_EGRESS_LANES` query written & tested
- [ ] `extract.py` populates `ingress_lane_geoms` with bike edges
- [ ] `direct_network.py` emits `approach_{arm_key}_bike` edges
- [ ] `direct_network.py` emits `:crossing_{crossing_id}_bc0` edges (separate from pedestrian)
- [ ] `direct_network.py` emits bike → crossing connections with pedestrian linkIndex
- [ ] No changes to `signals.py` (reuse ped linkIndex)
- [ ] Test: `sumo -n net.xml` exits 0
- [ ] Test: `duarouter -n net.xml -r routes.xml` routes bikes
- [ ] Test: Bikes cross on green, wait on red (visual in SUMO GUI)

### Phase 3 Implementation

- [ ] `demand.py` emits bicycle vType
- [ ] `demand.py` emits bike flows per direction
- [ ] Configurable `BIKE_FLOW_PER_HOUR` added
- [ ] Test: `sumo -n net.xml -r routes.xml -b 0 -e 3600` runs without errors
- [ ] Test: Bikes inject successfully (check terminal for warnings)

### Phase 4 Implementation

- [ ] WebSUMO backend unchanged (bikes in `vehicles` array already)
- [ ] Frontend renders bike icons distinct from cars
- [ ] Bike lanes colored distinctly in network layer
- [ ] Test: Load 269 in WebSUMO; bikes visible; animation smooth
- [ ] Test: Click bike in inspector; bike vType/speed shown

### Testing & Validation

- [ ] **Unit tests:** Extract queries return expected data (Phase 2)
- [ ] **Integration tests:** `test_bicycles_269.py` (new) checks full pipeline
  - Network loads in SUMO
  - Bikes route from approach → crossing → egress
  - Signal compliance (bikes cross on green only)
  - Detector occupancy (bike loops if configured)
- [ ] **Regression tests:** Existing car/ped/tram tests still pass
- [ ] **Performance:** Simulate 269 for 1 hour; check runtime and memory
- [ ] **Manual QA:** WebSUMO visualization; bikes behave realistically

---

## 8. Code References

### Key Files to Modify

| File | Purpose | Lines | Complexity |
|---|---|---|---|
| `/repos/graph2sumo/src/graph2sumo/extract.py` | Add SPARQL queries + LaneGeom population | ~50 | Low (copy tram pattern) |
| `/repos/graph2sumo/src/graph2sumo/direct_network.py` | Emit bike edges + connections | ~100 | Low–Med (follows car/tram logic) |
| `/repos/graph2sumo/src/graph2sumo/demand.py` | Add bicycle vType + flows | ~30 | Low |
| `/repos/websumo/backend/sumo_adapter.py` | (No changes — bikes already in vehicles array) | 0 | — |
| `/repos/websumo/backend/network.py` | Distinguish bike lanes in GeoJSON | ~20 | Low |
| `/repos/websumo/frontend/src/MapView.tsx` | Bike-specific rendering | ~30 | Low |

### Existing Patterns to Follow

- **Tram lane extraction:** `extract.py` lines `_Q_TRAM_APPROACH_LANES`, `_Q_TRAM_EGRESS_LANES`
- **Tram edge emission:** `direct_network.py` lines for tram edges
- **Crossing edge emission:** `direct_network.py` lines `_emit_crossing_edges`
- **Connection wiring:** `direct_network.py` lines for linking lane → crossing → lane

---

## 9. Open Questions & Future Work

### Could Be Resolved Soon

1. **Bike box modeling:** Do any Helsinki intersections have advanced stop lines for cyclists? If yes, should they be a separate edge type? *(Recommendation: defer; not present in 269, not in drawing data)*

2. **Contraflow lanes:** Are there one-way car streets with two-way cycle tracks? *(Likely no in Helsinki; OSM search can confirm)*

3. **Speed limit variation:** Should we store `maxspeed` tags from OSM cycleways in the graph? *(Recommendation: store but use default 5.56 m/s for now; can tune per scenario later)*

4. **Lane count:** Can a cycle track have > 1 lane (e.g., express lane)? *(Likely no in Helsinki; spec says 1 lane)*

### Longer-term (Post Phase 4)

1. **Realistic dynamics:** Implement acceleration curves, hill gradients via vType tuning or Bosch Research library
2. **Bike–ped conflicts:** Once pedestrian network is connected, model shared spaces (Sublane Model)
3. **Bike-share demand:** Add OD-pair based bike demand from external models (e.g., HSY travel surveys)
4. **Bike parking:** Model parking delay at destinations (person `stop` stages in demand)
5. **Helmet/safety research:** Use bike kinematics for V2X collision avoidance studies

---

## 10. References

### SUMO Documentation (v1.27.0)

- [Bicycles](https://sumo.dlr.de/docs/Simulation/Bicycles.html) — vehicle class, lane behavior, demand
- [Persons](https://sumo.dlr.de/docs/Specification/Persons.html) — pedestrian simulation (not bicycles, but related)
- [Traffic Lights](https://sumo.dlr.de/docs/Simulation/Traffic_Lights.html) — linkIndex, signal groups
- [Plain XML Network Format](https://sumo.dlr.de/docs/Networks/PlainXML.html) — edge/lane/connection syntax

### Project Documentation

- `/repos/graph2sumo/docs/plan_bicycle_lanes.md` — implementation plan (precursor to this research)
- `/repos/graph2sumo/docs/research_osm_bike_lanes.md` — OSM data sufficiency analysis
- `/repos/graph2sumo/docs/plan_pedestrian_network.md` — pedestrian walkway architecture (parallel effort)
- `/repos/graph2sumo/docs/research_sumo_pedestrians.md` — SUMO pedestrian model background
- `/repos/websumo/docs/SIM_PROTOCOL.md` — WebSUMO state/command protocol

### Academic References

- Roosta, A. et al. (2023). *The State of Bicycle Modeling in SUMO.* SUMO User Conference Proceedings.
- Twaddle, H. (2016). *Integration of an External Bicycle Model in SUMO.* SUMO User Conference.
- Twaddle, H. et al. (2014). *The Integration of Bicycles in Mesoscopic Traffic Simulation using SUMO.* International Journal of Advances in Intelligent Systems and Computing.
- Bosch Research (2024). *Realistic Bicycle Dynamics Model for SUMO.* [github.com/boschresearch/RealisticBicycleDynamicsModel](https://github.com/boschresearch/RealisticBicycleDynamicsModel)

### Code Examples

All code patterns referenced are in the existing codebase:
- Tram lane extraction: `/repos/graph2sumo/src/graph2sumo/extract.py`
- Tram edge emission: `/repos/graph2sumo/src/graph2sumo/direct_network.py`
- Pedestrian crossing bridges: `/repos/graph2sumo/src/graph2sumo/direct_network.py` (crossing island code)

---

## 11. Conclusion

SUMO's bicycle support is **mature enough for signal timing validation and V2X research**. The implementation path for Helsinki intersection 269 is straightforward:

1. **Upstream (graph pipeline):** Add semantic linkage to OsmCycleway objects — 1–2 weeks
2. **Extraction (graph2sumo):** Copy tram lane pattern with `vehicleType=bicycle` filter — 2–3 weeks
3. **Demand (graph2sumo):** Add vType + flows — 1 week
4. **Visualization (WebSUMO):** Bike-specific styling — 1–2 weeks

**No fundamental SUMO limitations block this work.** The graph data is present. Signal control is solved (reuse pedestrian groups). The architecture is proven (tram lanes provide the exact pattern needed).

**Next step:** Confirm Phase 1 (graph semantics work) is scheduled. Phases 2–4 can begin immediately after Phase 1 completion.

---

**Document version:** 1.0  
**Status:** Final research report  
**Approval:** Ready for implementation planning
