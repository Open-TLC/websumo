# WebSUMO as a drop-in replacement for `sumo-gui` (and netedit) — Feasibility Study

*Decision-grade feasibility study. Deep-research pass 2026-08-14: 6 search
angles, 23 primary sources fetched, 97 claims extracted, 25 adversarially
verified (21 confirmed, 4 refuted). Grounded against WebSUMO's actual codebase
state (libsumo in-process + NATS), so this assesses the **delta** and the
**landmines**, not a generic overview. Companion to
`SUMO_GUI_COMMUNITY_RESEARCH.md` (demand) and `NETEDIT_WEB_RESEARCH.md` (editor).*

---

## TL;DR — verdict per sub-goal

| Sub-goal | Verdict | Rough effort band |
|----------|---------|-------------------|
| **Viewer drop-in** — `websumo <sumocfg + sumo args>` launches the identical headless sim and shows it in a browser with today's controls | ✅ **Highly feasible, small delta** | Weeks → low single-digit dev-months (CLI wrapper + wiring the GUI-only flags to existing controls) |
| **Full `sumo-gui` parity** — every sumo-gui capability, faithfully | ⚠️ **Feasible but large; mostly web-engineering, not API-proxying** | Many dev-months; "literal parity" is not a realistic target |
| **netedit in the same package** — `websumo --edit net.xml` | ❌ **Least feasible; only a narrow MVP is credible** | 3–5+ dev-months for a 2–4 mode MVP; full parity 12+ months (not realistic) |

**The single most important finding:** the launch/CLI/determinism layer is
**not** the obstacle — SUMO's own primitives already give it to us almost for
free. The real work is that **every sumo-gui *visual* capability (coloring
schemes, view settings, camera/screenshot, heatmaps) has no usable API on our
headless in-process path and must be re-implemented in the web layer.** "Drop-in"
is easy for the *simulation*; "sumo-gui-equivalent" is a large build for the
*GUI*.

---

## 1. Viewer drop-in — the launch contract is basically already met

**What "drop-in" needs at the CLI/engine level, and why it's a small delta:**

- SUMO's shared CLI already accepts a `.sumocfg` as `-c file.sumocfg` **or as a
  bare argument**, and command-line options combine with / override config
  values (except the `+` append syntax). *(verified 3-0)*
- `libsumo.start(["sumo", "-c", "test.sumocfg", ...passthrough])` starts the
  **identical headless simulation** from an arbitrary config plus passthrough
  args. *(verified 3-0)*
- libsumo runs headless and **deterministically by default** — fixed RNG seed
  `23423`, changeable via `--seed`, randomized via `--random`. *(verified 3-0)*

So the parse/launch layer of `websumo <args>` is a **thin wrapper over existing
behavior**. Our current launcher is scenario-name-only (`sumo_adapter.py
<scenario> [end] [scale] [speed]`); the delta is a CLI front-end that forwards an
arbitrary arg list into the `libsumo.start([...])` we already call — **not new
simulation plumbing.**

### Determinism / parity — scope the claim carefully (two landmines)

Two attractive-sounding parity claims were **refuted** in verification. Do not
repeat them:

- ❌ *"SUMO is deterministic by design across Windows/Linux/Mac"* — **refuted
  (0-3).** Bit-identical output is **not** guaranteed across platforms.
- ❌ *"Maintainer confirms TraCI and libsumo always produce identical output"* —
  **refuted (0-3).** No such confirmed statement exists.

