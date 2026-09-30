# Visualizing Mesoscopic Traffic Simulations (and SUMO MESO) — Live

Research synthesis for the `exp/meso-sumosim` work: how mesoscopic models represent
state, what SUMO's MESO extension actually exposes, how the field visualizes it, and
what that means for the websumo web viewer (libsumo → NATS → deck.gl/MapLibre).

Method: fan-out web research, 19 primary/secondary sources fetched, 85 claims
extracted, 25 verified by 3-vote adversarial check (23 confirmed, 2 killed). Claims
below are the confirmed ones unless flagged **[REFUTED]** or **[UNCERTAIN]**. Sources
are linked inline.

---

## TL;DR / recommendation

- **Meso state is edge/segment-level flow–density, not vehicle positions.** In SUMO
  MESO the "cars" you see are cosmetic placements inside 100 m queue segments — the
  model does not compute an instantaneous vehicle speed or lane position at all.
- **For meso runs, make the network the primary visual, not the glyphs.** Color each
  edge by mean speed / density / occupancy (link choropleth), scale width by flow, and
  draw per-approach queue indicators. This is exactly what Aimsun, Visum-class tools,
  and UXsim do, and it maps cleanly onto deck.gl's `PathLayer` (`getColor`/`getWidth`).
- **Keep vehicle glyphs only as an optional, honestly-labeled "approximate" overlay** —
  never as the source of truth for a meso run.
- **Signal-control (OC/ATSPM) demos are well served by meso's native queue/discharge
  state**, but *true* ATSPM MOEs need high-resolution signal events + per-vehicle
  waypoints, which are a microscopic artifact. See §4.

---

## 1. The mesoscopic live-data model (vs micro)

