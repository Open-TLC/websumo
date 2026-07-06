# What the SUMO Community Actually Wants from sumo-gui
## Background research to inform the WebSUMO roadmap

*Researched 2026-07-06 via multi-source web search (SUMO official docs, GitHub
issues/labels, third-party viewer projects, academic sources). The automated
synthesis step was truncated by a session limit, so this was assembled by hand
from collected source-cited findings. Claims tagged **[verified]** passed
adversarial voting; **[sourced]** are single-source, not vote-checked; one
academic citation is flagged as **[unconfirmed]** — see caveats.*

## 1. What people actually use sumo-gui for

**As a live co-simulation monitor (the dominant serious workflow).**
- **[verified]** The canonical TraCI/libsumo signal-control loop uses sumo-gui
  as a **server driven by an external Python client**: the user presses *start*
  and the GUI runs while the script steps it. (SUMO TraCI4TrafficLights tutorial)
- **[verified]** The adaptive-signal pattern is exactly ours: the controller
  **reads induction-loop detectors and switches traffic-light phases
  step-by-step** while sumo-gui shows the live state. This is the reference
  workflow WebSUMO already mirrors — and the one OC integration targets.

**As an interactive intervention tool during a run.**
- **[verified]** sumo-gui supports, mid-simulation: **switching TLS programs,
  closing lanes/edges, adjusting vehicle speed factors, and start/stop/remove
  of vehicles** via right-click. This is the "poke the running sim" workflow —
  the same family as our click-to-inject generators and the (planned) runtime
  TLS/lane edits from the inspector.

**As an inspection tool.**
- **[verified]** Object attributes via **right-click → object parameter dialog**,
  including **live plotting of an attribute over time**. (Our element inspector
  is the direct analogue; live plotting is a feature we do *not* yet have.)

**As a visualization surface.**
- **[verified]** Multiple **vehicle coloring schemes**: by speed, waiting time,
  acceleration, CO₂ emissions, selection. (We colour by vClass only — this is a
  concrete, cheap gap; see roadmap.)
- **[sourced]** Non-GUI/offline visualization is delivered by a suite of
  **matplotlib wrapper scripts** (`plotXMLAttributes.py`, `plot_trajectories.py`,
  `plot_net_dump.py`, `plot_summary.py`, …) — i.e. much analysis happens
  *outside* the GUI, after the run.
- **[sourced]** Run **replay** exists only as `fcdReplay.py`, which re-injects a
  recorded FCD file back into a local sumo-gui — there is no first-class
  in-GUI recording/replay.

**Scale of GUI activity.** **[sourced]** The `a:sumo-gui` label on the
eclipse-sumo/sumo repo covers a large, sustained body of issues (~1,340 total,
of which ~395 are enhancements/feature requests) — GUI demand is substantial and
feature-request-heavy, not just bug reports. *(Counts are single-sourced from a
label page and may drift; treat as order-of-magnitude.)*

## 2. Most-wanted / missing features

