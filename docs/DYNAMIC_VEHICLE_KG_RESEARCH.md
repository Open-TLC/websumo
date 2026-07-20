# Dynamic Vehicle-Perception Knowledge Graphs on a Shared Infrastructure Graph
## Literature review & feasibility

*Researched 2026-07-08 via multi-source web search (105 agents) with adversarial
verification. Claims tagged **[high]** (verified across independent sources),
**[medium]** (single strong source / narrow result), **[refuted]** (failed
verification — kept visible so it isn't reused). Several ETSI/MDPI/Springer PDFs
returned 403 during verification and were confirmed via mirrors + canonical repos;
load-bearing quotes were matched verbatim across sources.*

## The idea, in one line

A **per-vehicle, time-varying (egocentric) knowledge graph** — `vehicle
:travelingAt lane_X ; :following vehicle_Y (gap d) ; :approaching signalGroup_Z
(dist, state)` — where every dynamic graph **references the same static
infrastructure KG** (shared lane/junction IRIs) as its identity/coordinate frame.
Initially extracted from SUMO; conceptually producible by a real vehicle.

**Verdict up front:** this is essentially a **semantic / RDF-KG-flavored
realization of the Local Dynamic Map + Collective Perception concept**. Every
individual component has strong prior art; the *specific combination* (RDF-grounded
+ temporal + per-vehicle + mergeable) is **not** demonstrated by any single cited
system — that gap is where the novelty (and risk) sits.

---

## Q1 — Existing work: does this kind of graph already exist?

Yes, across three converging strands — but no single system is exactly this.

- **RDF Stream Processing (RSP) — the temporal-streaming machinery.** [high] A
  mature, peer-reviewed field: the *VLDB Journal 2025* survey (Bonte, Calle, Curé,
  Kondylakis, Tommasini, DOI 10.1007/s00778-025-00927-7) is the first comprehensive
  survey; languages split into **SPARQL-based** (C-SPARQL, RSP-QL, CQELS — adding
  windows, continuous queries, event operators) and **rule-based** (Datalog, ASP,
  DL). [high] It has been **benchmarked directly on real traffic streams** —
  *CityBench* (ISWC 2015) uses Aarhus smart-city vehicular/traffic sensor streams
  with continuous C-SPARQL queries. So streaming, time-annotated RDF over traffic
  data is established, not novel.
- **KG-for-autonomous-driving — the world-model framing.** [high] An actively
  surveyed area: the *MDPI MAKE 2026* PRISMA review (10.3390/make8050126, 2015–2025)
  and *MDPI Information 2024* (15/10/645) organize the field along
  perception→representation→reasoning→decision and **explicitly enumerate "dynamic
  KG updates" and "V2X knowledge integration" as research categories**. Time-varying
  traffic KGs referencing shared infrastructure are a recognized strand.
- **Road / egocentric "scene graphs" — the relational structure.** [high] Directly
  parallel to the proposed `:following`/`:approaching` edges: Zipfl & Zöllner's
  *Semantic Scene Graph* (IEEE ITSC 2022, arXiv:2111.10196, open impl) projects
  participants onto the road network as nodes with **semantically classified edges**
  (longitudinal/same-lane, lateral/parallel, intersecting); *roadscene2vec* /
  *sg2vec* (arXiv:2109.01183, KBS 2022, open source) generate scene graphs from
  video **or the CARLA simulator**; plus scene-graph risk assessment and the TSG-451
  ego-centric benchmark. [high] Spatio-temporal scene graphs + graph learning
  (GNN+LSTM) **outperform non-graph deep baselines** on risk/collision tasks.
- **Sim-to-real signal.** [medium] A scene-graph model trained on synthetic data hit
  **87.8% on real data vs 70.3% for a non-graph CNN-LSTM baseline** (Yu et al., IEEE
  T-ITS 2021, arXiv:2009.06435) — a 17.5pp sim-to-real advantage. Single dataset,
  narrow lane-change-risk task → suggestive, not established, but it argues a
  SUMO-derived semantic graph could generalize toward real vehicles.

**Caveat:** the scene-graph literature is predominantly **vision-derived,
static-per-frame or GNN-embedding-based** — it validates the relational/egocentric
*structure* but does **not** itself use time-stamped RDF, RDF-star, named-graphs-
per-timestep, or grounding to stable infrastructure IRIs. Those come from the RSP
strand. Nobody cited combines all of it.

## Q2 — Design aspects to consider

RSP hands you a ready menu; the scene-graph and sensor-ontology work fills the rest:

- **Temporal model** [high] — RSP offers timestamped triples/named-graphs,
  **time- vs tuple-based windows**, **reporting policies**, and explicit **snapshot
  vs. change-stream** semantics. Decide: named graph per timestep, RDF-star for
  edge-level timestamps/validity intervals, or event vs. state triples.
- **Update rate vs. retention** — you sample ~10 Hz; RSP windows/retention policies
  are exactly the knob. Keep a short sliding window materialized; treat history as a
  stream, not a growing store.
- **Identity & grounding** — stable lane/junction IRIs in the static graph are the
  anchor; every dynamic triple points at them. This is the linchpin and your main
  asset (you already have the static RDF graph).
- **Relationship types** — reuse the scene-graph taxonomy: spatial
  (following/leading/adjacent-lane/approaching) + topological (on-lane/on-edge/
  at-junction).
- **Query/scale** — RSP engines (C-SPARQL, CQELS, RSP4J) for continuous queries;
  or a graph store (Oxigraph/GraphDB) with incremental updates.
- **Ontology reuse** — don't invent from scratch: **SOSA/SSN** for observations, the
  **A.U.T.O. automotive ontology** (github.com/lu-w/auto) for traffic scenes, plus
  your existing infra vocabulary. [refuted] *SemanticFormer* was floated as an exact
  static-infra + dynamic-participant + snapshot ontology match but **failed
  verification** — don't rely on it as a drop-in precedent.
- **Provenance/uncertainty** — distinguish sim ground-truth from sensor estimates
  (SOSA observation + confidence); matters the moment real vehicles enter.

## Q3 — Could it be a basis for V2V?

Yes — and this is a *recognized* research direction, not a leap.

- [high] The **ETSI Collective Perception Service (CPS)** is built around an
  **"environment model": the computational representation of an ITS station's
  immediate environment, fusing objects from local sensors AND objects received over
  V2X** (ETSI TR 103 562). That is conceptually **a merged per-vehicle dynamic world
  model grounded on observations received from other vehicles** — exactly your
  merge-egocentric-graphs idea, minus the RDF formulation.
- If two vehicles ground their dynamic graphs on the **same infrastructure IRIs**,
  those IRIs are a shared identity/coordinate frame that makes graph merge
  well-defined (a lane is *the same node* for both). This is the strongest argument
  for your design.
- **Hard problems** (all real): **trust/misbehavior** — [high] as of 2021 the CPS
  *still lacked* misbehavior-detection and security specs (arXiv:2112.02184), a known
  open problem for any V2V graph exchange; **identity resolution** of the *same
  physical vehicle* across two egocentric graphs (they'll have different local ids);
  **time sync** across asynchronous 10 Hz streams; and **conflicting observations**
  (whose triple wins).

## Q4 — Relevant V2X schemes & standards

The graph idea maps onto an existing standards stack — treat these as the interop
target, not competition:

- **Message layer:** CAM (cooperative awareness), DENM (event notifications),
  **CPM / Collective Perception Service** (ETSI TS 103 324 v2.1.1 2023, TR 103 562)
  — [high] CPM shares **perceived objects' kinematics/attributes in the
  disseminating station's own reference frame**, with containers for
  self-description + sensor capabilities + perceived objects + perception regions.
  This is the closest standardized analogue to "share my egocentric perception."
  Plus SAE **J2735 BSM**; **C-V2X vs ITS-G5** as the radio layer.
- **Map layer — the key analogue:** the **Local Dynamic Map (LDM, ETSI EN 302 895)**
  layered model (permanent-static / transient-static / transient-dynamic /
  highly-dynamic). [medium] The four-layer model as a *verbatim* match wasn't
  independently confirmed in this run (the primary PDF 403'd), so treat the exact
  layering as medium-confidence — **but** a graph-based LDM already exists:
  **iLDM — "An Interoperable Graph-Based Local Dynamic Map"** (ResearchGate
  357708200) is essentially your idea by another name and is the closest direct
  precedent to check first.
- **Architectural precedent:** **V2X-UniPool** (arXiv:2506.02580, 2025) [high]
  splits scene understanding into a **Static Pool** (road geometry/signs, refreshed
  only on long-term infra change) + **Dynamic Pool** (vehicles, lights at 1–10 Hz),
  broadcasts a compact per-step snapshot, and does egocentric retrieval — a very
  close structural analogue. **Caveat:** it's an un-peer-reviewed preprint, it's a
  *language/SQL-RAG* store **not an RDF KG**, and its split is **per-scene, not
  per-vehicle egocentric**.
- **Ontologies:** SOSA/SSN (sensors), A.U.T.O. (automotive traffic), SENSORIS
  (sensor data interchange).

## Q5 — Fit with our SUMO + NATS + RDF setup

You are unusually well-positioned — you already stream most of the needed relations:

- **Extraction is nearly free.** libsumo already gives `getLaneID`, `getLeader`
  (id+gap), `getNextTLS` (junction, link, distance, state), position, angle — you
  publish all of these per step. Emitting them as **triples/quads** instead of (or
  alongside) the JSON state message is a small transform in the adapter.
- **The static graph is your differentiator.** You have the RDF intersection graph
  *and* the SUMO ids derived from it — so mapping SUMO lane/edge/junction ids back to
  the static graph's IRIs is tractable (graph2sumo built them). Most scene-graph work
  has no such stable semantic substrate.
- **NATS is a natural change-stream transport.** Publish a per-vehicle quad stream on
  a subject (e.g. `kg.{scenario}.veh.{id}`); consumers window/merge. Start as a pure
  message stream; only materialize a store (Oxigraph in-memory, or RSP4J/CQELS for
  continuous queries) if you need queries over the window.
- **Sampling/retention:** 10 Hz with a short sliding window (RSP-style) — don't grow
  an unbounded store.
- **SUMO as the V2V testbed:** the sim gives you *ground-truth* multiple egocentric
  graphs simultaneously — the ideal harness to prototype graph merge, identity
  resolution, and conflict handling **before** real sensors, and the sim-to-real
  scene-graph evidence (Q1) suggests it can transfer.

---

## Synthesis

**(a) Closest prior art & how ours differs.** Nearest neighbors: **iLDM**
(graph-based LDM — closest by name/intent), the **CPS environment model** (per-station
merged perception), **V2X-UniPool** (static/dynamic pool + snapshot broadcast), and the
**scene-graph + RSP** literatures. Ours differs by being **RDF/IRI-grounded on a shared
static infrastructure ontology, per-vehicle egocentric, and designed to be mergeable** —
a combination none of the cited systems fully realizes.

**(b) LDM verdict.** Yes — conceptually your "shared infra graph + per-vehicle dynamic
layer" **is a semantic/KG-flavored Local Dynamic Map / Collective Perception model.**
Confidence is high on the *analogy* (CPS environment-model + V2X-UniPool corroborate it);
medium on it matching the *exact* four-layer ETSI LDM verbatim (unverified this run —
confirm against EN 302 895 and iLDM directly).

**(c) What to prototype first on SUMO+NATS.**
1. Adapter emits a per-vehicle **quad stream** (`veh :onLane laneIRI`, `:following othIRI
   [gap]`, `:approaching sgIRI [dist,state]`) with SUMO ids mapped to static-graph IRIs.
2. A consumer that **materializes a sliding-window graph** (Oxigraph in-memory) and runs
   one or two continuous queries (e.g. "vehicles approaching a red within 30 m").
3. **Two-vehicle merge test**: take two egocentric graphs of the same scene, merge on
   shared infra IRIs, and measure identity-resolution + conflict handling — the core V2V
   experiment, with SUMO as ground truth.
4. Only then consider a CPM-shaped interop mapping (align your graph terms to CPS/CPM
   containers) if real-vehicle interop becomes a goal.

**(d) Key risks / open problems.** Trust & misbehavior (unsolved even in the standards);
cross-graph identity resolution; time sync of async 10 Hz streams; conflicting
observations; retention/scale if you over-materialize; and ontology sprawl (reuse SOSA/SSN
+ A.U.T.O. rather than inventing). And the honest one: the exact RDF+temporal+per-vehicle+
mergeable combination is unproven in the literature — that's the contribution *and* the
risk.

## Confidence & unverified sources
- The RSP maturity, scene-graph relational structure, KG-for-AD framing, CPS
  environment-model, and V2X-UniPool split are all **[high]** (multi-source).
- **[medium]:** the sim-to-real number (single source); the exact four-layer LDM model
  (primary PDF not fetched — corroborated only by analogy).
- **[refuted]:** SemanticFormer as an exact layered-ontology match.
- Confirm-before-building: **iLDM** (ResearchGate 357708200), **EN 302 895** (LDM),
  **A.U.T.O.** (github.com/lu-w/auto) — read these first; they're the nearest precedents.

## Key sources
- RSP survey — VLDB Journal 2025: https://link.springer.com/article/10.1007/s00778-025-00927-7
- CityBench (RSP on Aarhus traffic) — ISWC 2015: https://link.springer.com/chapter/10.1007/978-3-319-25010-6_25
- KG-for-AD reviews — MAKE 2026: https://doi.org/10.3390/make8050126 · Information 2024: https://www.mdpi.com/2078-2489/15/10/645
- Semantic Scene Graph — Zipfl, ITSC 2022: https://arxiv.org/abs/2111.10196 · roadscene2vec: https://arxiv.org/abs/2109.01183 · sg2vec: https://arxiv.org/abs/2111.06123 · sim-to-real: https://arxiv.org/abs/2009.06435
- V2X-UniPool: https://arxiv.org/pdf/2506.02580
- ETSI CPS — TS 103 324: https://www.etsi.org/deliver/etsi_ts/103300_103399/103324/02.01.01_60/ts_103324v020101p.pdf · TR 103 562: https://www.etsi.org/deliver/etsi_tr/103500_103599/103562/02.01.01_60/tr_103562v020101p.pdf
- CPS misbehavior/trust: https://arxiv.org/pdf/2112.02184
- LDM — EN 302 895: https://www.etsi.org/deliver/etsi_en/302800_302899/302895/01.01.01_60/en_302895v010101p.pdf · **iLDM (graph-based LDM)**: https://www.researchgate.net/publication/357708200_iLDM_An_Interoperable_Graph-Based_Local_Dynamic_Map
- A.U.T.O. automotive ontology: https://github.com/lu-w/auto
