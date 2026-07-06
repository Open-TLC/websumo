# What the SUMO Community Actually Wants from sumo-gui
## Background research to inform the WebSUMO roadmap

*Researched 2026-07-06; **re-run with recurrence quantification** replacing an
earlier truncated pass. This run's synthesis and adversarial verification
completed (105 agents), so themes below are **3-0 vote-verified from primary
sources** unless marked otherwise. Four earlier/tentative claims were actively
**refuted** this round — noted inline so they aren't repeated as fact.*

## How to read the recurrence tags

- **[widely cited]** — raised across ~4+ distinct threads/issues.
- **[occasional]** — 1–2 sources.
- **[refuted]** — a claim that failed adversarial voting; kept visible so it
  isn't reintroduced.

Primary evidence base: the sumo-user mailing list (eclipse.org/lists), the
eclipse-sumo/sumo GitHub issue tracker (sumo-gui/enhancement area), SUMO
visualization docs, third-party viewer projects, and SUMO conference material.
StackOverflow/Reddit and conference *surveys* yielded little verifiable signal
(the community's Q&A lives mostly on the mailing list).

## 1. Use cases & most-relied-upon features

The dominant serious workflow is **sumo-gui as a live co-simulation monitor**
driven by a TraCI/libsumo client — the user starts the GUI as a server and an
external script steps it, reading detectors and switching signals. This is the
adaptive-signal-development loop and is exactly what WebSUMO + OC target. Users
depend day-to-day on: **vehicle colouring schemes**, the **right-click parameter
dialog with live attribute plotting**, and **interactive intervention** (switch
TLS program, close lane/edge, start/stop/remove vehicles). *(These were
established in the prior pass; this run focused on gaps and did not re-quantify
them.)*

Analysis is notably **split between the GUI and a pile of external tools**:
static network/data overlays come from `plot_net_dump.py` and the third-party
**SumoNetVis**, not the live GUI — a workflow-fragmentation signal that recurs.

## 2. Most-wanted / missing features (ranked by evidenced demand)

### T1 — Congestion / data-overlay **heatmaps** — the clear #1 ask **[widely cited]**
Raised across **four or more distinct threads**: GitHub issues **#10186**
(heatmap after a run, as a decision-support overlay for where to add TLS/network
improvements), **#11351**, **#9216**, and mailing-list **msg10744**. This is the
strongest-recurring feature gap by a wide margin.

Nuance (corrected from the first pass): it is **not** true that sumo-gui can't do
data overlays at all — **[refuted 0-3]** the claim "emissions overlays are only
possible via external export." sumo-gui *can* colour edges by recorded
**edgeData**, so static/aggregate overlays exist. What's genuinely missing is a
**live, heatmap-style congestion overlay during the run** — maintainer *namdre*
points to issue **#9756** for the missing live data transfer. So the real gap is
*live + heatmap presentation*, not overlays in principle.

### T2 — Record & replay of a run — partially met, still clunky **[occasional]**
Only `fcdReplay.py` exists: a **command-line** tool that replays a recorded FCD
file by re-injecting trajectories as moving points-of-interest into a local
sumo-gui. There is no first-class in-GUI record/scrub/replay.

### T3 — Remote / web / headless viewing — a **maintainer-recognized gap** **[occasional but authoritative]**
GitHub issue **#6673** proposes attaching sumo-gui as a TraCI client to a
*remote* server and **explicitly names a web browser as the target** front-end.
It remains open in the backlog. This is direct, first-party evidence that
WebSUMO's founding premise addresses an acknowledged hole — not a niche want.

### T4 — Third-party viewers exist *because* of native gaps **[widely cited, as a pattern]**
- **sumo-web3d** (Sidewalk Labs): a TraCI server streaming state over WebSocket
  to a three.js client — **architecturally the same split as WebSUMO**. Now
  **unmaintained since ~2018**, so the gap it filled is currently reopened.
- **KTH 2024 thesis** using **Cesium + CZML** for SUMO visualization (browser/3D).
  *([refuted 1-2] the specific claim that it frames browser viz as valuable for
  remote/distributed monitoring — the thesis exists, but don't attribute that
  motivation to it.)*
- **SumoNetVis**: static network + trajectory visualization (incl. paths to
  Blender export, mailing-list msg03054) — evidence of demand for
  publication-quality and 3D output the GUI doesn't produce well.

The recurring *reason* these are built: **native browser access, 3D, and
shareable output** that sumo-gui lacks.

### Not strongly evidenced this round
Dashboards/statistics panels, multi-run comparison, and click-to-inject vehicles
did **not** surface as recurring community asks in the verified sources — worth
noting that WebSUMO's generator feature is ahead of, not chasing, demand here.

## 3. Biggest usability / UX complaints (design-level, not bugs)

All 3-0 verified from primary sources:

- **Poor visual defaults** — issue **#12483** judges the **default rainbow colour
  scheme bad**. *([refuted 1-2] the narrower claim that the issue proposes a
  palette-preset dropdown — so cite "bad default palette," not the specific fix.)*
- **Low-quality figure/video export** — mailing-list **msg10688**: the raster
  "Save Snapshot" is low quality, worked around via **SVG** export; issue
  **#6153**: a discarded/failed final screenshot. Producing good visuals is
  friction.
- **Styling/layer control is weak** — **msg08165**: users export to **QGIS** to
  get the layer and styling control sumo-gui doesn't offer.
- **Aging toolkit ceiling** — (prior pass, issue #8907) the Fox toolkit + old
  OpenGL cap rendering quality at a framework level.

Theme: sumo-gui is serviceable for *watching* a sim but weak for *producing
communicable artifacts* (figures, video, styled maps) and carries dated defaults
— a coherent "presentation/communication" weakness rather than isolated bugs.

**Removed vs first pass:** the "2D-only / limited camera / inadequate for
communication" claim attributed to arXiv 2604.19194 is **[refuted 1-2]** and its
source did not hold up — dropped. (Good call flagging it as unconfirmed before.)

## 4. Implications for the WebSUMO roadmap

### (a) Community needs WebSUMO already serves
- **Remote / web / headless viewing without X11** — the exact gap of issue
  **#6673** and the reason sumo-web3d/SumoNetVis/KTH exist; sumo-web3d being
  unmaintained means the niche is currently open. This is our core, validated
  value.
- **Live co-sim monitoring & interactive intervention** — our libsumo+NATS live
  view + click-to-inject generators + (planned) runtime TLS/lane edits mirror
  the most serious sumo-gui workflows.
- **Live inspector + log panel + detector display** — modern-UI analogues of the
  parameter dialog, message area, and detector visualization.

### (b) Prioritized next features (evidenced demand × stack fit)
1. **Congestion / data-overlay heatmaps** — **the #1 community ask (T1, 4+
   threads)** and an ideal deck.gl fit: colour edges/lanes by occupancy, speed,
   or waiting time, which the adapter already computes per step. Highest
   demand × highest fit → **top candidate to schedule.** Delivering a *live*
   heatmap specifically answers the #9756 "missing live transfer" gap.
2. **Richer, better-defaulted vehicle/edge colouring** — schemes by
   speed/waiting/accel/emissions (not just vClass), with a *good default* (avoid
   the #12483 rainbow complaint). Low effort, staple reliance.
3. **Record & replay** — persist the NATS state stream, scrub/replay in-browser;
   structurally beats the CLI `fcdReplay.py` round-trip. Pairs with the JetStream
   option in the NATS topology research.
4. **Live attribute-over-time plots** in the inspector — matches sumo-gui's
   live-plot dialog; we already stream the per-step inspect block, so a sparkline
   is mostly frontend.
5. **Shareable views + crisp export** — a shareable URL and clean SVG/PNG/video
   export directly attack the msg10688/#6153/QGIS export-quality complaints, and
   sharing is inherent to a web app (pending the multi-user work).

### (c) sumo-gui UX complaints a web UI structurally avoids
- **X11 / local-install barrier** — gone by construction (the #6673 ask).
- **Dated Fox/OpenGL rendering** — deck.gl/WebGL2 gives modern rendering, smooth
  zoom, real basemaps for free.
- **No sharing / no shareable URL** — inherent to the browser model.
- **Dated palettes & low-quality raster export** — a fresh UI picks good defaults
  and vector/crisp export from the start.
- **Analysis fragmented across CLI tools** — an integrated inspector + log +
  (future) heatmap/plots consolidates what sumo-gui splits across matplotlib
  scripts, SumoNetVis, and QGIS.

## Confidence & caveats
- Theme claims are 3-0 vote-verified from primary mailing-list/GitHub sources;
  the **heatmap** priority is the best-anchored conclusion (explicit multi-thread
  recurrence + high confidence).
- Four tentative claims were **refuted** this round (emissions-only-external;
  palette-dropdown specifics; the arXiv sumo3Dviz motivation; the KTH
  remote-access framing) — corrected above.
- Recurrence counts are approximate (distinct threads found, not exhaustive
  tracker counts). Dashboards/multi-run/click-to-inject demand was *not* found in
  verified sources — absence of evidence, not evidence of absence.
- sumo-web3d "unmaintained since ~2018" and some tool details are single-sourced.

## Sources
- Heatmap / data overlay: https://github.com/eclipse-sumo/sumo/issues/10186 · https://github.com/eclipse-sumo/sumo/issues/11351 · https://github.com/eclipse-sumo/sumo/issues/9216 · https://www.eclipse.org/lists/sumo-user/msg10744.html · (live transfer) issue #9756
- Remote/web/headless viewing (maintainer-recognized): https://github.com/eclipse-sumo/sumo/issues/6673
- Record & replay: https://sumo.dlr.de/docs/Tools/Visualization.html (fcdReplay.py)
- Default palette complaint: https://github.com/eclipse-sumo/sumo/issues/12483
- Export quality: https://www.eclipse.org/lists/sumo-user/msg10688.html · https://github.com/eclipse-sumo/sumo/issues/6153
- Styling via QGIS: https://www.eclipse.org/lists/sumo-user/msg08165.html
- Blender export / SumoNetVis: https://www.eclipse.org/lists/sumo-user/msg03054.html · https://www.researchgate.net/publication/347666353_Introducing_SumoNetVis
- Third-party web viewers: https://github.com/sidewalklabs/sumo-web3d · https://flow.readthedocs.io/en/latest/visualizing.html · https://simwrapper.github.io/ · KTH thesis https://kth.diva-portal.org/smash/get/diva2:1906701/FULLTEXT01.pdf
- Toolkit ceiling (prior pass): https://github.com/eclipse-sumo/sumo/issues/8907
- SUMO conference proceedings: https://eclipse.dev/sumo/proceedings/
- **Refuted/unverified:** arXiv 2604.19194 (sumo3Dviz motivation — refuted)
