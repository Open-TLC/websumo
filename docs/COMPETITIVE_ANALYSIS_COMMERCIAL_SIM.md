# Competitive analysis — our SUMO + browser-viewer setup vs. the commercial microsimulation market

*Decision-grade competitive study. Deep-research pass 2026-09-04: 3 focused
research streams (commercial-tool tooling depth; SUMO ecosystem tooling & web
frontends; the commercial-SUMO services/SaaS landscape), ~90 cited sources.
Grounded against our current stack: **SUMO + libsumo (headless) → NATS bus →
React/deck.gl/MapLibre browser viewer**, plus an **Open Controller** adaptive
signal engine in the loop. Companion to — and deliberately non-duplicative of —
`SOTA_TRAFFIC_SIM_COMPARISON.md` (controller-integration taxonomy, SaaS
landscape) and `OC_SIGNAL_VIZ_METHODS.md` (ATSPM viz).*

> This report answers the three questions asked: **(Q1)** how far we are from
> best-of-market in ease of use, functionality, and tooling; **(Q2)** the most
> obvious missing features if we mean to outcompete; **(Q3)** whether real
> competition already sells services/consulting/support on SUMO. Read §6
> (caveats) before acting — some capability claims are vendor-asserted, and one
> premise-level surprise (a direct SaaS competitor) reframes the whole picture.

---

## 0. TL;DR — the blunt verdict

1. **On the traffic *engine*, we are not behind.** SUMO's Krauss/IDM
   car-following and LC2013 lane-change are competitive; TransModeler itself ships
   IDM, and Aimsun uses the Gipps family. The commercial moat is **not the
   physics** — it is the *surrounding tooling*.

2. **On *tooling and ease-of-use*, an open web viewer today closes almost none of
   the commercial gap — because a viewer is a visualization layer, and the
   incumbents sell an integrated modelling *workflow*.** The real distance is:
   guided calibration (GEH/OD-adjustment), HCM level-of-service reporting
   dashboards, scenario management, signal-controller-in-the-loop (SIL/HIL),
   packaged adaptive-control emulation (SCOOT/SCATS/RBC), professional 3D, and —
   increasingly — cloud collaboration/real-time digital-twin products. We have
   **none of these**; we have live rendering, which they mostly lack.

3. **The single most important finding (Q3): the "open, browser-based
   SUMO-as-a-service" niche is already occupied — by co4e GmbH's SESAM**
   (a DLR-adjacent spin-off; cloud SUMO with a web UI, OSM import, REST API, and
   **published pricing €39/mo**). So "put SUMO in the browser" is **not**
   white-space. What is *still* uncontested is **SUMO + a real adaptive
   signal-controller in the loop, as a service** — nobody sells that.

4. **Our defensible position is narrow and specific — and it is the OC angle, not
   the viewer.** The viewer is table-stakes (and partly pre-empted by SESAM). The
   differentiator is the same one the SOTA study reached from the other side: an
   **open, real, adaptive controller over a message bus, with live ATSPM-grade
   signal analytics, browser-native**. Everything strategic points back to OC.

**Per-question one-line verdicts:**

| Question | Verdict |
|---|---|
| **Q1 — distance to best-of-market** | **Engine: ~parity. Ease-of-use/tooling: far behind** (we're a viewer; they're a modelling suite + cloud). **Usability of the *live view* itself: ahead** (browser, no-X11, shareable). |
| **Q2 — most obvious missing features** | Calibration UI, HCM/MOE reporting, in-browser editing, scenario management, controller-in-the-loop, and — our wedge — **live ATSPM/ring-barrier signal analytics**. |
| **Q3 — real SUMO-services competition** | **Thin but non-zero and pointed:** co4e/SESAM (browser SUMO SaaS) + DLR contract research + AV-sim vendors embedding SUMO. The *adaptive-control-as-a-service* lane is empty. |

---

## Q1 — How far are we from the best of the market? (ease of use, functionality, tooling)

### The honest framing: we're comparing a *viewer* to *modelling suites*
PTV Vissim, Aimsun Next, and Caliper TransModeler are end-to-end modelling
environments: import → build/edit → calibrate → run → analyse → report →
(increasingly) collaborate in the cloud. Our setup renders a running SUMO sim in
a browser. So "how far behind" splits cleanly by layer.

