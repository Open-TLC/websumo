# Visualizing signal-control operations — methods to adopt in OC/WebSUMO

*Implementation-oriented survey. Deep-research pass 2026-08-17: 5 angles, 23
primary/authoritative sources, 101 claims extracted, 25 adversarially verified
(22 confirmed, 3 refuted). Grounded against our stack (React + deck.gl + MapLibre
+ NATS live streams of `group.status` / `detector.status` / `clockwork.status` /
`group.e3`). Companion to `SOTA_TRAFFIC_SIM_COMPARISON.md` and
`OC_ELEMENTS_DISPLAY_PLAN.md`.*

---

## 0. TL;DR — the one big answer

Every state-of-the-art signal-operations visualization traffic engineers actually
use comes from **one family: ATSPM (Automated Traffic Signal Performance
Measures)**, and they are all computed from **one enabling input: a
high-resolution, time-stamped controller event log** — detector on/off and phase
change-to-green/yellow/red events logged at **0.1 s / 10 Hz** (FHWA EDC-4; NCHRP
812 Signal Timing Manual; UDOT ATSPM). **OC already emits functionally this
stream over NATS** (`group.status`, `detector.status`, `clockwork.status`).

So the move is unambiguous and plays exactly to our differentiator:

1. **Build live ATSPM-style diagrams off the NATS event stream.** A **live ring
   diagram is the canonical primary operator view** — it's literally the Econolite
   Cobalt controller's default power-on screen. Start there.
2. **Standardize + persist OC's hi-res event log** onto the **FHWA/Purdue
   enumerated event codes** (the "2012 controller event-code standard"). This is
   the keystone dependency — it lets existing open ATSPM libraries consume OC
   directly and unlocks the whole diagram family at once.
3. **Reuse the open, Apache-2.0 ATSPM codebases** rather than reinventing:
   UDOT ATSPM (algorithms + the event-code standard) and the `ShawnStrasser/atspm`
   Python library (a concrete ingestion + measure contract our FastAPI can feed
   from NATS).
4. **On "automatic parameter-setting with explainable viz":** feasible **but not
   the way the hype suggests.** The ML/RL-explainability evidence was **refuted**
   (see §4) — do **not** build an "attention-weights-as-explanation" UI on that
   basis. The credible pattern is **ATSPM-performance-flagging → classic
   retiming heuristics**, with the *diagram itself* as the explanation.
