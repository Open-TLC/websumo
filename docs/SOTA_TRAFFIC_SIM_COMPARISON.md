# State of the art in traffic simulation & signal-controller integration — where OC/WebSUMO stands and what to add next

*Decision-grade comparative study. Deep-research pass 2026-08-17: 5 angles, 23
primary/authoritative sources fetched, 102 claims extracted, 25 adversarially
verified (23 confirmed, 2 refuted). Grounded against our current OC↔WebSUMO
integration (an OC-controlled SUMO rendered in the browser with a live
signal-group overlay + controller-phase HUD). Companion to
`OC_ELEMENTS_DISPLAY_PLAN.md`, `SUMO_GUI_COMMUNITY_RESEARCH.md`,
`SUMO_GUI_DROPIN_FEASIBILITY.md`.*

> **Read the caveats (§7) before acting.** The controller-integration and SaaS
> findings are strongly evidenced; the full cross-tool *feature matrix* and the
> ATSPM/standards specifics are **under-evidenced in this pass** and flagged as
> "to verify." Two attractive claims were **refuted** — noted inline so we don't
> build on them.

---

## 0. TL;DR — the blunt verdict

1. **We are not behind on architecture — we're aligned with the research
   frontier.** The commercial baseline for putting a *real* controller in a sim
   is Hardware-in-the-Loop via a physical **Controller Interface Device (CID)**.
   The SOTA research trajectory is to **replace the CID with software** —
   "Virtual-CID (VCID)" / "CID-free" frameworks that connect the controller over
   a network transport (NTCIP-over-Ethernet), eliminating dedicated hardware
   while keeping accuracy. **OC's "real adaptive controller drives the sim over a
   message bus (NATS)" is exactly that move.** This is a genuine differentiator,
   and it's *validated*, not fringe.

2. **The commercial fidelity/UX bar is real and mostly not worth chasing
   head-on.** Vissim + Econolite **ASC/3 SIL** runs the *actual field-controller
   firmware* inside the sim with the field GUI, decoupled from real time (≈10×),
   exchanging state down to 10 Hz. Matching that packaged NEMA/ring-barrier
   fidelity + multi-vendor SIL library is years of work and not our game.

3. **Our highest-value / lowest-effort wins are the signal-management
   *analytics* the incumbents charge for — and they ride naturally on OC's
   high-resolution controller event stream.** ATSPM-style performance measures,
   ring-barrier/phase diagrams, coordination/purdue diagrams, per-approach MOEs,
   and record/replay. As a *real* adaptive controller, OC can emit the
   high-resolution event log these analytics need — something a black-box
   simulator emulator can't.

4. **"Simulation-as-a-service with a data pipeline" is proven, not novel.**
   PTV **Model2Go** already builds a city model in ~1 week from HERE/TomTom/
   GTFS/OSM in the cloud; **Aimsun Live** is a deployed real-time digital twin.
   Our edge is **not** the SaaS concept — it's **openness + real-adaptive-
   controller-in-the-loop + ATSPM-grade signal analytics**, browser-native.

**Per-dimension gap verdict:**

| Dimension | Verdict | Why |
|---|---|---|
| Simulation fidelity | **Behind, but defensibly so** | SUMO trades car-following/GUI polish for runtime/memory/scale. Fine engine choice; don't try to out-Vissim Vissim. Do **not** claim SUMO fidelity parity (refuted). |
| Controller integration | **Ahead / frontier-aligned** | OC = real adaptive controller over a software bus = the VCID/CID-free direction, open and browser-rendered. |
| Visualization / analysis | **Behind on packaged analytics, but this is the closeable gap** | ATSPM/MOE/ring-barrier/coordination views are effort-reasonable on deck.gl + our event stream. |
| Usability | **Differentiated** | Browser-native, no-X11, shareable, live — where the desktop incumbents are weakest. |

---

## 1. Feature landscape & what practitioners value (Q1)

**The core axis (verified 3-0):** open simulators (SUMO, MATSim) win on
**runtime, memory, and large-scale scalability**; commercial tools (Vissim,
Aimsun) win on **GUI/result-interpretation ergonomics** and calibrated
car-following fidelity. A 2025 MDPI benchmark (*Vehicles* 5(4):201) found SUMO
and MATSim strong on runtime/memory with MATSim most scalable; a 2022 Žilina
case study comparing **Aimsun 8.2 vs SUMO 1.3.1** found *"the input and output
data are similar in both… interpretation of results is quite intuitive for
both,"* while Aimsun's GUI is friendlier — positioning SUMO as *"an effective
alternative tool for transport modeling."*