### 1a. Simulation engine / fidelity — **roughly at parity, defensibly so**
- SUMO: Krauss + IDM car-following, LC2013/SL2015 lane-change, actuated TLS,
  duarouter DTA, PT + pedestrians. TransModeler ships **IDM**; Aimsun is
  **Gipps**-family; Vissim is **Wiedemann 74/99** (the calibrated-fidelity
  leader). The engine is not where we lose. *(As the SOTA study already found —
  do **not** claim SUMO matches Vissim's calibrated realism; that specific claim
  was refuted there.)*
- Caveat cutting both ways: uncalibrated SUMO can misestimate volumes by >200% —
  realism is a calibration-effort question for *every* tool, open or commercial.
  [uniza case study]

### 1b. Ease of use — **we win the narrow thing, lose the broad thing**
- **Where we're ahead:** the *live view*. sumo-gui is a desktop FOX/OpenGL app
  that the SUMO docs themselves warn "will probably not work" over remote desktop;
  it needs X11. Our headless libsumo → browser path removes that entirely and is
  shareable by URL. That is a real, if narrow, usability win the incumbents don't
  have (they're all desktop-bound).
- **Where we're behind:** *everything before and after the view.* SUMO's own
  workflow is CLI-first and fragmented ("only sumo-gui and netedit have a GUI;
  all other programs must be called from the command line"), and independent
  comparisons repeatedly find "Aimsun outperforms SUMO in user-friendliness and
  network-creation efficiency." We inherit SUMO's build/calibrate/analyse
  workflow and add *no* GUI over it — we only render the running result.

### 1c. Tooling — **the widest gap; this is where the commercial money is**
Concrete capabilities the commercial suites have and our stack does **not**:

| Tooling dimension | Vissim | Aimsun Next | TransModeler | **Us (SUMO+webview)** |
|---|---|---|---|---|
| In-app network/signal **editing UI** | ✅ | ✅ | ✅ (GIS) | ✗ (SUMO netedit is desktop; our web layer only renders) |
| **Guided calibration** (GEH colour-coding, OD-matrix adjustment, GoF maps) | ✅ | ✅ (bi-level OD, WebTAG GEH) | ✅ | ✗ |
| **HCM level-of-service reporting** & MOE dashboards | ✅ (node eval, HCM) | ✅ (HCM_* tables) | ✅ (HCM 6/7) | ✗ (SUMO emits raw XML; plots are CLI matplotlib wrappers) |
| **Scenario management** (base + stacked variants) | ✅ Scenario Manager | ✅ Scenario/Experiment/Replication | ✅ | ✗ |
| **Controller-in-the-loop** (SIL/HIL, real firmware) | ✅ (Econolite ASC/3, EOS) | ✅ (SCATSim, SCOOT) | ✅ (NEMA-TS2/SDLC) | ✗ *(but see Q2 — OC is our answer here)* |
| Packaged **adaptive-control emulation** (SCOOT/SCATS/RBC/UTOPIA) | ✅ | ✅ (add-on) | partial | ✗ *(OC provides real adaptive control instead)* |
| **Professional 3D / presentation** (articulated vehicles, weather, video) | ✅ | ✅ | ✅ | ✗ (deck.gl 2.5D) |
| **Cloud collaboration / SaaS** | ✅ PTV Hub, Model2Go, Flows | ✅ Aimsun Live/myAimsun, Viewer | ✗ | partial (browser-native, but no model/versioning layer) |
| Integrated **macro/meso/micro/hybrid** | ✅ meso/hybrid | ✅ all-in-one | ✅ w/ TransCAD | ✗ (micro only) |
| **Openness / scriptability / scale / £0 licence** | ✗ | ✗ | ✗ | ✅ **our structural advantage** |

**Distance summary (Q1):** engine ~parity; live-view usability ahead; the entire
modelling-workflow tooling stack is a large, real gap. We are "far behind" only
if we intend to be a *modelling suite*. If we intend to be a *live operations /
control-visualization layer*, the gap that matters shrinks to the analytics in Q2.

### Pricing context (what "the market" charges)
Free (SUMO) → **~US$2k** entry (TransModeler SE, Aimsun Lite €2,000) → **~€7,500
/seat/yr** (Aimsun Expert) → **~£62k/yr** enterprise (one UK-county Vissim data
point). Aimsun and Caliper publish prices; PTV/Paramics/SIDRA are quote-only.
Our £0 licence is a genuine wedge — but note SESAM already prices *cloud SUMO* at
**€39/mo** (Q3), so "cheap SUMO in the cloud" is itself no longer differentiating.

---

## Q2 — The most obvious missing features to outcompete

Two tiers: **table-stakes** (needed to be taken seriously as a tool) and
**wedge** (where we can actually *win* rather than catch up). Effort is on our
stack (S≈days, M≈1–2 wks, L≈weeks, XL≈months).

### Table-stakes gaps (catch-up — necessary, not differentiating)
1. **MOE / KPI reporting panel** — per-approach + network delay, queue, stops,
   travel time, LOS; average *and* worst-case (per FHWA Vol. III). **M.** Data is
   already in libsumo getters. *This is the #1 practitioner ask and we have none.*
2. **Queue / delay / LOS heatmap overlay** (live, per-lane/edge). **M.** deck.gl
   layer + libsumo — squarely in our wheelhouse.
3. **In-browser network/signal editing** — even lightweight (signal timing, speed,
   lane edits). **L–XL.** The incumbents' biggest ease-of-use lead; also the
   hardest for us. Likely *defer* (netedit exists on desktop; see
   `NETEDIT_WEB_RESEARCH.md`).
4. **Scenario management** — base + stacked variants, compare runs. **M–L.**
5. **Guided calibration** (GEH colour-coding, OD adjustment). **L.** High value,
   high effort; probably a later phase.
6. **Record & replay / time-scrub** of the NATS stream. **M.**

### Wedge features (where we can *lead*, because OC feeds them and black-box tools can't)
These are the same conclusions the SOTA study reached from the controller side —
they converge here from the market side, which raises confidence.

7. **Live ATSPM-style signal performance measures** — phase on/off %, split
   failures, arrivals-on-green, red/green occupancy. **M–L**, and the keystone.
   *Requires OC to publish a high-resolution event log over NATS* (phase change,
   detector actuation, **termination reason** GapOut/MaxOut/ForceOff). **No
   open-source tool applies ATSPM to SUMO today** — verified negative result. This
   is the single highest-leverage build.
8. **Ring-barrier / live phase-timeline diagram** — builds directly on the
   phase HUD + signal-state timeline we already shipped. **M.**
9. **Detector-actuation visualization** (calls/extensions animating the group
   they serve). **S–M.** We already stream `detector.status`.
10. **Coordination / Purdue diagrams** (arrivals-on-green vs offset). **L.**
    Needs #7's event log.

**The through-line (Q2):** items 7–10 are **ATSPM + adaptive-control analytics**.
They are differentiating *specifically because OC is a real adaptive controller*
— it can emit the high-resolution event data that FHWA-grade analytics need,
which a simulator's built-in NEMA emulator fundamentally cannot produce
faithfully. Start with the table-stakes MOE panel + queue heatmap (immediate
visible value, data in hand), then the ring-barrier timeline (builds on shipped
work), then the OC hi-res event log that unlocks the ATSPM suite.

**Blunt strategic note:** shipping *only* the table-stakes list makes us "a free,
worse Aimsun." The wedge list is what makes us *un-substitutable* by the
incumbents — and none of it is the viewer per se; it's the controller analytics.

---

## Q3 — Is there real competition already selling services/consulting/support on SUMO?

**Yes, but the space is thin, and it splits into three occupied niches plus one
empty one.** This is the most decision-relevant section, because one finding
directly pre-empts a naïve "SUMO in the browser" pitch.

### Niche 1 — Dedicated commercial SUMO vendor: **co4e GmbH** (the one to know)
- **co4e** (Berlin; reported 2019 DLR spin-off, lead Dr. Robert Hilbrich who is
  also the Eclipse SUMO project lead) positions itself explicitly as "a
  commercial service provider for SUMO": training, consultancy, feature
  development, and project implementation. [co4e.com/sumo]
- **SESAM (by co4e) — the headline: a real, commercial, browser-based
  SUMO-as-a-service.** "A collaborative platform for building digital twins and
  mobility simulations in the cloud," SUMO engine, no local install, web UI, OSM
  import, public REST API. **Published pricing: Starter/Basic free; Premium €39/mo
  or €249/yr; Enterprise custom.** [sesam.co4e.com]
- **Implication:** the "open browser-based SUMO cloud" position we might have
  assumed was empty is **already a shipping, priced product with DLR-adjacent
  credibility.** We would be entering *against* SESAM, not into white-space. Our
  differentiation cannot be "SUMO, but in a browser" — it must be UX/rendering
  fidelity (deck.gl vs their stack) and, above all, the **adaptive-control layer**.

### Niche 2 — DLR itself (the "official" channel)
- SUMO originates at **DLR** (Institute of Transportation Systems, since 2001) and
  became an **Eclipse Foundation** project in **2018**; DLR still leads dev and
  offers **contract/collaborative research** (digital twins, agent-based
  simulation; `sumo@dlr.de`) — bespoke, not a price list. [dlr.de TS services]
- **Eclipse openMobility** working group (2019; DLR, Fraunhofer FOKUS, Bosch,
  Vector/TESIS) coordinates SUMO's roadmap. Notably, the Eclipse SUMO project
  pages carry **no SUMO-specific "commercial support / service providers"
  listing** — community support is mailing-list based. So the "official
  ecosystem" is real but not a crowded services marketplace. [projects.eclipse.org]

### Niche 3 — AV-simulation vendors embedding SUMO (background-traffic engine)
Commercial products that *embed* SUMO via co-simulation (not "SUMO as a service"):
**Cognata**, **Vector DYNA4**, **rFpro**, **MathWorks RoadRunner/Automated Driving
Toolbox**, and open-source **CARLA**'s SUMO co-sim. These monetize SUMO as a
traffic-agent feeder inside AV toolchains — adjacent to us, not competitors for a
traffic-engineering/signal-control product.

### The empty niche (our opening)
- **No one sells SUMO + real adaptive/RL traffic-signal control as a service.**
  Incumbent ATSC (SCATS, SCOOT, Econolite Centracs ~57k intersections, Yunex,
  Miovision, NoTraffic ~$90M raised, Vivacity) is proprietary, hardware-coupled,
  and **not SUMO-based**. The enormous **RL-on-SUMO research base** (SUMO-RL,
  RESCO, Flow, CityFlow) is **unproductized**. SESAM is a simulation/digital-twin
  platform, **not** an adaptive-control service. **OC + WebSUMO as an open,
  SUMO-native, hosted sim + adaptive signal control is genuinely uncontested.**
- **The catch (be honest about it):** that lane is empty *because* the durable
  value in adaptive signal control lives at the **deployment / sensor /
  controller-integration** layer — where NoTraffic and Vivacity spend heavy
  capital — not at the simulation/viewer layer. Our defensibility depends on
  bridging simulation to *real-world control*, which is exactly OC's remit and
  exactly the unsolved-in-the-open part.

### Training, conference, books (maturity signal)
- Commercial SUMO training exists (co4e; independent Udemy courses); **no official
  certification**. The **SUMO User Conference** (DLR + Eclipse, Berlin, annual
  since 2013; 2026 is Jun 1–4) with open-access proceedings (TIB, CC BY). No
  standalone commercial SUMO textbook (main reference: Krajzewicz's 2010 Springer
  chapter). *Reading:* an active open community, a **very** small commercial
  services layer — consistent with "thin but real."

---

## 3.5 — Niche areas: what's actually available for SUMO

The generic microsim core is owned (Vissim/Aimsun) and the "browser SUMO cloud"
slot is taken (SESAM). So the opportunity is in **application niches**: domains
where SUMO is genuinely usable *and* neither the commercial suites nor SESAM go
deep. A second research pass mapped eleven. Two framings matter: **(i)** SESAM is
a *delivery/UX* layer over stock SUMO — it adds **no domain modelling**, so a
domain-specialised product does not collide with it; **(ii)** SUMO "works"
almost everywhere, so the real question per niche is *crowded vs open*.

### Niche map — crowded / contested / open

| Niche | Availability | Why |
|---|---|---|
| **Signal-timing "test-before-deploy" digital twin + ATSPM analytics** | **OPEN — best fit for us** | See below. Open+vendor-neutral+sim-backed+ATSPM-fed is unoccupied; huge underserved retiming market. |
| Micromobility — **bikes & e-scooters** | **OPEN white-space** | SUMO has *no native bicycle model* (cyclists = "fast pedestrians"/"slow vehicles"); no dominant open tool; commercial suites treat it as secondary. |
| Emissions → **air-quality → exposure/health** pipeline | Thin / open at the tail | Emission *estimation* is crowded (core SUMO + Vissim EnViVer + Aimsun); the downstream dispersion→concentration→exposure chain is one tiny repo (SUMO2GRAL, ~3★). |
| **DRT / ride-pooling / MaaS dispatch** | Contested-but-viable | SUMO taxi device + TraCI dispatch hook is strong; commercial tools underinvest; open field fragmented (FleetPy, MATSim DVRP, drtOnline) — no turnkey product. |
| Mass **evacuation** (multimodal) | Open, but fights meso-DTA | No maintained SUMO-native evacuation toolkit; serious work ceded to Aimsun/Vissim mesoscopic DTA. |
| EV **charging-infrastructure planning** | Edge white-space | Base EV modelling is core/commoditised; charger-siting optimisation, SoC-curves, grid coupling remain one-off research code. |
| V2X / C-ITS | **Crowded** | Veins, Artery, Eclipse MOSAIC, ns-3/VaN3Twin actively own it. |
| AV/ADAS scenario testing | Contested | SUMO is background traffic for CARLA; opening only in the *aging SUMO↔CARLA-UE5 bridge* + criticality scenario generation. |
| Freight / **platooning / CACC** | Crowded (healthy) | Plexe ecosystem is alive (v3.2, 2025); narrow gap only in urban-freight demand / last-mile robot-drone. |
| Rail / tram signalling | **Crowded by incumbents** | OpenTrack/RailSys dominate; SUMO has no ETCS. Avoid. |
| UAM / drones | Near-empty but **mismatched** | SUMO is 2D, no flight dynamics — structurally wrong. Avoid as a standalone SUMO play. |

### The one that fits us: open, simulation-backed signal-timing (test-before-deploy)

This is where the *market data*, the *tooling gap*, and *our exact stack* line up
— and it is the same OC/ATSPM direction both prior studies reached, now with a
market underneath it.

- **The market is enormous and underserved.** ~**330,000** US traffic signals
  (FHWA), of which **under 1% run adaptive control** (FHWA EDC-1). FHWA estimates
  **~75% of signals could be improved** and that outdated timing causes **~10% of
  all traffic delay** (~300M vehicle-hours). Recommended retiming is every ~3
  years at **~$4,500/intersection**, yet "some municipalities haven't retimed for
  20 years." The adaptive-control (ATCS) market is **~$5–10B (2024), CAGR
  ~11–20%** (secondary estimates, wide variance). [FHWA HOP20002 ch2; FHWA EDC-1
  ASCT; FHWA Public Roads 2002]
- **ATSPM is descriptive-only — a confirmed gap.** The open-source, FHWA-
  distributed **UDOT ATSPM** (Apache-2.0; now `OpenSourceTransportation/Atspm`,
  active) turns high-resolution controller data into *retrospective and real-time*
  performance measures — "we can measure performance instead of predicting it."
  It has **no simulation / what-if / test-before-deploy** capability. That
  predictive loop exists only as *research* (the 2025 "ATSPMs in the Loop
  Simulation: A Digital Twin Approach", which bolts VISSIM on precisely because
  ATSPM can't do it; LIDATS live-data-to-simulator prototype). [Kittelson ATSPM
  primer; OpenSourceTransportation/Atspm; TRR 10.1177/03611981241258985; LIDATS
  PMC11174745]
- **The closed-loop twins that do exist are proprietary and hardware-tied.**
  Econolite "Virtual Simulation & Modeling" (EOS firmware + **PTV Vissim**),
  Aimsun Live / Tees Valley (+ Yunex signals), SCATS SCATSIM/WinTRAFF, NoTraffic,
  Vivacity's Dublin twin (NVIDIA+Bentley). Every one is bound to a vendor's
  controllers/sensors/cloud. [econolite.com virtual-simulation; aimsun Tees
  Valley; aldridge SCATS testing; vivacity Dublin]
- **The white-space, stated plainly:** *an open, vendor-neutral, simulation-backed
  tool that ingests real ATSPM/high-resolution controller data, lets an engineer
  test a proposed timing (or an adaptive policy) in a browser digital twin before
  deployment, and shows ATSPM-grade analytics on the simulated result.* No open
  product does this; research prototypes and closed vendor stacks are the only
  occupants.

**Why this is *our* niche specifically:** we already have the three pieces nobody
else combines openly — **(1)** an open real adaptive controller (**OC**) that can
be the policy under test *and* emit the high-resolution event log ATSPM needs;
**(2)** open simulation (**SUMO**) as the twin; **(3)** a **browser-native** live
view for the what-if. SESAM has the cloud shell but not the controller or the
signal analytics; the ATSC incumbents have the field loop but closed and
hardware-locked; ATSPM is open but descriptive-only. The intersection is empty.

### Ranked "available for SUMO" shortlist

1. **Open signal-timing test-before-deploy twin + live ATSPM analytics** — best
   fit for OC/WebSUMO; large underserved market; the white-space is specific and
   evidenced. *This is the flagship.*
2. **Micromobility (bikes/e-scooters) modelling** — clearest *generic* SUMO
   white-space; and it overlaps our existing pedestrian/bike network work
   (graph2sumo). Natural secondary vertical.
3. **DRT / ride-pooling dispatch on SUMO** — viable, commercially underinvested;
   further from our signal-control core.
4. **Emissions→air-quality→exposure pipeline** — real tail-end gap; policy/LEZ
   demand; further from our core.
5. *(Avoid: V2X, platooning, rail, UAM — crowded or structurally mismatched.)*

**Blunt read:** don't scatter across niches. #1 *is* the OC thesis with a market
attached; #2 is a genuine adjacent white-space we already have a foothold in.
Everything else is a distraction unless a specific customer pulls us there.

## 4. What this means for our strategy

1. **Stop pitching "SUMO in the browser" as the differentiator — SESAM has it.**
   The viewer is table-stakes and partially pre-empted. Lead with the controller.
2. **The defensible product is OC-shaped:** *open, real adaptive controller in the
   loop + live ATSPM-grade signal analytics, browser-native, as a service.* That
   intersection is occupied by **no one** — commercial suite, ATSC incumbent, or
   SESAM.
3. **Build order follows Q2:** MOE/KPI panel + queue heatmap (catch-up, data in
   hand) → ring-barrier/phase timeline (extends shipped work) → **OC
   high-resolution event log** (unlocks the ATSPM/coordination suite that is our
   moat). This is the same priority the SOTA study reached independently.
4. **Don't try to out-Vissim Vissim** on calibration/3D/HCM breadth, and don't
   assume the viewer alone is a business — the money and the defensibility are in
   the control layer and its analytics, which is precisely where we're already
   pointed.

---

## 5. Cross-referenced with our other studies
- `SOTA_TRAFFIC_SIM_COMPARISON.md` — reached the *same* conclusion (OC = the
  VCID/CID-free frontier; ATSPM analytics = the closeable, differentiating gap)
  from the controller-integration literature. This report corroborates it from
  the *market/tooling* side, and adds the **SESAM competitor** finding it lacked.
- `OC_SIGNAL_VIZ_METHODS.md` — the "how to build the ATSPM/ring-barrier views"
  companion for Q2 items 7–10.
- `SUMO_GUI_DROPIN_FEASIBILITY.md` / `NETEDIT_WEB_RESEARCH.md` — relevant to Q2
  item 3 (in-browser editing), the hardest table-stakes gap.

---

## 6. Caveats & confidence

- **Strongest, directly-verified findings — act on these:** (a) **co4e/SESAM** is
  a commercial browser-based SUMO cloud with real published pricing (primary
  fetch); (b) **no open-source tool applies ATSPM/PCD to SUMO output**, and **no
  SUMO↔NATS** integration is published (negative results — the wedge and the
  architectural novelty); (c) the commercial suites' **tooling** capabilities
  (calibration, HCM reporting, SIL/HIL, scenario mgmt) are broadly independently
  attested; (d) SUMO's CLI-first workflow + sumo-gui's desktop/X11 constraint
  (primary docs); (e) Aimsun's **published €2,000–7,500** pricing and the UK-county
  **~£62k/yr** Vissim data point.
- **Vendor-asserted (treat capability *breadth* with care):** much of the
  per-tool feature depth (especially Aimsun, ~90% from its own docs; Vissim/
  TransModeler breadth) is vendor-sourced. Directionally reliable, but not an
  independent benchmark.
- **Weaker / caveated:** DLR's exact service wording (dlr.de TLS-fetch failures);
  co4e's DLR-spinoff status and the Hilbrich linkage (secondary co4e/mailing-list
  pages, not the SESAM page); whether NoTraffic/Vivacity use SUMO internally
  (evidence says proprietary/unspecified); Paramics S-Paramics EOL date; forum-
  only Vissim price figures (excluded).
- **Premises corrected during research (don't repeat):** Simunto sells **MATSim**,
  not SUMO; there is no product called "Rstandd"; SUMO joined Eclipse in **2018**,
  not 2021; TransModeler has **no** documented native OSM import or SCOOT/SCATS.
- **Scope honesty:** this study weighs *tooling, usability, and the services
  market*. It does not re-derive the controller-integration taxonomy (see the
  SOTA study) and does not independently benchmark simulation accuracy.

---

## Primary sources

**Commercial tools (tooling/UX/pricing)**
- PTV Vissim signal/RBC & driving behaviour: https://blog.ptvgroup.com/en/city-and-mobility/driving-behavior-is-key-in-a-traffic-simulation/ · RBC: https://cgi.ptvgroup.com/vision-help/VISSIM_2020_ENG/
- PTV cloud layer: https://www.ptvgroup.com/en/products/ptv-model2go · PTV Hub launch: https://www.ptvgroup.com/en/company/newsroom · PTV Flows: https://www.ptvgroup.com/en/products/ptv-flows
- Vissim price data point (UK county procurement): https://www.find-tender.service.gov.uk/Notice/036537-2025
- Aimsun Next docs (calibration, control, HCM, API): https://docs.aimsun.com/next/ · editions/pricing: https://www.aimsun.com/editions/ · Aimsun Live: https://www.aimsun.com/aimsun-live/
- Caliper TransModeler: https://www.caliper.com/transmodeler/simulation.htm · traffic control (SIL/HIL): https://www.caliper.com/transmodeler/trafficcontrol.htm · pricing: https://www.caliper.com/transmodeler/pricing.htm · TsmAPIsExamples: https://github.com/Caliper-Corporation/TsmAPIsExamples
- Paramics Discovery (SYSTRA): https://www.systra.com/uk/solutions/paramics/
- SIDRA Intersection: https://www.sidrasolutions.com/ · API: https://docs.sidrasolutions.com/
- Independent comparisons: https://www.mdpi.com/2673-7590/5/4/201 · http://komunikacie.uniza.sk/artkey/csl-202202-0002_traffic-simulation-with-open-source-and-commercial-traffic-microsimulators-a-case-study.php · https://thinktransportation.net/traffic-simulations-software-a-comparison-of-sumo-ptv-vissim-aimsun-and-cube/
- FHWA MOE guidance (Vol. III): https://ops.fhwa.dot.gov/trafficanalysistools/tat_vol3/list_contents.htm

**SUMO tooling & web frontends**
- SUMO docs: https://sumo.dlr.de/docs/sumo-gui.html · https://sumo.dlr.de/docs/Netedit/index.html · https://sumo.dlr.de/docs/Libsumo.html · https://sumo.dlr.de/docs/Simulation/Output/index.html · https://sumo.dlr.de/docs/Tools/Visualization.html · https://sumo.dlr.de/docs/Basics/Basic_Computer_Skills.html
- sumo-web3d (archived 2023): https://github.com/sidewalklabs/sumo-web3d
- Eclipse MOSAIC visualizer (live, OpenLayers): https://eclipse.dev/mosaic/docs/visualization/
- sumo-to-czml (Cesium): https://github.com/tum-gis/sumo-to-czml · DTUMOS (deck.gl replay): https://github.com/HNU209/DTUMOS
- DIDYMOS-XR (web digital twin): https://didymos-xr.eu/bringing-traffic-to-life-a-web-based-traffic-simulation-for-smart-city-digital-twin/
- SUMO2Unity (native 3D): https://github.com/SimuTraffX-Lab/SUMO2Unity
- LibSignal benchmark (libsumo ~10× TraCI): https://arxiv.org/pdf/2211.10649

**Open ATSPM / signal analytics / RL-on-SUMO**
- OpenSourceTransportation ATSPM v5: https://github.com/OpenSourceTransportation/Atspm · UDOT ATSPM: https://github.com/udotdevelopment/ATSPM · ShawnStrasser/atspm: https://github.com/ShawnStrasser/atspm
- SUMO-RL: https://github.com/LucasAlegre/sumo-rl · RESCO: https://github.com/Pi-Star-Lab/RESCO · Flow: https://github.com/flow-project/flow
- Message-bus + SUMO prior art: Kafka/CrowdNav https://github.com/Starofall/CrowdNav · MQTT https://github.com/SINTEF-9012/sumo-veins-mqtt-client-linux · NATS WebSocket: https://docs.nats.io/running-a-nats-service/configuration/websocket

**Commercial SUMO ecosystem (Q3)**
- Eclipse SUMO about/project: https://eclipse.dev/sumo/about/ · https://projects.eclipse.org/projects/automotive.sumo
- Eclipse openMobility launch: https://www.globenewswire.com/news-release/2019/05/13/1822364/0/en/Eclipse-Foundation-Launches-openMobility-Working-Group.html
- **co4e (commercial SUMO provider): https://co4e.com/sumo** · **SESAM (browser SUMO SaaS + pricing): https://sesam.co4e.com/**
- DLR TS SUMO services: https://www.dlr.de/en/ts/research-transfer/research-services/sumo
- AV-sim embedding SUMO: Cognata https://www.cognata.com/blog-cognata-traffic-model-sumo-3rd-party-integration/ · Vector DYNA4 https://www.vector.com/int/en/products/products-a-z/software/dyna4/ · MathWorks RoadRunner+SUMO https://www.mathworks.com/help/driving/ug/sumo-traffic-simulation-with-roadrunner-scenario.html · CARLA https://carla.readthedocs.io/en/latest/adv_sumo/
- SUMO User Conference: https://eclipse.dev/sumo/conference/ · Proceedings (TIB, CC BY): https://www.tib-op.org/ojs/index.php/scp
- ATSC incumbents (context): Econolite Centracs https://www.econolite.com/products/traffic-control-software/ · Vivacity Smart Junctions https://vivacitylabs.com/smart-junctions-traffic-signal-control/ · NoTraffic funding https://siliconangle.com/2026/03/24/90m-funding-notraffic-will-use-ai-end-gridlock-americas-cities/

**Niche areas & signal-timing market (§3.5)**
- SUMO niche tooling (repos/status): V2X — Artery https://github.com/riebl/artery · Eclipse MOSAIC https://github.com/eclipse-mosaic/mosaic · Veins https://github.com/sommer/veins · VaN3Twin https://github.com/DriveX-devs/VaN3Twin · SUMO↔CARLA co-sim https://carla.readthedocs.io/en/latest/adv_sumo/ (broken on UE5: carla#8969) · EV/charging https://sumo.dlr.de/docs/Models/Electric.html · emissions→air quality SUMO2GRAL https://github.com/seniel98/SUMO2GRAL · pedestrians/JuPedSim https://github.com/PedestrianDynamics/jupedsim · DRT https://sumo.dlr.de/docs/Tools/Drt.html · FleetPy https://github.com/TUM-VT/FleetPy · platooning Plexe https://plexe.car2x.org/ · rail incumbents OpenTrack https://www.opentrack.ch/
- Signal market size/adoption: FHWA ~330k signals / retiming https://ops.fhwa.dot.gov/publications/fhwahop20002/ch2.htm · FHWA EDC-1 ASCT (<1% adaptive, +10% travel time) https://www.fhwa.dot.gov/innovation/everydaycounts/edc-1/asct.cfm · FHWA Public Roads 2002 (~75% improvable, ~10% of delay) https://cms8.fhwa.dot.gov/public-roads/januaryfebruary-2002/managing-traffic-flow-through-signal-timing · NOCoE signal report card https://transportationops.org/trafficsignals/benchmarkingreport
- ATSPM (descriptive-only) & the test-before-deploy gap: UDOT/open ATSPM https://github.com/OpenSourceTransportation/Atspm · Kittelson ATSPM primer https://www.kittelson.com/ideas/a-primer-on-automated-traffic-signal-performance-measures/ · ATSPM-in-the-loop digital twin (TRR 2025) https://journals.sagepub.com/doi/10.1177/03611981241258985 · LIDATS live-data-to-simulator https://pmc.ncbi.nlm.nih.gov/articles/PMC11174745/
- Proprietary signal digital twins: Econolite Virtual Simulation & Modeling https://www.econolite.com/application-areas/virtual-simulation-modeling-and-validation/ · Aimsun Live Tees Valley https://www.aimsun.com/latest/press-release-tees-valley-digital-twin/ · SCATS SCATSIM/WinTRAFF https://www.aldridgetrafficcontrollers.com.au/scats/testing-simulation · Vivacity Dublin twin https://vivacitylabs.com/smart-city-dublin-using-nvidia-bentley-systems/