**Safe framing:** the run is *"deterministic for a given SUMO version + seed +
config"*. Cross-path (libsumo vs `sumo` binary) and cross-platform **bit-parity
is unverified** and should be **empirically regression-tested**, not asserted.
This is [open question 1](#open-questions) and the honest answer to the user's
"exactly the same underlying simulation" requirement: **same simulation for a
fixed version+seed+config, pending an empirical byte-diff check** — not a
guaranteed identity across every axis.

Minor coupling risks (real but small):
- **libsumo ≠ TraCI** as a Python drop-in: keyword-argument drift (`edges` vs
  `edgeIDs`, `vehID` vs `vehicleID`, `param` vs `key`) — issue #6918. Affects our
  own code, not end users.
- **libsumo + sumo-gui GUI mode** is "does not work on Windows, highly
  experimental elsewhere." We don't use it (we're headless + our own renderer),
  so this is a *reason to stay on the headless path*, not a blocker. The 2023
  SIGSEGV report (#13008) was a single unreproduced bug on one Ubuntu-docker
  setup — **not a general defect.**

---

## 2. The parity landmine — sumo-gui's GUI has no headless API

This is the crux. The TraCI/libsumo **GUI domain** (`setZoom`, `setOffset`,
`setAngle`, `setBoundary`, `setSchema`, `screenshot`, `trackVehicle`, `addView`)
*exists as API entry points* — but on our **headless in-process libsumo path**
every one routes through `getView()` and throws
`TraCIException: "GUI is not running, command not implemented in command line
sumo"`. *(verified 3-0 against `src/libsumo/GUI.cpp`.)*

The only way to make those calls work is to run an **actual sumo-gui GUI
instance** (OpenGL, the very thing WebSUMO exists to avoid) via the
experimental, Linux-only `LIBSUMO_GUI` path. So for WebSUMO:

> **Every sumo-gui visual capability must be re-implemented in the
> MapLibre/deck.gl web layer. None of it can be proxied from headless libsumo.**

### Coloring / view-settings — the largest single workstream

- The GUI exposes **only named-scheme selection** (`getSchema`/`setSchema` *by
  name*). Custom color ranges, per-attribute coloring, and the entire
  **gui-settings-file** (view settings) system are **GUI-only**, no runtime API.
  *(verified 3-0; maintainer Behrisch, msg10180: schemes must be pre-saved in a
  gui-settings-file then selected by name — no runtime custom-color API.)*
- Many newer sumo-gui visual features (parkingArea colors, route/locomotive
  brightness, busStop waiting-depth width) are GUI/netedit-only with **no TraCI
  setter** (ChangeLog #16180/#17859/#18080; `_parkingarea.py`/`_busstop.py`
  expose getters only). *(verified 3-0)*

**Implication:** WebSUMO's coloring engine (today: TLS-colored stoplines,
detector bars, oriented-rectangle vehicles) must grow a **full web-native
color-scheme system** to match sumo-gui's dozens of edge/lane/vehicle coloring
modes. This is the **single largest parity workstream** — and it directly
overlaps the community's **#1 ask** (live congestion / data-overlay heatmaps).
Good news: this can be built **purely from libsumo getters** (edge/lane
occupancy, mean speed, waiting time) with **no gui-settings-file dependency** —
it's a web build, not an API gap. See [open question 2](#open-questions).

### Screenshots

`gui.screenshot()` has an API path (saved at next `simulationStep`) — but only
under a GUI-backed process (verified *medium*, 2-1; the "API-driven, not
GUI-only" framing was flagged as misleading for a headless renderer). **Practical
read: capture the deck.gl canvas client-side.** Don't build on the native API.

### Parity matrix (sumo-gui feature → headless API? → web-implementable? → effort)

| sumo-gui feature | Headless libsumo API? | Web-implementable? | Effort | Notes |
|---|---|---|---|---|
| Load `.sumocfg` + passthrough sim args | ✅ yes (`libsumo.start`) | ✅ (already do) | **XS** | The launch contract — solved |
| Start / pause / step / speed (`--start`, `--delay`) | ✅ (step loop) | ✅ have today | **XS** | Map `--start`/`--delay` to existing controls |
| `--quit-on-end` clean shutdown | ✅ (detect end) | ✅ | **S** | Wire to a clean teardown path |
| Inspect vehicle / TLS (right-click params) | ✅ getters | ✅ have today (~26 / ~8 fields) | **done** | Already ahead in UX |
| Detector display | ✅ getters | ✅ have today | **done** | |
| Inject / remove vehicles, intervention | ✅ (`vehicle.add`/`remove`) | ✅ have inject; add remove | **S** | |
| **Edge/lane/vehicle coloring by attribute** | ❌ (name-only `setSchema`) | ✅ from getters | **L** | Biggest workstream; = heatmap ask |
| **Congestion / data heatmaps** | ❌ no live API | ✅ from getters (deck.gl) | **M–L** | Community #1 ask; high value |
| **gui-settings-file (view settings)** | ❌ GUI-only | ⚠️ re-implement subset | **M** | Parse the XML, map to web view state |
| Camera control (zoom/offset/angle/boundary) | ❌ throws headless | ✅ native to MapLibre | **S** | Web layer already has this |
| **Native screenshot / SVG export** | ⚠️ GUI-only path | ✅ client-side canvas/SVG | **M** | Attacks export-quality complaints |
| **Breakpoints (`--breakpoints`/`-B`)** | ❌ no API | ✅ pause-at-time in step loop | **M** | Re-implement in adapter step loop |
| Parameter tracker live-plots | ❌ no API | ✅ stream inspect → sparkline | **M** | We already stream per-step inspect |
| "Locate" dialogs | ❌ | ✅ search over network model | **S** | |
| Vehicle/edge/lane scaling (visual) | ❌ | ✅ deck.gl layer props | **S** | |
| TLS phase **edit** (`setProgramLogic`) | ✅ (verified working, deferred) | ✅ | **S–M** | Researched; not yet wired |
| Lane edit (`setMaxSpeed`/`setAllowed`), edge close | ✅ setters exist | ✅ | **M** | Runtime-only edits |
| 3D / OSG view | n/a | ⚠️ different renderer | **XL** | Out of scope; deck.gl is 2.5D |

*XS = days, S = ~1–2 wks, M = ~weeks, L = ~1–2 months, XL = many months.*

---

## 3. netedit in the same package — least feasible

Confirmed and updated to 2026:

- **No web netedit exists.** *(prior research, still true.)*
- SUMO's **active** netedit roadmap (issue #17327, "netedit 1.26 tasks", opened
  2025-11-13, maintainer palvarezlopez, milestone 1.26.0) is **100% desktop** —
  zero web/REST/WASM references. A versioned task-list series (1.18/1.21/1.25/
  1.26) confirms it's actively developed, **not deprecated**. *(verified 3-0)*
- ChangeLog scan for web/browser/WASM: **zero matches** through v1.26.0
  (2026-01-29). *(verified 2-1)*
- **The netconvert round-trip is NOT lossless.** Maintainer Barthauer
  (sumo-user msg13252): even with corrected params, "a few small differences in
  geometry and a small right-of-way issue (`keepClear=0` is added to two
  connections)" remain. *(verified 3-0)* This is the core editing-MVP risk: an
  edit→save→reload cycle can silently perturb the network.

**Credible near-term scope:** a **narrow MVP only** — lane editing + TLS phase
editing via a netconvert round-trip whose **fidelity risks must be surfaced to
the user** (warn on residual geometry/right-of-way diffs). Big obstacles remain
junction-connection editing, TLS phase-plan complexity, geometry
precision/snapping, and undo/redo. Full parity (12+ months) is not a realistic
target and there's no upstream tailwind to ride.

---

## 4. Prior art & demand

- **No existing tool is a drop-in `sumo-gui` replacement** (live + interactive +
  CLI-launched). The field is: **sumo-web3d** (Sidewalk Labs, TraCI→three.js,
  archived, targets SUMO 0.31) — architecturally our ancestor, now dead;
  **SimWrapper** — a **post-hoc** trajectory/output viewer (loads recorded data,
  not a live interactive controller); the **KTH Cesium/CZML thesis** — 3D
  visualization, not control. WebSUMO's live libsumo+NATS control loop is
  **ahead of all of them** on the interactive axis.
- **Demand is real and maintainer-recognized.** GitHub **#6673** explicitly names
  a *browser* front-end attached to a remote server as a wanted capability
  (still open). The **#1 recurring feature ask** is live congestion/data-overlay
  heatmaps (#10186/#11351/#9216/#9756) — which is exactly the coloring workstream
  above. Export-quality and dated-palette complaints (msg10688/#6153/#12483)
  are structurally solved by a fresh web UI.
- **Adoption path:** given netedit's desktop-only roadmap and no upstream web
  effort, a **standalone, permissively-licensed distribution** is the realistic
  route (WebSUMO is already Apache-2.0). Upstreaming a browser front-end is
  *possible* (#6673 signals openness) but shouldn't be assumed. See
  [open question 4](#open-questions).

---

## 5. Obstacle ranking (for the go/no-go)

1. **Coloring / view-settings + heatmap parity** — no API, largest web-build.
   *Also the highest-value item (community #1 ask).*
2. **Camera / screenshot / track + `--gui-settings-file` / `--breakpoints`** —
   no headless API; must be re-implemented in the web layer (mostly
   straightforward, camera is native to MapLibre).
3. **netedit inclusion** — gated by lossy netconvert round-trips and no upstream
   direction; narrow MVP only.
4. **libsumo≠TraCI keyword drift + libsumo+GUI experimental status** — minor
   coupling risks; avoid the GUI+`LIBSUMO_AS_TRACI` path entirely.
5. **Launch/CLI-parse + deterministic reproduction** — **NOT obstacles.** Solved
   by existing primitives (pending an empirical byte-diff regression check).

**The shape of the decision:** "viewer drop-in" is a *product/packaging* move
we can largely ship on top of what exists. "Full sumo-gui parity" is a
*multi-month web-engineering program* dominated by the coloring/view-settings
system. "netedit" is a *separate, larger, riskier* project best kept out of
scope beyond a narrow MVP.

---

## 6. Recommended staged roadmap (if we pursue it)

1. **Empirical parity check first** (de-risks the whole premise): byte-diff
   WebSUMO's libsumo run vs the `sumo` binary across a representative scenario
   set incl. teleports/collisions/subsecond, same version+seed+config. Answers
   whether "same underlying simulation" holds. *(1–2 wks)*
2. **`websumo <args>` CLI front-end**: forward an arbitrary arg list into
   `libsumo.start([...])`; honor `-c`/bare sumocfg + passthrough sim args; map
   `--start`/`--quit-on-end`/`--delay` to existing controls; auto-start the
   stack, bind an ephemeral port, auto-open the browser, clean shutdown.
   Decide the **NATS-embed-vs-optional** question for a single-binary distribution
   ([open question 3](#open-questions)). *(weeks)*
3. **Coloring / heatmap system** (the parity core + community #1 ask): web-native
   color-scheme engine driven purely from libsumo getters (lane/edge occupancy,
   speed, waiting time). Ship a *good default* palette (avoid the #12483
   complaint). *(1–2 months)*
4. **Fill the GUI-flag gaps**: breakpoints (pause-at-time in the step loop),
   client-side screenshot/SVG export, locate dialogs, a `--gui-settings-file`
   subset parser, parameter-tracker sparklines. *(weeks, incremental)*
5. **Runtime edits** (already-available setters): TLS phase edit
   (`setProgramLogic`, verified), lane speed/permission edits — "this run only".
   *(weeks)*
6. **netedit MVP** — only if separately justified: lane + TLS phase editing via
   netconvert round-trip, with explicit fidelity warnings. *(3–5+ dev-months,
   separate track.)*

---

## Open questions

1. **Empirical byte-parity**: does the libsumo in-process run produce
   byte-identical outputs to the `sumo` binary for the same version+config+seed
   across a representative scenario set (teleports/collisions/subsecond)? Any
   divergence undermines "same underlying simulation."
2. **Minimum viable heatmap**: can the live congestion/data overlays (community
   #1 ask) be derived purely from libsumo getters with **no** gui-settings-file
   dependency? (Almost certainly yes — worth confirming the getter coverage.)
3. **Single-binary without a broker**: can NATS be embedded or swapped for an
   in-process bus so `websumo` ships without an external broker? Effort/risk of
   refactoring the current `sim.{scenario}.*` topic architecture?
4. **Upstream vs standalone**: would SUMO maintainers welcome an upstream browser
   front-end (#6673), or is a standalone Apache-2.0 distribution the realistic
   adoption path given netedit's desktop-only roadmap?

---

## Confidence & caveats

- Verdicts rest on **21 adversarially-verified claims** from primary sources
  (SUMO docs, `src/libsumo/GUI.cpp`, GitHub issues, sumo-user list).
- **Two determinism claims were refuted** — cross-platform/cross-path bit-parity
  is **not** guaranteed; scope parity to "deterministic for a given
  version+seed+config" and regression-test empirically.
- **Two coloring/screenshot claims split 2-1** — the pydoc "API-driven" framing
  is misleading for a headless renderer; the safe assumption is **web-layer
  reimplementation, not API proxying**.
- netedit effort bands (3–5 dev-months MVP, 12+ months parity) are estimates
  from prior internal research, not re-derived here.
- Time-sensitivity: ChangeLog current only through **v1.26.0 (2026-01-29)**; the
  libsumo+GUI "experimental" status could change — re-verify near any
  implementation start.

## Primary sources

- CLI / config: https://sumo.dlr.de/docs/Basics/Using_the_Command_Line_Applications.html
- libsumo: https://sumo.dlr.de/docs/Libsumo.html
- Randomness/determinism: https://sumo.dlr.de/docs/Simulation/Randomness.html
- GUI domain internals: https://github.com/eclipse-sumo/sumo/blob/main/src/libsumo/GUI.cpp
- GUI CLI options: https://sumo.dlr.de/docs/sumo-gui.html
- Change GUI State (TraCI): https://sumo.dlr.de/docs/TraCI/Change_GUI_State.html
- traci._gui pydoc: https://sumo.dlr.de/pydoc/traci._gui.html
- Coloring schemes (maintainer): https://www.eclipse.org/lists/sumo-user/msg10180.html
- libsumo≠TraCI kwargs: https://github.com/eclipse-sumo/sumo/issues/6918
- libsumo+GUI crash report (unreproduced): https://github.com/eclipse-sumo/sumo/issues/13008
- ChangeLog: https://sumo.dlr.de/docs/ChangeLog.html
- netedit 1.26 tasks (desktop-only): https://github.com/eclipse-sumo/sumo/issues/17327
- netconvert round-trip loss (maintainer): https://www.eclipse.org/lists/sumo-user/msg13252.html
- Browser front-end request (maintainer-recognized): https://github.com/eclipse-sumo/sumo/issues/6673
- Heatmap #1 ask: https://github.com/eclipse-sumo/sumo/issues/10186
- SimWrapper (post-hoc): https://simwrapper.github.io/docs
- sumo-web3d (archived): https://github.com/sidewalklabs/sumo-web3d
- KTH Cesium thesis: https://kth.diva-portal.org/smash/get/diva2:1906701/FULLTEXT01.pdf
