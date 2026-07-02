# Web-Based netedit Replacement — Research Report

*Research completed: 2026-07-02. 101 agents, 19 sources fetched, 25 claims
adversarially verified (19 confirmed, 6 killed). Sources cited inline.*

---

## Executive summary

No web-based tool exists that replaces netedit. The closest candidates are
either visualisation-only, in maintenance mode, or limited to OSM tag editing
rather than full network topology. SUMO's own roadmap contains no plans for a
browser-based alternative. The SUMO community uses a multi-pathway workflow
where OSM import bootstraps networks and netedit handles interactive
corrections. Building a web netedit is a substantial but tractable engineering
effort. Given that WebSUMO already has the rendering stack, geometry pipeline,
and backend integration in place, extending it is significantly lower overhead
than building a standalone tool. The highest-value v1 scope is the
OSM-import-then-correct pattern, not from-scratch network creation.

---

## 1. Existing web-based options

### 1.1 No true replacement exists

Three projects come closest:

**sumo-web3d** (Sidewalk Labs, archived 2023) — pure 3D visualisation using
TraCI and three.js, targeting SUMO 0.31.0. No editing capability whatsoever.
[github.com/sidewalklabs/sumo-web3d]

**A/B Street** (play.abstreet.org, Rust/WASM) — a full traffic simulator with
lane and intersection editing, deployable in a browser. Technically accessible
but development focus has shifted to the osm2streets library; the integrated
editor+simulator is not actively maintained as a product. It is also not
SUMO-compatible — it uses its own network format.
[github.com/a-b-street/abstreet]

**osm2streets lane editor** (a-b-street.github.io/osm2streets/lane_editor.html)
— edits OSM lane tags only. Junction topology and road connectivity editing are
listed as future capabilities, not current. Adversarial verification confirmed:
this is OSM tag editing, not SUMO network editing.
[github.com/a-b-street/osm2streets]

### 1.2 SUMO's own roadmap