Mesoscopic models sit between macroscopic (flow-density PDEs) and microscopic
(per-vehicle car-following): they "combine the merits of both … capturing individual
vehicle behavior in [some] detail [while] remaining … computational efficien[t]"
([arXiv 2606.09282](https://arxiv.org/abs/2606.09282)). The native per-timestep state
is **link/segment aggregate**, not trajectories.

**Cell Transmission Model (Daganzo 1994)** — the theoretical backbone
([TRID 412943](https://trid.trb.org/view/412943)):
- CTM uses "easy-to-solve difference equations … the discrete analog of the
  differential equations arising from … the hydrodynamic [LWR] model of traffic flow."
  It is a *macroscopic* representation grounded in flow-density, not vehicle paths.
- It "predict[s] traffic's evolution over time and space, including transient phenomena
  such as the building, propagation, and dissipation of queues." → queues are a *native
  output*, per cell, per step.
- It "automatically generates … a jump in density such as those … at the end of every
  queue" — **back-of-queue shockwaves are inherent**, no side calculation. Directly
  relevant to visualizing queue formation at signal approaches.
- It reproduces "stop-and-go traffic within moving queues" as aggregate dynamics.
- Originally scoped to a single-entrance/exit highway; later extended to networks (the
  lineage that leads to SUMO MESO).

**Macroscopic Fundamental Diagram (Geroliminis & Daganzo)** — the network-level
analytical view ([SAGE 10.3141/2260-02](https://journals.sagepub.com/doi/10.3141/2260-02)):
- A well-defined MFD relating **total time spent vs total distance traveled** across a
  freeway network exists and is reproducible across days — but only under the
  "stringent single-regime condition" (all lanes on all links either congested or
  uncongested).
- It "can be estimated with data from ordinary loop detectors, provided that every link
  … has at least one detector station" and data are filtered to the single-regime
  requirement. Holds for networks of any size, even inhomogeneously congested.
- Implication: an MFD scatter is a legitimate live network-health panel if we have
  edge-level speed/flow (which meandata gives us — §2).

**What is native vs not-meaningful in a meso step:**
| Native (per edge/segment/interval) | Not meaningful in meso |
|---|---|
| density (veh/km), occupancy (%) | exact vehicle x/y |
| mean (space-mean) speed | instantaneous vehicle speed/accel |
| flow / discharge, counts in/out | car-following gaps |
| queue length / segment jam state | lane position, lane changes |
| link travel time (estimated) | per-lane detail (see §2) |

---

## 2. What SUMO MESO produces and how it differs

Primary source: [SUMO MESO docs](https://sumo.dlr.de/docs/Simulation/Meso.html),
[meandata docs](https://sumo.dlr.de/docs/Simulation/Output/Lane-_or_Edge-based_Traffic_Measures.html),
[TraCI/Python](https://sumo.dlr.de/docs/TraCI/Interfacing_TraCI_from_Python.html), and
an academic critique [arXiv 2606.09282](https://arxiv.org/html/2606.09282).

**Internal model:**
- "Each edge is split into 1 or more queues of equal length" with max length set by
  `--meso-edgelength` (**default 100 m**). Vehicles are "placed in traffic queues,"
  not at continuous positions.
- Movement is "governed by dynamic headways between edges" — event-based queue
  discharge, not continuous car-following.
- "Meso vehicles do not model their current speed. Therefore vehicle attributes
  concerning acceleration, departSpeed or arrivalSpeed take no effect." Any speed you
  read is an **estimated segment average** derived from the computed segment-leave time.
- **Lanes are not distinguished** (except some turn lanes at junctions). "No lane
  specific output is possible" — `laneData` is treated as `edgeData`. One `e1Detector`
  per edge captures all available data; **E2 (lane-area) and E3 (multi-entry/exit)
  detectors are unsupported** in meso.
- TLS effects are modeled as **penalties**, not physical stopping:
  `travelTimePenalty = p * (redTime² + redTime) / (2 * cycleTime)`, plus a flow penalty
  that reduces max flow by the green-time proportion. (This is why our run sets
  `--meso-tls-flow-penalty 0` — we control the signals live and don't want double
  penalisation.)

**Academic critique — MESO's fidelity limits** ([arXiv 2606.09282](https://arxiv.org/html/2606.09282)):
- MESO "does not fully comply with the … Lighthill-Whitham-Richards (LWR) model,"
  citing a "problematic integration of concepts in [the] cell transmission model (CTM)
  and link transmission model (LTM)."
- Backward-traveling space is only activated from the jam-jam condition, so "the
  accumulation of queues in the upstream segment is delayed," producing "unrealistic
  density fluctuations."
- **MESO "generally underestimates the magnitude of congestion,"** including upstream
  densities at bottlenecks. → treat meso congestion visuals as directionally right but
  optimistic; validate against micro (§5).
- The paper's own primary analysis output is edge-level aggregated density — reinforcing
  that link-level state is the right visualization primitive.

**The API in meso (libsumo):**
- `import libsumo as traci` is "the same API as TraCI" but in-process (no socket) and
  "almost always better to use … if performance is an issue and you don't need a GUI."
  This is exactly websumo's backend.
- `traci.vehicle.getPosition(vehID)` still works in meso — but given the model above,
  it returns an **approximate placement within a 100 m queue segment**, not a simulated
  location. This is the crux: our current per-vehicle polygon rendering is drawing
  cosmetic placements when `SIM_MESO=1`.

**Outputs that ARE meaningful in meso (`meandata` / edgeData):**
Per configurable interval, `edgeData` natively gives mean speed, **density (veh/km)**,
**occupancy (%)** ("100 would indicate vehicles bumper to bumper"), travel time,
waiting time, and counts (entered/left/departed/arrived). Caveats that a live viewer
must handle:
- `speed` is **space-mean-speed**; `traveltime` is "just an estimation based on the
  mean speed," not trajectory-measured.
- When an edge collected no vehicles in an interval, `speed`/`traveltime`/`density`/
  `occupancy`/`waitingTime` are **omitted** — render "no data / uncongested," don't
  assume every edge always has metrics.
- Enabled via an additional-file: `<edgeData id="…" file="…"/>` loaded with
  `--additional-files`, aggregated over `begin`/`end`.

**[REFUTED]** *"meandata `waitingTime` is directly usable as a queue/congestion
indicator at signal approaches for meso."* — Killed 1–2 on adversarial check. The
attribute exists, but halting is defined by `speed < speedThreshold`, and meso vehicles
**don't model instantaneous speed** — so the halting/waiting measure is not reliably
populated/meaningful in meso the way it is in micro. Use density/occupancy and queue
state for approach congestion instead, and verify what meso actually emits before
relying on `waitingTime`.

---

## 3. How mesoscopic sims are typically visualized (tools)

The consistent pattern across tools: **color the network, animate it over time, and
show queues as link-level annotations** — not individual cars.

**Aimsun Next** ([docs.aimsun.com](https://docs.aimsun.com/next/26.0.0/UsersManual/MapOutputs.html)):
- Section-level (link) outputs are shown by **color-coding + variable bar width** keyed
  to speed, density, flow/capacity, delay. The Density view "shows the density … as a
  legend and as a colored width where a wider line shows higher density."
- A **flow-to-capacity (v/c)** view "show[s] where capacity is close to the limits" — a
  standard LOS choropleth.
- **View Styles** map arbitrary attributes to color / bar width / glyphs (e.g. "50 km/h
  in red, 60 km/h in blue," "bars of 3 m width … density of 1,000 … 6 m … 2,000").
- **Queues** are visualized at the section level: "marks those sections with a virtual
  queue with a color and … a label to show the size of the queue" — *not* individual
  queued vehicles.
- Time-based **animation**: a Play button "show[s] how the road network conditions vary
  with time."

**UXsim** (mesoscopic, [analyzer API](https://toruseo.jp/UXsim/docs/_autosummary/uxsim.analyzer.Analyzer.html)) — a clean menu of the standard meso visualizations:
- `time_space_diagram_traj()` — time–space diagram of vehicle **trajectories** per link.
- `time_space_diagram_density()` — time–space diagram of **density** per link.
- `macroscopic_fundamental_diagram()` — MFD over provided links.
- `network_anim()` — animate the whole network's traffic states over time (color links
  by congestion), *rather than exact per-vehicle positions*.
- `cumulative_curves()` — cumulative count vs time + derived travel times per link.

**Takeaway set of primitives** (what to steal): link choropleth (speed/density/occupancy/
v-c), bandwidth ribbons (width ∝ flow), time–space diagrams per corridor, segment/cell
occupancy heatmaps, per-approach queue indicators, MFD and cumulative-curve panels.

---

## 4. Best-suited methods for websumo

Context: Python `libsumo` in-process → per-step snapshot → NATS → deck.gl + MapLibre
(GL, geographic lon/lat), currently per-vehicle polygons from `getPosition()` at ~10 Hz;
`SIM_MESO=1` runs the same net+demand ~100–175× faster for the OC adaptive-signal /
ATSPM demo.

**Recommendation: for meso runs, switch the primary layer from glyphs to an edge
choropleth.** deck.gl supports this directly:
- **`PathLayer`** "renders lists of coordinate points as extruded polylines with
  mitering" — one path per SUMO edge geometry. `getColor` is per-object ("rgba … 0–255"),
  so color each edge by meso mean-speed/density. `getWidth` is per-object in meters (with
  `widthMinPixels`/`widthMaxPixels` clamping) so width can encode flow while staying
  legible across zoom. ([PathLayer docs](https://deck.gl/docs/api-reference/layers/path-layer))
- **`HeatmapLayer`** — "continuous density visualization" for segment/cell occupancy.
- **`TripsLayer`** — "animated path trails" (`currentTime` playhead, `trailLength`,
  `fadeTrail`; inherits PathLayer) for an animated *flow* impression along links without
  claiming exact positions. Note: timestamps are **32-bit floats**, so raw Unix epoch
  loses precision — use sim-relative time. ([TripsLayer](https://deck.gl/docs/api-reference/geo-layers/trips-layer))
- deck.gl composites onto the same WebGL canvas as MapLibre and takes lon/lat accessors
  (`d => [d.longitude, d.latitude]`), so this drops into our existing map.

**Performance guidance for a ~10 Hz stream** ([deck.gl perf](https://deck.gl/docs/developer-guide/performance)):
- **Reuse a fixed set of layers and update `data` props** — "adding new layers will end
  up killing performance much … faster than squashing the data into a single layer."
  There's also a **255-layer pickability limit** (per-item layers break tooltips/clicks).
- Edge **geometry is static**; only colors/widths change per step. Use **`updateTriggers`**
  so deck.gl invalidates only the changed attributes ("if object positions have not
  changed, it will be a waste of time to recalculate them"). Consider `_dataDiff` and/or
  TypedArray attributes for the color buffer.
- Prefer thin colored **lines over large per-vehicle polygons** at scale: fragment-shader
  cost scales with rendered pixel area. (Headroom is large regardless —
  `ScatterplotLayer` holds 60 FPS to ~1M items — so glyphs remain fine as an *overlay*.)
- GPU attribute transitions ('interpolation'/'spring') can smooth color/width between
  successive snapshots so a 10 Hz stream doesn't look steppy.

**[REFUTED]** *"The dominant CPU cost is calling accessors, so minimizing accessor
recomputation is THE key optimization."* — Killed 1–2 as an overgeneralization. The
"99% of buffer-update CPU is accessors" quote is real, but that's buffer-update cost
specifically, not total frame cost; don't treat accessor-trimming as the single lever.

**Glyphs, honestly labeled:** keep an optional vehicle overlay for intuition, but badge
it "approximate (meso segment placement)" so it's never read as ground truth. The demo's
credibility depends on not implying position fidelity meso doesn't have.

**OC / ATSPM angle — the important nuance:**
- Meso is *good* for signal-control demos where the operative measure is **queue length /
  approach occupancy / discharge**. A kinematic-wave meso model can "obtain space
  occupancy of the entire approach link using real-time demand … detected in a certain
  detection area," and its "fast running time and accurate traffic simulation … enable
  the stable calculation of optimal [signal control]." Field-validated in Seoul, it
  "improved [average queue length] by up to 11.4%," and meso is explicitly argued to suit
  **oversaturated** conditions where step-based micro control struggles.
  ([Eng. Applications of AI](https://www.sciencedirect.com/science/article/abs/pii/S0952197623011892),
  [SAGE 03611981241258985](https://journals.sagepub.com/doi/10.1177/03611981241258985))
- BUT **true ATSPM MOEs are a microscopic artifact.** The "ATSPMs-in-the-loop" digital
  twin couples **PTV VISSIM (microscopic)** and parses output "to ATSPM-compliant traffic
  signal events and vehicle waypoints." Standard ATSPMs (Approach Delay, Purdue Split
  Failure, Phase Termination, Approach Volume in 15-min bins, Purdue Coordination Diagram
  / Link Pivot) are aggregated event/count/timing measures that assume high-resolution
  arrivals-on-green — i.e. per-vehicle waypoints meso doesn't produce.
  ([SmartS ATSPM list](https://www.smatstraffic.com/blog/13-common-atspms))
- **So:** use meso for the fast, live *queue/discharge* story and OC control loop; if we
  want genuine ATSPM diagrams (PCD, split-failure), generate those from a **micro** run
  (or a micro "confirmation" pass), not meso.

---

## 5. Practical steps to experiment

Incremental, cheapest-first:

1. **Pull edge-level state, not positions.** Add an `<edgeData>` additional-file
   (short interval), or better for live: query per-step edge state through libsumo
   (`edge` domain — mean speed / occupancy / vehicle count / last-step halting) so we
   stay in the existing in-process step loop rather than reading files. Verify exactly
   which `edge` getters return non-trivial values under `--mesosim` before wiring the UI
   (the meso speed is a segment average; halting may be empty — see the REFUTED note).
2. **Stream it on the existing NATS snapshot channel.** Add an `edges: [[edgeId, speed,
   density/occupancy, count], …]` array alongside (or instead of) `vehicles` when in meso
   mode. Edge geometry is static → send it once (or key by a network hash the client
   already has), stream only the scalars per step.
3. **Prototype the deck.gl `PathLayer` choropleth.** One path per edge from the net
   geometry (we already project lon/lat); `getColor` = speed→color ramp (LOS palette),
   `getWidth` = flow. Put the changing scalars behind `updateTriggers`; keep geometry
   immutable. This is the single highest-value view.
4. **Add per-approach queue indicators.** At controlled junctions, draw a bar/label per
   incoming edge sized by queue length or occupancy (Aimsun's "virtual queue" pattern).
   This is what the OC demo actually wants to show.
5. **Demote glyphs to an optional overlay**, badged "approximate," toggled off by default
   in meso mode.
6. **Validate against micro.** Run the same net+demand in micro and compare edge
   density/occupancy and junction queues over time. Expect meso to **underestimate
   congestion magnitude** and **delay upstream queue build-up** (per arXiv 2606.09282) —
   quantify the gap so the demo's claims are honest.
7. **Later / larger:** time–space diagram panel per corridor, an MFD scatter as a
   network-health widget, cumulative-curve panel per approach. These are analysis panels,
   not map layers, and can be added independently.

**Pitfalls to keep in mind:**
- Meso `getPosition` glyphs are misleading if presented as real positions.
- Segment granularity (100 m default) bounds spatial resolution — sub-segment queue
  detail isn't there; tune `--meso-edgelength` only with care.
- Junction/TLS modeling is penalty-based and lanes are merged — don't promise lane-level
  or turn-movement fidelity from meso.
- meandata attributes vanish on empty edges — handle missing values.
- Meso underestimates congestion — annotate accordingly.

---

## Sources

Primary — theory: [Daganzo CTM (TRID 412943)](https://trid.trb.org/view/412943) ·
[Geroliminis & Daganzo MFD (SAGE)](https://journals.sagepub.com/doi/10.3141/2260-02) ·
[Meso LTM/LWR critique (arXiv 2606.09282)](https://arxiv.org/abs/2606.09282)

Primary — SUMO: [MESO](https://sumo.dlr.de/docs/Simulation/Meso.html) ·
[meandata / edge-lane measures](https://sumo.dlr.de/docs/Simulation/Output/Lane-_or_Edge-based_Traffic_Measures.html) ·
[TraCI from Python](https://sumo.dlr.de/docs/TraCI/Interfacing_TraCI_from_Python.html) ·
[sumo-user list on meso detectors](https://www.eclipse.org/lists/sumo-user/msg10351.html)

Primary — tools: [Aimsun Next Map Outputs](https://docs.aimsun.com/next/26.0.0/UsersManual/MapOutputs.html) ·
[UXsim Analyzer](https://toruseo.jp/UXsim/docs/_autosummary/uxsim.analyzer.Analyzer.html)

Primary — deck.gl: [PathLayer](https://deck.gl/docs/api-reference/layers/path-layer) ·
[Performance](https://deck.gl/docs/developer-guide/performance) ·
[TripsLayer](https://deck.gl/docs/api-reference/geo-layers/trips-layer) ·
[Animations & transitions](https://deck.gl/docs/developer-guide/animations-and-transitions) ·
[layer-per-update discussion](https://github.com/visgl/deck.gl/discussions/6274) ·
[deck.gl + MapLibre guide](https://noodles.gl/users/deckgl-maplibre-guide/)

Primary — meso signal control / ATSPM: [Meso-model TSC (Eng. Applications of AI)](https://www.sciencedirect.com/science/article/abs/pii/S0952197623011892) ·
[RL-TSC meso (SAGE)](https://journals.sagepub.com/doi/10.1177/03611981241258985) ·
[ATSPMs-in-the-loop (arXiv 2606.09282 family)](https://arxiv.org/html/2606.09282) ·
[13 common ATSPMs (SMATS)](https://www.smatstraffic.com/blog/13-common-atspms)

_Verification: 23/25 sampled claims confirmed 3-0 or 2-1; 2 killed (flagged **[REFUTED]**
above). Generated via the deep-research workflow, run `wf_652eaa68-816`._