> **Implication:** SUMO is a defensible engine; the known gap is
> **GUI/result-interpretation ergonomics** — *exactly the surface WebSUMO
> addresses*. That's the strategic fit.
>
> ⚠️ **Refuted (1-2):** the companion claim that "Vissim matches real travel
> times / safe-gap better in low-density scenarios" did **not** survive
> verification. Scope the fidelity story to *runtime/memory/scalability*; do
> **not** overstate SUMO realism parity.

**What practitioners value most (authoritative anchor):** FHWA's Traffic
Analysis Toolbox Vol. III (Ch. 6) formally separates **MOEs for overall system
performance** from **MOEs for localized problems**, and **average vs worst-case**
reporting. So signal-timing/traffic-management work genuinely needs *both*
network aggregates *and* per-approach/per-movement measures — a direct spec for
what our KPI layer must let users choose.

**Cross-tool feature matrix (partial — ⚠️ under-evidenced, to finish with
primary citations; see open questions):**

| Dimension | PTV Vissim | Aimsun Next | SUMO (+ WebSUMO/OC) | MATSim | *TransModeler / Paramics / CityFlow / Flow* |
|---|---|---|---|---|---|
| Car-following fidelity / calibration | ★★★ (Wiedemann, calibrated) | ★★★ | ★★ (Krauss/others) | ★ (queue-based, meso-ish) | *to verify* |
| Signal control: actuated / NEMA ring-barrier | ★★★ (RBC, ASC/3 SIL) | ★★★ | ★★ (built-in + external via TraCI/OC) | ★ | *to verify* |
| Adaptive (SCOOT/SCATS/RHODES/…) in-loop | ★★★ (SIL/emulators) | ★★★ (API) | via **OC** (real adaptive engine) | — | *to verify* |
| Real-controller-in-the-loop (HILS/SIL) | ★★★ (ASC/3 SIL, CID) | ★★ (API) | **OC = software/bus-in-the-loop** | — | *to verify* |
| 3D / visualization polish | ★★★ | ★★★ | ★★ (deck.gl 2.5D, browser) | ★ | *to verify* |
| Live overlays / heatmaps (queue/delay/LOS) | ★★ | ★★ (Aimsun Live) | ✗ today → **build target** | ✗ | *to verify* |
| MOE / KPI reporting | ★★★ | ★★★ | ✗ today → **build target** | ★★ | *to verify* |
| Co-simulation / API | COM, ASC/3 SIL | Aimsun API/microSDK | **TraCI/libsumo + NATS bus** | Java/events | *to verify* |
| Runtime / scale | ★ | ★★ | ★★★ | ★★★ | *to verify* |
| Licensing | Commercial | Commercial | **Open (Apache/EUPL)** | Open | mixed |

*★ = relative strength from verified sources or well-known facts; blank/✗ = gap;
"to verify" cells must be filled with primary citations before this matrix is
final.*

---

## 2. Controller integration — the SOTA, and where OC sits (Q2)

This is the **best-evidenced** section and where OC is strongest.