The netedit 1.26 task list (GitHub issue #17327, November 2025) contains only
desktop-focused work: Bugs, Regressions, Enhancements, Refactoring, Tests.
Zero references to web tooling, REST APIs, or browser-based alternatives. The
2024 SUMO changelogs (v1.20–1.21) likewise contain nothing about web interfaces.
netedit is **under active per-release development and is not deprecated**.
[eclipse-sumo/sumo/issues/17327, sumo.dlr.de/docs/ChangeLog]

**Bottom line:** the field is empty. There is no prior art to build on or
fork. Any web netedit would be a new project.

---

## 2. How the SUMO community edits networks in practice

The SUMO ScenarioGuide documents four distinct pathways, all of which are in
common use: [sumo.dlr.de/docs/Tutorials/ScenarioGuide.html]

| Pathway | Tool | When used |
|---------|------|-----------|
| OSM import | netconvert / osmWebWizard | Bootstrapping any real-world network |
| Programmatic edit | Plain XML + netconvert | Scripted modifications, CI pipelines |
| Interactive GUI | netedit | Manual corrections, TLS phase editing |
| Python scripting | sumolib | Analysis, batch modifications |

**OSM import is the dominant bootstrapping workflow.** osmWebWizard runs as a
local Python HTTP server, selects an area from OpenStreetMap, and produces a
ready-to-run SUMO scenario. It is a local tool, not cloud-based, and does not
replace netedit. [sumo.dlr.de/docs/Tutorials/OSMWebWizard.html]

**netedit is the primary GUI for corrections**, not for building networks from
scratch. Real-world usage is: import from OSM → correct lane counts, traffic
light phases, and intersection geometry in netedit → run simulation. The
from-scratch creation workflow (drawing every edge manually) exists but is rare
in practice.

**Adversarial note:** the claim that "OSMWebWizard bootstraps networks entirely,
making netedit unnecessary" was unanimously refuted (0-3 votes). The two tools
cover different stages of the same workflow. [sumo.dlr.de/docs/Tutorials/OSMWebWizard.html]

---

## 3. netedit feature scope

### 3.1 Three supermodes

netedit covers three largely independent editing domains:
[sumo.dlr.de/docs/Netedit/index.html]

| Supermode | What it edits |
|-----------|--------------|
| **Network** | Edges, lanes, junctions, connections, prohibitions, traffic lights, crossings, TAZ zones, additional elements, shapes |
| **Demand** | Routes, flows, vehicles, vehicle types, stops, persons, person plans |
| **Data** | Edge data, TAZ relations, OD matrices |

### 3.2 Network supermode — eight editing modes

[sumo.dlr.de/docs/Netedit/editModesNetwork.html]

1. **Create Edges** — draws new road edges; implicitly creates junctions at
   endpoints (no separate junction creation step)
2. **Edit Connections** — manages lane-to-lane connections through junctions
3. **Prohibitions** — sets traffic movement prohibitions
4. **Traffic Lights** — edits TLS phase plans and timing
5. **Additionals** — places detectors, rerouters, variable speed signs
6. **Crossings** — adds pedestrian crossings
7. **TAZ** — creates traffic analysis zones
8. **Shapes** — adds polygons and POIs for visual context

### 3.3 Demand supermode — seven editing modes

[sumo.dlr.de/docs/Netedit/editModesDemand.html]

Route, Vehicle, Vehicle Type, Stops, Person Type, Person, Person Plan.

### 3.4 Core vs. rarely needed for our use case

Given that our networks come from the `graph2sumo` pipeline (OSM → RDF →
netconvert → SUMO), the editing needs are post-import corrections, not
from-scratch creation. The realistic priority ordering:

| Priority | Feature | Reason |
|----------|---------|--------|
| Core | Lane count and type editing | Most common post-OSM correction |
| Core | Traffic Light phase editing | OC integration needs correct TLS |
| Core | Edge geometry (shape) correction | OSM geometry often imprecise |
| Core | Junction connection editing | Turn restrictions, lane assignments |
| Useful | Additionals (detector placement) | OC detector wiring |
| Defer | Crossings, Shapes, POIs | Cosmetic, rarely affects simulation |
| Defer | TAZ editing | Done programmatically via Python |
| Defer | Demand supermode | Routes come from route files, not netedit |
| Defer | Data supermode | Analysis outputs, not simulation inputs |
| Omit | From-scratch creation | graph2sumo handles this |

**The minimum viable scope for our use case is the top four items:** lane
editing, TLS phase editing, edge geometry correction, and junction connections.
This covers the bulk of real-world corrections after an OSM import.

---

## 4. Engineering effort and: WebSUMO feature vs. standalone tool

### 4.1 Available drawing libraries

WebSUMO's existing MapLibre GL JS + deck.gl stack is directly compatible with
three open-source drawing libraries:

**Terra Draw** (MIT, github.com/JamesLMilner/terra-draw) — ships a native
`TerraDrawMapLibreGLAdapter` for MapLibre GL JS v4/5. No library switch needed.
Provides out-of-the-box modes: point, linestring, polygon, rectangle, circle,
freehand, select, delete. Endorsed by Google as the replacement for its
deprecated Maps Drawing Library (removed June 2026), featured at FOSDEM 2025.
Actively maintained, MIT licensed. **Best fit for WebSUMO.**

**editable-layers** (Apache 2.0, visgl.github.io/deck.gl-community) — the
deck.gl community fork/successor to nebula.gl, which "lacked maintainers for
several years." Consolidates nebula.gl's edit-modes and layers packages, focuses
on GeoJSON visualisation and editing. Suitable for the deck.gl overlay side.
*Note: the claim that it can edit at 60fps with 100k features was unanimously
refuted (0-3). Performance on SUMO-scale networks is unverified and is the
primary unknown engineering risk.*

**maplibre-geoman** (dual-license) — MIT free tier, paid Pro tier for snapping,
undo/redo, and advanced features. Snapping and undo/redo are nearly essential
for a network editor, so the Pro license cost must be evaluated for an
open-source project. Less suitable unless MIT tier suffices.

**iD editor** (ISC, github.com/openstreetmap/iD) — the OSM web editor.
Technically closest in purpose (road network editing in a browser) but built
on a completely different stack (D3-based custom renderer, not MapLibre) and
deeply OSM-specific. Not a library; not reusable as a component.

### 4.2 What needs to be built

Even scoped to the four core modes, the implementation involves:

| Component | Effort | Notes |
|-----------|--------|-------|
| Drawing layer (Terra Draw integration) | Low | Drop-in adapter for MapLibre |
| Lane/edge property panel | Medium | Attribute editing UI, SUMO XML validation |
| TLS phase editor | High | Phase ring visualisation, timing UI, intergreen matrix |
| Junction connection editor | High | Visual lane-to-lane assignment, complex state machine |
| netconvert round-trip (edit → save → reload) | Medium | FastAPI endpoint wrapping netconvert |
| Undo/redo stack | Medium | Essential for usability; Terra Draw helps |
| File I/O (load/save net.xml) | Low | Already partially in place via GeoJSON pipeline |
| Snapping / precision editing | Medium | Critical for usable geometry editing |

Rough estimate for the four-mode MVP: **3–5 developer-months** for a working
but not polished tool. Full netedit parity across all modes: 12+ months and
not a realistic target.

### 4.3 WebSUMO extension vs. standalone tool

**Extension is clearly preferable.** WebSUMO already provides:

- MapLibre GL JS rendering of SUMO network geometry as GeoJSON
- FastAPI backend with netconvert available
- Network loading pipeline (`network.py` → GeoJSON)
- TraCI connection (useful for live validation: edit → simulate → observe)
- Authentication, serving, scenario management

A standalone web netedit would need to replicate all of this independently.
The only argument for standalone is UI separation (edit mode vs. view mode are
visually distinct), but that is easily handled with a mode toggle in WebSUMO's
control panel.

---

## 5. Proposed next steps

### Phase 1 — Scoping decision (before any code)

Answer the two open questions that block estimation:

1. **Minimum viable feature set:** Confirm that lane editing + TLS phase editing
   + edge geometry + junction connections covers 80%+ of real correction work
   for Helsinki intersection scenarios. Validate against actual graph2sumo output
   and the corrections OC integration will require.

2. **Performance benchmark:** Load a Helsinki 269/270 network (realistic scale)
   into Terra Draw and editable-layers, render 10,000+ edge segments, and
   measure hit-testing and re-render latency on pan/zoom. This is the primary
   unknown risk. If performance is inadequate, the library choice changes.

### Phase 2 — Backend endpoint: netconvert round-trip

Add a `POST /api/network/{scenario}/save` endpoint to WebSUMO's FastAPI backend
that accepts a modified GeoJSON (or partial net.xml patch), runs netconvert, and
writes the updated `.net.xml` back. This is the data pipeline that all editing
modes depend on. It can be built and tested independently before any UI work.

```
Browser edit → GeoJSON diff → FastAPI → netconvert → updated net.xml → reload in browser
```

### Phase 3 — MVP editor (two modes first)

Integrate Terra Draw into MapView. Implement the two highest-value modes:

**Lane/edge editing** — select an edge, edit its properties (lane count, type,
speed limit, allow/disallow vehicle classes) in a side panel, save. This covers
the most common post-OSM correction.

**TLS phase editing** — select a junction, display the phase ring as a table
(phase index, state string, duration, minDur, maxDur), allow editing, save. This
is directly required for OC integration (correct phase definitions are the input
to OC's intergreen matrix).

### Phase 4 — Geometry and connections

Edge shape dragging (moving intermediate waypoints) and junction connection
assignment (which lanes connect to which). These require the most UI precision
and should follow after phase 3 is stable.

### What to defer or omit

- From-scratch network creation (graph2sumo handles this)
- Demand supermode (route files are managed separately)
- Data supermode (TAZ, OD matrices — done programmatically)
- Shapes and POIs (cosmetic, not simulation inputs)
- Full netedit feature parity (not a goal)

---

## 6. Relationship to WebSUMO's existing work

WebSUMO's implementation (as of July 2026) already provides:

- Network rendering as GeoJSON via MapLibre GL JS and deck.gl
  (`backend/network.py`, `frontend/src/MapView.tsx`)
- Junction areas, lane lines, and stop lines as distinct GeoJSON feature types
- Live TLS state visualisation (stop lines coloured by signal phase)
- Vehicle rendering as oriented rectangles with SUMO dimensions
- TraCI session management with pause/resume/scale controls
- FastAPI backend serving both API and static frontend from one process

The `network.py` GeoJSON pipeline is the direct foundation for a web editor:
the same geometry that is rendered for viewing would be the geometry that is
selected and modified for editing. The round-trip question (modified GeoJSON →
net.xml → re-render) is the main new piece.

---

## Sources

| Source | Role |
|--------|------|
| github.com/sidewalklabs/sumo-web3d | sumo-web3d — visualisation only, archived |
| github.com/a-b-street/abstreet | A/B Street — browser editor, maintenance mode |
| github.com/a-b-street/osm2streets | osm2streets lane editor — OSM tags only |
| sumo.dlr.de/docs/Tutorials/ScenarioGuide.html | SUMO workflow documentation |
| sumo.dlr.de/docs/Tutorials/OSMWebWizard.html | osmWebWizard tool documentation |
| sumo.dlr.de/docs/Netedit/index.html | netedit overview |
| sumo.dlr.de/docs/Netedit/editModesNetwork.html | Network supermode modes |
| sumo.dlr.de/docs/Netedit/editModesDemand.html | Demand supermode modes |
| github.com/eclipse-sumo/sumo/issues/17327 | netedit 1.26 active task list |
| sumo.dlr.de/docs/ChangeLog/Changes_in_2024_releases.html | SUMO 2024 changelogs |
| github.com/JamesLMilner/terra-draw | Terra Draw — MIT MapLibre drawing library |
| visgl.github.io/deck.gl-community/docs/modules/editable-layers | editable-layers — deck.gl fork of nebula.gl |
| github.com/geoman-io/maplibre-geoman | maplibre-geoman — dual-license |
| geoman.io/blog/the-state-of-the-maplibre-plugin-ecosystem | MapLibre plugin landscape |
| github.com/openstreetmap/iD/blob/develop/ARCHITECTURE.md | iD editor architecture |
| sumo.dlr.de/docs/Networks/Import/OpenStreetMap.html | OSM import via netconvert |
| github.com/Open-TLC/websumo | WebSUMO current state |