5. Good news on tech: the deck.gl performance rule for live streaming
   (**use `updateTriggers`, don't swap the `data` prop**) is **already how our OC
   overlay is written** — we're on the right track.

---

## 1. Catalog of signal-operations diagrams (Q1)

All of these are computed from the hi-res event stream. "Live?" = can run
streaming (not just post-hoc). Effort = on our React/deck.gl/D3 stack.

| Diagram | Encodes | Needs (OC data) | Live? | Browser build | Priority |
|---|---|---|---|---|---|
| **Ring-and-barrier diagram** | Phase structure: ring = conflicting-phase sequence, dual-ring = concurrent compatible phases, barrier = where both rings must end together | `clockwork.status` (phase) + `group.status` (per-index state) + static ring/barrier config | ✅ | **M** (SVG/Canvas + countdown) | ★ **build first** |
| **Signal-state / phase Gantt timeline** | Per-group/phase state history as horizontal bars over time | `group.status` (have) | ✅ | **S–M** (timeline/Gantt) | ★ |
| **Detector-actuation strip** | Detector on/off pulses over time, per detector, aligned to phases | `detector.status` (have) | ✅ | **S** (Canvas strip) | ★ |
| **Time-space diagram** | Distance (Y) vs time (X) with green/red bands per intersection + vehicle trajectories → progression/green-band | per-intersection phase + vehicle positions (have) | ✅ | **M–L** | ★ (corridors) |
| **Split monitor** | Per-cycle green duration per phase + how it terminated | hi-res phase events | ✅ | **M** | ★ |
| **Phase-termination chart** | GapOut / MaxOut / ForceOff per cycle (why green ended) | ⚠️ needs **termination-reason** event (OC to publish) | ✅ | **M** | ★ diff |
| **Split-failure chart** | Cycles where demand exceeded capacity (occupancy at green start/end) | detector + phase events | ✅ | **M** | ★ diff |
| **Arrivals-on-green** | % vehicles arriving on green | detector + phase events | ✅ | **S–M** | ★ |
| **Purdue Coordination Diagram (PCD)** | Setback-detector arrivals (time-of-day X, time-in-cycle Y) vs green/red lines → coordination quality | ⚠️ needs **advanced/upstream (setback) detector**; with stop-bar only, requires shockwave trajectory reconstruction | ✅ | **M–L** (+reconstruction) | ◐ (see caveat) |
| **Cyclic flow profile** | Avg arrivals across the cycle | detector + cycle boundaries | ✅ | **S–M** | ○ |
| **Flow-vs-occupancy / fundamental diagram** | Flow vs occupancy scatter per detector | detector counts/occupancy | ✅ | **S** | ○ |
| **Queue / delay / LOS spatial heatmap** | Per-approach queue/delay coloured on the map | libsumo getters (have) | ✅ | **M** (deck.gl) | ★ (from prior report) |

**Ring-barrier** (verified 3-0): *"A ring shows a sequence of conflicting phases.
Dual-ring allows compatible phases concurrently. A barrier is the point at which
phases in both rings must end simultaneously; barriers typically separate major
and minor street phases."* OC's `clockwork.status` + `group.status` **is exactly
this data** — it's the most natural primary live view.

**PCD caveat (verified 3-0):** the PCD needs an **upstream/setback detector**. If
OC only has stop-bar detection, upstream arrivals must be reconstructed with a
**shockwave / trajectory-reconstruction algorithm** — real extra work. Hence PCD
is ◐ (deprioritize unless OC exposes setback detectors — [open question 1](#open-questions)).

---

## 2. How real tools visualize live operations (Q2)

- **Live ring diagram = the canonical operator view (verified 3-0).** Econolite
  **Cobalt** Quick-Start (verbatim): *"After connecting power to Cobalt, you see
  the Signal Status screen… a Ring Diagram that shows intersection status in real
  time."* The default power-on display *is* a live ring diagram. That validates
  building ours first. *(Caveat: one controller generalized; vendor doc =
  feature-existence, not UX quality.)*
- **ATMS central systems** (Econolite **Centracs**, verified 3-0): *"Heat map for
  device performance,"* *"Hot spots for quick issue identification,"* *"System
  performance dashboard,"* *"High-resolution data collection,"* *"Real-time and
  historical analysis,"* *"Automatic detector health analysis."* → live map heat
  maps + hot-spots + dashboards are the norm.
- **ATSPM dashboards** (FHWA/UDOT): the visual-aid suite listed in §1, computed
  from hi-res controller data, used for retiming and asset management.
- **Adaptive systems** (SCATS/SCOOT/InSync): operator displays exist but logs
  often aren't ATSPM-native — hence the translator pattern (§5).

**What operators value:** live intersection state (ring diagram), detector calls,
phase countdown, coordination status; and for management, performance heat maps /
hot-spots that flag where to intervene.

---

## 3. Live / streaming techniques + browser libraries (Q3)

- **Data cadence:** the enabler is the **hi-res event log at 0.1 s / 10 Hz**.
  OC's NATS streams are at this granularity already. For *post-hoc/aggregate*
  measures, ATSPM tooling bins (default **15 min**, configurable).
- **deck.gl performance rule (verified 3-0, and we already follow it):** *"When
  the `data` prop changes, the layer recalculates all GPU buffers… the most
  expensive operation."* Use **`updateTriggers`** to recompute only the changed
  accessor (e.g. colour) on high-cadence updates — **exactly how our OC stopline/
  group layers are written.** Keep it that way for live diagrams.
- **Library fit (our stack):**
  - Ring-barrier, phase Gantt, detector strips, split monitor → **SVG/Canvas +
    D3 scales** (React components); cheap, crisp, text-friendly.
  - Time-space diagram → **D3** (trajectories + bands) or deck.gl if we want it
    map-linked; moderate.
  - PCD scatter → **Canvas/WebGL** (many arrival dots) via deck.gl
    `ScatterplotLayer` or a D3+Canvas hybrid.
  - Map overlays (queue/delay heatmap, detector-on-map) → **deck.gl** (have).
  - Streaming charts: keep a **ring buffer** of recent events client-side; append
    with `updateTriggers`, never full re-data.

---

## 4. Automatic parameter-setting — the honest finding (Q4)

**Do not build an ML/RL "explainable auto-tuning" UI on the strength of this
research.** Three ML claims were **refuted**:
- ❌ "entity-centric RL affinity matrix quantifying phase→approach influence"
  (1-2),
- ❌ "attention weights serve as an explainability visualization that aligns with
  traffic-engineering principles / audits RL decisions" (**0-3**),
- ❌ "ATSPM integrates Wavetronix/Autoscope/INRIX multi-sensor fusion to drive
  measures" (1-2).

So there is **no verified evidence** here supporting an attention-as-explanation
auto-tuning UI. Treat "automatic parameter setting with explainable
visualization" as **unproven by this evidence base** — flag it as a research
risk, not a build item.

**The credible, verifiable pattern instead:** ATSPMs enable **retiming based
directly on measured performance** (FHWA EDC-4: *"signal retiming… based directly
on actual performance without dependence on software modeling or expensive,
manually collected data"*), with 24/7 monitoring. So the realistic "auto-suggest"
loop for OC is:

> **ATSPM performance-flagging → classic heuristic suggestion → the diagram is
> the explanation.** e.g. split-failure chart flags an under-served approach →
> suggest a min-green/extension bump → show the before/after split-monitor as the
> "why." No black-box ML; the visualization *is* the explanation. This is
> feasible on our stack and honest.

---

## 5. Reusable open-source (the big shortcut) (Q5-adjacent)

Two Apache-2.0 / open codebases are directly reusable and license-compatible:

- **UDOT ATSPM** (`udotdevelopment/ATSPM`, Apache-2.0; now maintained as
  `OpenSourceTransportation/Atspm`, forked from `utahudot/udot-atspm`) — the
  reference algorithms **and the enumerated controller-event-code standard**
  (Purdue + Indiana DOT, 2012). Adopt the event codes.
- **`ShawnStrasser/atspm`** (PyPI, deployed at Oregon DOT since 2024) — a Python
  library with a **concrete ingestion contract our FastAPI can target**: inputs =
  *ATC hi-res event logs* (CSV/Parquet/JSON **or Pandas DataFrames**) + a
  **detector-to-phase config**, configurable binning (default 15 min),
  **incremental/real-time processing**. Computes ~14 measures (arrivals-on-green,
  split failures, terminations GapOut/MaxOut/ForceOff, detector actuations,
  event-level timeline, etc.).

**Translator precedent:** where adaptive-system logs aren't ATSPM-native (SCATS,
InSync), NJDOT's ATSPM 1.0 **translates proprietary events into the FHWA/Purdue
enumerated codes** (e.g. "Phase Begin Green" → code 1). **OC should publish its
hi-res log already in those enumerations** so it plugs straight into `atspm` — no
translator needed. This is the single highest-leverage OC-side change.

---

## 6. Recommended build order — value × effort (Q6)

Mapped to our stack + the OC data each needs. ★diff = differentiator for an open,
live, browser-native, real-adaptive-controller tool.

| # | Build | Data (have / OC-to-publish) | Effort | Value | Notes |
|---|---|---|---|---|---|
| 1 | **Live ring-barrier diagram + phase countdown** | have (`clockwork.status`, `group.status`) + static ring config | **M** | ★★★ | The canonical operator view; builds on the phase HUD we shipped |
| 2 | **Detector-actuation strip + phase Gantt timeline** | have (`detector.status`, `group.status`) | **S–M** | ★★★ | Cheap, high signal, live |
| 3 | **OC hi-res event log in FHWA/Purdue enumerated codes over NATS** (+ persist) | ⚠️ **OC to publish** (phase on/off, detector on/off, **termination reason**) | **M** (OC-side) | ★★★ | **Keystone** — unlocks 4–7 and the `atspm` library |
| 4 | **Split monitor + split-failure + phase-termination charts** | needs #3 | **M** | ★★★ | ★diff — ATSPM-grade, live |
| 5 | **Queue/delay/LOS map heatmap** | have (libsumo) | **M** | ★★★ | From the prior report; deck.gl |
| 6 | **Time-space / coordination diagram** | have (phase + vehicles) | **M–L** | ★★ | ★diff for corridors |
| 7 | **ATSPM backend via `ShawnStrasser/atspm`** (FastAPI reads #3 → measures API) | needs #3 | **M** | ★★ | Reuse, don't reinvent |
| 8 | **Purdue Coordination Diagram (PCD)** | ⚠️ needs setback detectors *or* shockwave reconstruction | **L** | ★★ | ◐ deprioritize unless upstream detection exists |
| 9 | **ATSPM-flag → heuristic retiming suggestion** ("diagram is the explanation") | needs #3/#4 | **L** | ★★ | ★diff; the *honest* "auto-suggest" (not ML) |

**Direct answers to your leads:**
- **Live diagrams (ring-barrier, detector strips, time-space, PCD)?** → **Yes —
  the right move,** validated by real controllers (Cobalt's live ring diagram)
  and central systems. Ring-barrier + detector strips first; PCD last (detector
  dependency).
- **Automatic parameter setting with explainable visualization?** → **Feasible
  but not via ML-explainability (refuted).** Do **ATSPM-flag → classic heuristic
  suggestion**, using the before/after diagram itself as the explanation.
- **What else?** Phase Gantt timelines, split/split-failure/termination charts
  (our ATSPM differentiators), a queue/delay heatmap, and **record/replay** of
  the NATS stream (pairs naturally with all diagrams). Glyphs/small-multiples:
  unsupported by this evidence — skip for now.

---

## 7. Caveats & open questions

**Confidence:** strong on the diagram catalog, the hi-res-data enabler, "live
diagrams are the right move," the reusable open-source, and the deck.gl perf
rule (all 3-0). **Weak/refuted** on ML/RL explainable auto-tuning (§4) and on
novel glyph/small-multiple methods (essentially unsupported here). Vendor docs
(Cobalt, Centracs) are feature-existence only, not UX-quality evidence.

<a name="open-questions"></a>**Open questions (resolve before building the detector-dependent items):**
1. **Does OC expose upstream/setback detectors, or only stop-bar?** Determines
   whether the PCD is cheap (#8) or needs shockwave reconstruction.
2. **Exact mapping** from `group.status` / `detector.status` / `clockwork.status`
   → FHWA/Purdue enumerated event codes (and does OC know **termination reason**
   GapOut/MaxOut/ForceOff, needed for the phase-termination chart? If not, that's
   an OC-side addition).
3. **Per-diagram library choice** (D3 vs deck.gl vs Gantt lib vs Canvas) and the
   NATS cadence/downsampling to stay inside the `updateTriggers` performance
   envelope.

## Primary sources
- FHWA EDC-4 ATSPM factsheet: https://ops.fhwa.dot.gov/arterial_mgmt/pdfs/EDC-4-Factsheet_ATSPMs.pdf
- NCHRP 812 Signal Timing Manual (ring-barrier, TSD, PCD defs): https://transops.s3.amazonaws.com/uploaded_files/Signal%20Timing%20Manual%20812.pdf
- UDOT ATSPM (Apache-2.0, algorithms + event codes): https://github.com/udotdevelopment/ATSPM · https://github.com/OpenSourceTransportation/Atspm
- `ShawnStrasser/atspm` (ingestion + measure library): https://github.com/ShawnStrasser/atspm
- Purdue JTRP 315 (cycle-by-cycle measures from hi-res data): https://docs.lib.purdue.edu/jtrp/315/
- FHWA ATSPM (split monitor + PCD from controller data): https://rosap.ntl.bts.gov/view/dot/64469/dot_64469_DS1.pdf
- NJDOT ATSPM translator (SCATS/InSync → enumerated codes; PCD reconstruction): https://rosap.ntl.bts.gov/view/dot/63555/dot_63555_DS1.pdf
- Econolite Cobalt Quick-Start (live ring diagram): https://www.econolite.com/wp-content/uploads/2021/10/ASC3_UM_Cobalt_Quick_Start_Guide_140-0903-003-02.pdf
- Econolite Centracs (heat maps/hot-spots/dashboards): https://www.econolite.com/solutions/software/
- deck.gl performance (updateTriggers): https://deck.gl/docs/developer-guide/performance
- Miovision TrafficLink PCD (commercial live PCD): https://help.miovision.com/s/article/Insights-Purdue-Coordination-Diagram-in-Miovision-TrafficLink-portal