**The recognized taxonomy (Zhong & Lee, TRB 2017; after Stevanovic et al.) —
verified 3-0:** three approaches to advanced controller-in-the-loop analysis:
- **EILS — emulator-in-the-loop** (e.g. Vissim's internal NEMA emulator). Lowest
  fidelity; *"inadequate to deliver the sophistication and verity of… physical
  controllers."*
- **SILS — software-in-the-loop** (e.g. Econolite **ASC/3 SIL**: the actual
  field-controller code as a virtual controller).
- **HILS — hardware-in-the-loop** (a real controller wired in).

**The incumbent baseline (verified 3-0):** classic HILS needs **three**
components — host + **CID (Controller Interface Device)** + real controller —
*"because signal controllers are not designed to interface with simulation
software directly… CIDs are used to convert the signal."* Running a sim with a
real controller *is* HILS.

**The SOTA trajectory — replace the CID with software (verified 3-0):**
**Virtual-CID (VCID) / CID-free** frameworks connect the real controller over
**NTCIP transported via Ethernet**, eliminating dedicated hardware while keeping
accuracy (validated on queue length, travel time, stability — often *more*
stable than a physical CID), and enabling **remote control and lower operating
cost** (Wang et al., IET ITS 2018; Zhong & Lee, TRB 2017: replace the CID with
*"an NTCIP module run concurrently on the host,"* cutting three components to
two and removing CID cost/compat problems).

**The commercial fidelity bar (verified 3-0, one sub-claim 2-1):** Vissim +
**ASC/3 SIL** runs the *same code base as the hardware controller* (same Traffic
Control Kernel, CIB/COB buffers, interchangeable database), exposes the field
GUI with live inspection, decouples from real time (**up to 10×**), and exchanges
detector/signal-head state each step **down to 10 Hz** (Econolite ASC/3 SIL
Functional Description; Zlatkovic 2009, Univ. of Utah — used ASC/3 SIL + Vissim
RBC for transit-signal-priority; corroborated by PTV's 2025 RBC docs).

**Why real-controller-in-the-loop matters (verified 3-0):** HILS is standard
practice *specifically because* it exercises firmware behaviors emulators
simplify away; validation showed *no significant MOE difference* between the
internal algorithm and the hardware-in-the-loop algorithm.
> ⚠️ **Refuted (0-3):** the stronger claim that advanced features *"cannot"* be
> evaluated in software-only sim. SILS/VCID reach high fidelity too — which
> **favours OC's software approach**, not undermines it.

### Where OC sits — verdict
OC running its **real adaptive control engine** against SUMO, over a **NATS
message bus**, rendered in a **browser**, is:
- **Above EILS** (it's a real controller, not a NEMA emulator);
- **A software/message-bus-in-the-loop variant** philosophically identical to
  the **VCID/CID-free** frontier (a software resolver over a network transport
  replacing interface hardware);
- **Differentiated** by being *open* + *browser-native* + a *real adaptive*
  controller — versus desktop-bound, single-vendor commercial SIL.

**What OC/WebSUMO lacks vs the commercial SOTA:** packaged NEMA/ring-barrier
GUI parity, a multi-vendor SIL library, and — importantly — **standards
mapping** (NTCIP 1202 / NEMA TS2 / ATC 5201, and SPaT/MAP J2735 for
connected-vehicle). To interoperate with real roadside kit and CV SPaT feeds,
OC's bus interface should eventually map to / emit these (open question).

---

## 3. Gap assessment (Q3) — see the verdict table in §0

- **Fidelity — behind, don't chase.** Vissim's calibrated Wiedemann
  car-following + 3D is years of engineering. SUMO's engine is a deliberate,
  defensible trade (scale/runtime/open). Not our differentiator.
- **Controller integration — ahead / frontier-aligned.** Our strongest card.
  A *real, open, adaptive* controller over a software bus is where the field is
  going. Lean in.
- **Visualization/analysis — behind on *packaged analytics*, but this is the
  closeable gap.** We have live rendering; we lack MOE/ATSPM/ring-barrier/
  coordination views. These are effort-reasonable on deck.gl + our event stream.
- **Usability — differentiated.** Browser, no-X11, shareable, live. The
  incumbents are desktop-bound; this is our natural advantage (and the whole
  reason WebSUMO exists).

---

## 4. Simulation-as-a-service landscape (Q4)

**Proven and crowded at the top (verified 3-0):**
- **PTV Model2Go** — *"a cloud-based process"* that *"delivers a basic
  transportation model of any city… in just one week,"* ingesting HERE/TomTom
  road networks, GTFS transit, OSM bike networks, and generating TAZs/demand via
  *"data science algorithms"* — i.e. a **no-install, cloud-delivered
  data+model service = a data-expansion pipeline**. (Caveat: consuming the
  output Visum model still needs desktop software; and "one week" is vendor
  positioning.)
- **Aimsun Live** — *"a digital twin for real-time traffic management"* using
  live + historical data to simulate/monitor and give on-the-spot forecasts;
  deployed (Tees Valley, Greater Manchester). A decision-support **service**,
  distinct from the desktop tool.

**Adjacent:** NVIDIA Omniverse/Metropolis smart-city digital-twin blueprints
(synthetic data, OpenUSD); academic RL-signal cloud environments (sumo-rl,
RESCO) — evidence the RL-in-sim niche is active and SUMO-based.

**Verdict:** our OSM/RDF-graph→controllable-model pipeline **mirrors Model2Go's
shape**. The SaaS concept is *validated, not novel*. Differentiation must come
from: **Apache/EUPL openness**, **browser-native rendering with no desktop
dependency**, and a **real open adaptive controller in the loop** — none of which
Model2Go (planning models) or Aimsun Live (prediction twin) offers together.
**Open question:** does *anyone* couple an open data pipeline with a *real
adaptive controller in the loop*? If not, that specific position is uncontested.

---

## 5. Recommended features — ranked value × effort (Q5)

Grounded in §1–§4 and our stack (SUMO/libsumo + NATS + deck.gl browser + a real
adaptive controller). **Our differentiators are the items OC's high-resolution
event stream makes uniquely cheap for us and expensive for black-box tools.**
Effort is on our stack; dependencies flag extra OC state to publish.

| # | Feature | Value | Effort | Depends on | Diff? |
|---|---|---|---|---|---|
| 1 | **Queue / delay / LOS heatmap overlay** (per-lane/edge, live) | ★★★ #1 practitioner ask; the analysis surface incumbents sell | **M** | libsumo getters (have) + deck.gl layer | — |
| 2 | **Per-approach MOE / KPI panel** (avg + worst-case; network + localized, per FHWA) | ★★★ | **M** | libsumo aggregation; FHWA-guided UX | — |
| 3 | **ATSPM-style signal performance measures** (phase on/off %, split failures, arrivals-on-green, red/green occupancy) | ★★★ | **M–L** | ⚠️ **OC must publish a high-resolution event log** (phase change, detector actuation, coordination events) over NATS | ✅ **our differentiator** |
| 4 | **Ring-barrier / phase diagram + live phase timeline** (`current_phase` we already stream plugs in) | ★★★ | **M** | OC phase/timing (partly have; richer = OC publish) | ✅ |
| 5 | **Detector-actuation visualization** (calls/extensions animating the group they serve) | ★★ | **S–M** | detector.status (have) + OC config (have) | ✅ |
| 6 | **Record & replay / time-scrub** (persist the NATS stream, scrub in-browser) | ★★ | **M** | NATS JetStream or a recorder | — |
| 7 | **Coordination / Purdue-style diagrams** (arrivals vs green over the cycle, offsets) | ★★ | **L** | high-res event log (#3) + arrivals | ✅ |
| 8 | **Split / cycle / offset + coordination views** (multi-intersection) | ★★ | **L** | multi-controller scoping (plan §4) | ✅ |
| 9 | **Standards mapping** (NTCIP 1202 / NEMA TS2 / SPaT-MAP J2735 emit) | ★★ (interop / CV) | **L–XL** | OC bus↔standards adapter | strategic |
| 10 | **Crisp export / shareable views** (SVG/PNG, URL) | ★ | **S** | frontend only | — |

*S ≈ days, M ≈ 1–2 wks, L ≈ weeks, XL ≈ months.*

**The strategic through-line:** items **3, 4, 5, 7, 8** are **ATSPM +
adaptive-control analytics**. They are our differentiator *because OC is a real
adaptive controller* — it can emit the high-resolution event data (phase/detector
/coordination) that FHWA-grade ATSPM analytics require, which a simulator's
built-in emulator fundamentally cannot produce faithfully. The incumbents package
these as paid modules; for us they're a natural read of a stream we already
partly have. **Start with #1–#2 (immediate visible value, data in hand), then #4
(builds on the phase HUD we just shipped), then #3/#5 — which need OC to publish
a high-resolution event log** (the concrete "what extra state must OC publish"
question).

---

## 6. What this means for the plan

- The `OC_ELEMENTS_DISPLAY_PLAN.md` next-steps (P2 detectors/indicators, P3
  phase ring / controller HUD) are **directionally correct and land squarely on
  the differentiators** above (#4, #5).
- **Add a new workstream:** *"OC high-resolution event log over NATS"* — the
  single dependency unlocking ATSPM (#3), coordination (#7), and split/offset
  (#8). This is the highest-leverage OC-side ask.
- **Positioning:** don't sell "another simulator." Sell **"the open, browser-
  native, real-adaptive-controller-in-the-loop with ATSPM-grade live signal
  analytics, delivered as a service"** — the intersection none of the incumbents
  occupy.

---

## 7. Caveats & confidence

- **Well-evidenced (3-0):** the controller-integration taxonomy (EILS/SILS/HILS),
  the CID→VCID/NTCIP-over-Ethernet trajectory, the ASC/3-SIL fidelity bar, the
  FHWA MOE guidance, and the Model2Go/Aimsun-Live SaaS landscape. Act on these.
- **Under-evidenced (fill before final):** the full cross-tool **feature matrix**
  (TransModeler, Paramics, CityFlow, Flow specifics), the **ATSPM/Purdue tooling
  specifics**, and the **standards internals** (NTCIP 1202 / NEMA TS2 / ATC 5201
  / J2735). The §5 shortlist rests on the confirmed findings + FHWA MOE guidance
  + inference, **not** on directly verified ATSPM sources (their URLs are listed
  but their claims were budget-dropped from the verified set).
- **Refuted — do not repeat:** (a) "SUMO matches Vissim on travel-time/safe-gap
  fidelity in low-density" (1-2); (b) "advanced controller features *cannot* be
  evaluated in software-only sim" (0-3 — software-in-the-loop reaches high
  fidelity, which favours OC).
- **Dated / vendor-grade:** CORSIM HILS (early 2000s), ASC/3-SIL description &
  Zlatkovic (~2009), CID/VCID papers (2017-18) — mechanisms current (confirmed
  vs PTV 2025 RBC docs) but product specifics may have moved. Econolite's
  "guarantees identical behavior" and Model2Go's "one week" are best-case vendor
  claims.

## Open questions (next research, before committing build effort)
1. **ATSPM state:** what exactly must OC publish (phase on/off, detector
   actuations, coordination events) to drive FHWA/UDOT ATSPM + Purdue
   coordination diagrams? Can the control engine already emit a high-res event
   log?
2. **Complete the matrix:** signal-control modeling + API for TransModeler,
   Paramics, CityFlow, Flow, MATSim, with primary citations.
3. **Standards:** the NTCIP 1202 / NEMA TS2 / ATC 5201 / SPaT-MAP J2735 landscape
   OC's bus should map to / emit for roadside + CV interop.
4. **SaaS uniqueness:** does any offering couple an *open data pipeline* with a
   *real adaptive controller in the loop* (vs planning models / prediction
   twins)? If not, that position is uncontested.

## Primary sources
- Open vs commercial performance benchmark: https://www.mdpi.com/2673-7590/5/4/201
- Aimsun vs SUMO case study: http://komunikacie.uniza.sk/artkey/csl-202202-0002_traffic-simulation-with-open-source-and-commercial-traffic-microsimulators-a-case-study.php
- FHWA Traffic Analysis Toolbox Vol. III (MOEs): https://ops.fhwa.dot.gov/trafficanalysistools/tat_vol3/list_contents.htm
- CID-free HILS framework (EILS/SILS/HILS taxonomy): https://zhong-byte.github.io/doc/paper_development-of-cid-free-hardware-in-the-loop-simulation-framework-_trb2017.pdf
- Virtual-CID (NTCIP/Ethernet): https://ietresearch.onlinelibrary.wiley.com/doi/full/10.1049/iet-its.2017.0050 · https://www.researchgate.net/publication/345435807_Virtual_Controller_Interface_Device_for_Hardware-in-the-Loop_Simulation_of_Traffic_Signals
- Econolite ASC/3 SIL functional description: https://www.yumpu.com/en/document/view/24069502/asc-3-sil-functional-description-econolite
- Zlatkovic thesis (ASC/3 SIL + Vissim RBC, TSP): https://collections.lib.utah.edu/dl_files/7f/c4/7fc4824f716fda52e46ccde7e77d895643fca7ad.pdf
- HILS evaluates real firmware features: https://www.researchgate.net/publication/3931479_Using_hardware-in-the-loop_traffic_simulation_to_evaluate_traffic_signal_controller_features
- PTV Model2Go (cloud model-as-a-service): https://www.ptvgroup.com/en-us/products/ptv-model2go
- Aimsun Live (real-time digital twin): https://www.aimsun.com/aimsun-live/
- FHWA ATSPM: https://ops.fhwa.dot.gov/publications/fhwahop18048/index.htm · https://ops.fhwa.dot.gov/arterial_mgmt/pdfs/EDC-4-Factsheet_ATSPMs.pdf · https://github.com/udotdevelopment/ATSPM
- RL-signal environments (SUMO-based): https://github.com/LucasAlegre/sumo-rl · https://github.com/Pi-Star-Lab/RESCO
- Smart-city digital twins: https://developer.nvidia.com/blog/developing-smart-city-traffic-management-systems-with-openusd-and-synthetic-data