**Data-overlay heatmaps — the clearest recurring wish.**
- **[verified]** Users explicitly request a **heatmap/data-overlay** for
  sumo-gui to visualize congestion (GitHub issue #10186), and
- **[verified]** want it as a **decision-support overlay showing where TLS and
  network improvements should be made** — tying visualization straight to the
  signal-engineering workflow. This is the single most concretely-evidenced
  feature gap in the findings.

**Web / browser-based visualization — evidenced by the tools that exist to fill it.**
- **[sourced]** **sumo-web3d** (built by Sidewalk Labs / Alphabet) renders SUMO
  in a browser via TraCI + three.js, **streaming frame-by-frame state over
  websockets** so users watch a live sim **without a local sumo-gui** — the same
  architecture as WebSUMO, built because sumo-gui didn't cover browser/remote.
- **[sourced]** **Flow** (UC Berkeley RL framework on SUMO) integrates
  sumo-web3d as an alternative renderer (`--sumo-web3d` flag) — a second project
  independently reaching for a web viewer.
- **[sourced]** **SimWrapper** (TU Berlin VSP) is an open-source browser-based
  transport-sim visualization platform that runs **locally or as a published web
  dashboard** — evidence the web-delivery + shareable-dashboard model is wanted
  in this community (though its plugins target MATSim/ActivitySim, not SUMO).

The existence of *three* independent browser-based efforts is strong evidence
that **web/no-X11/shareable** visualization is a real, recurring gap — which is
precisely WebSUMO's founding premise.

## 3. Biggest usability / UX complaints (not operational bugs)

**Aging UI toolkit → dated look and rendering ceiling.**
- **[sourced]** A core maintainer acknowledges sumo-gui's rendering is
  **architecturally constrained by the aging Fox toolkit and an old OpenGL
  version** (no shader support, precluding modern font rendering) — GitHub
  #8907. This is a design-level limitation, not a transient bug: the visual
  quality ceiling is baked into the framework.

**2D-only, limited camera, weak for communication.**
- **[unconfirmed]** An academic source (arXiv 2604.19194) reportedly argues
  sumo-gui is **2D with restricted camera control, no street-level/ego view**,
  and that existing 2D outputs are **inadequate for intuitive interpretation,
  stakeholder communication, and human-centred evaluation**, and that
  visualization matters for interpretability, debugging, and teaching. *We could
  not independently confirm this citation (the arXiv ID did not verify); treat
  the specific paper as unverified, though the theme recurs across the web-tool
  motivations above.*

**Analysis lives outside the GUI.**
- Implied by §1: because rich analysis/plots are delivered as **separate Python
  matplotlib scripts** and replay needs a **separate FCD round-trip**, the
  "understand what happened" workflow is fragmented across the GUI + a pile of
  CLI tools rather than integrated — a discoverability/workflow-friction problem.

**Sharing/collaboration gap.**
- Implied by the web-tool landscape: sumo-gui is a **local, single-user desktop
  app**; there is no built-in way to share a live view or publish a result.
  SimWrapper's "publish as a web dashboard" capability exists precisely to fill
  this.

*Note: the research surfaced fewer hard-cited UX complaints than use-cases —
partly because the verification budget ran out. The Fox/OpenGL ceiling (#8907)
is the best-anchored complaint; the 2D/communication and sharing themes are
triangulated from the third-party-tool motivations rather than direct quotes.*

## 4. Implications for the WebSUMO roadmap

**Where WebSUMO is already well-positioned (keep/lead with these):**
- **Web / no-X11 / shareable access** — the exact gap sumo-web3d, Flow, and
  SimWrapper were built to fill. This is our core value; it directly answers the
  most-evidenced structural complaint. *(Sharing/collab is latent in the
  browser model but we haven't built multi-user — see the known single-selection
  limitation.)*
- **Live co-simulation monitoring** — our libsumo+NATS live view *is* the
  canonical signal-development workflow; OC integration (TODO item 1) lands us
  squarely in the most serious real use case.
- **Interactive intervention** — click-to-inject generators already match
  sumo-gui's start/stop/inject family; the planned runtime TLS/lane edits from
  the inspector match its "switch program / close lane" interventions.
- **Live inspector + log panel + detector visualization** — direct analogues of
  sumo-gui's parameter dialog, message area, and detector display, in a modern UI.

**Frequently-wanted features to prioritize next:**
1. **Data-overlay heatmaps** (congestion / where-to-improve) — the single
   clearest community ask (#10186), and a natural fit for deck.gl (colour edges
   by occupancy/speed/waiting, which we already read per step). High value,
   moderate effort. *Strong candidate to add to the roadmap.*
2. **Richer vehicle colouring schemes** (by speed / waiting / accel / emissions,
   not just vClass) — cheap, and a staple users rely on. Low effort, quick win.
3. **Attribute-over-time live plots** in the inspector — matches sumo-gui's
   live-plot dialog; we already stream the per-step inspect block, so a small
   sparkline is largely a frontend add.
4. **Record & replay** of a run — sumo-gui only offers a clunky FCD round-trip;
   a browser recorder (persist the NATS state stream, scrub/replay) would beat
   the incumbent. Ties into the JetStream option from the NATS topology research.

**sumo-gui UX complaints a fresh web UI can simply *not inherit*:**
- The **Fox/OpenGL rendering ceiling** — deck.gl/WebGL2 gives us modern
  rendering, smooth zoom, real basemaps for free.
- **Local-desktop-only / no sharing** — inherent to a web app (with the
  multi-user work noted elsewhere).
- **Fragmented analysis across CLI scripts** — an integrated in-browser
  inspector + log + (future) heatmap/plots consolidates what sumo-gui splits
  across matplotlib tools.

## Caveats

- The automated verification/synthesis was cut short by a session limit; only 8
  claims got full adversarial votes. `[sourced]` items rest on a single citation
  and `[unconfirmed]` on one that did not verify — re-check before quoting
  externally.
- Coverage skews to official docs, GitHub, and third-party-tool pages; the
  mailing-list / StackOverflow / Reddit "how do I…" long tail was under-sampled
  when the budget ran out, so the *volume* ranking of complaints is provisional.
- A fuller re-run (after the limit resets) should target the sumo-user mailing
  list and the `a:sumo-gui` enhancement issues directly to quantify recurrence.

## Sources
- SUMO — sumo-gui docs: https://sumo.dlr.de/docs/sumo-gui.html
- SUMO — TraCI4TrafficLights tutorial: https://sumo.dlr.de/docs/Tutorials/TraCI4Traffic_Lights.html
- SUMO — Visualization tools: https://sumo.dlr.de/docs/Tools/Visualization.html
- Heatmap request: https://github.com/eclipse-sumo/sumo/issues/10186
- Emission heatmap discussion: https://github.com/eclipse-sumo/sumo/issues/11351
- Fox/OpenGL rendering limitation: https://github.com/eclipse-sumo/sumo/issues/8907
- `a:sumo-gui` label: https://github.com/eclipse-sumo/sumo/labels/a:sumo-gui
- sumo-web3d (Sidewalk Labs): https://github.com/sidewalklabs/sumo-web3d
- Flow visualizing (sumo-web3d integration): https://flow.readthedocs.io/en/latest/visualizing.html
- SimWrapper: https://docs.simwrapper.app/site/
- (unconfirmed) arXiv 2604.19194 — SUMO visualization critique
