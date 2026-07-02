# Web Network Editor — Editing Architecture
## Extension of NETEDIT_WEB_RESEARCH.md

*Research completed: 2026-07-02. Extends prior report with concrete findings
on sumolib write-back capability, TraCI REST landscape, file sharing patterns,
and OC config coordination.*

---

## 1. The fundamental split: what sumolib can and cannot do

### 1.1 sumolib has no write-back

This is the most important finding. `sumolib.net.readNet()` produces a rich
in-memory object graph (`Net → Edge → Lane / Node / Connection / TLS`), but
**the `Net` class has no `write()`, `toXML()`, or `serialize()` method**.

The only serialisation that exists is on TLS objects:
- `TLSProgram.toXML(tlsID)` — emits a single `<tlLogic>` element with phases
- `TLS.toXML()` — emits all programs for one traffic light

Everything else — edges, lanes, nodes, connections, geometry — has no write
path through sumolib alone.
[source: `/usr/local/lib/python3.14/site-packages/sumo/tools/sumolib/net/__init__.py`
lines 65–205, 214–845]

### 1.2 The SUMO-canonical patch model

Every programmatic editing script in SUMO's own toolchain follows the same
pattern:
```
sumolib.readNet() → modify in-memory → write patch XML → netconvert subprocess
```
The key tool is `netdiff.py` (`tools/net/netdiff.py`): given two net.xml files,
it generates minimal diff files — `.nod.xml`, `.edg.xml`, `.con.xml`, `.tll.xml`,
`.typ.xml` — which netconvert can apply to the original:
```bash
netconvert --sumo-net-file original.net.xml \
           --node-files patch.nod.xml \
           --edge-files patch.edg.xml \
           --output-file updated.net.xml
```
This is the same round-trip that netedit itself uses internally. It is not a
workaround; it is the intended architecture.

### 1.3 The split that matters for implementation

| Edit type | Mechanism | netconvert needed? | Requires sim restart? |
|-----------|-----------|--------------------|-----------------------|
| TLS phase plan | sumolib `TLSProgram.toXML()` → write `.add.xml` | No | No (TraCI can apply live) |
| Lane speed / allow | TraCI `setMaxSpeed()`, `setAllowed()` | No | No (runtime only; persist via additional file) |
| Lane count change | patch `.edg.xml` → netconvert | Yes | Yes |
| Edge geometry | patch `.edg.xml` → netconvert | Yes | Yes |
| Junction connections | patch `.con.xml` → netconvert | Yes | Yes |
| Add/remove edge | patch `.edg.xml` + `.nod.xml` → netconvert | Yes | Yes |

**TLS editing is genuinely different from all structural edits.** It can be
done entirely without netconvert, applied live via TraCI for preview, and
persisted as an additional file. This makes it the right first editing feature
to implement — both because it is most useful for OC integration and because
it has the simplest implementation path.

---

## 2. The netconvert round-trip as a backend service

For structural edits, the backend endpoint would look like:

```
POST /api/network/{scenario}/edit
Body: { "type": "patch", "edges": [...], "nodes": [...] }

→ backend generates patch XML files in a temp dir
→ subprocess: netconvert --sumo-net-file {scenario}.net.xml
                         --edge-files patch.edg.xml
                         --output-file {scenario}.net.xml
→ reload GeoJSON via existing network.py pipeline
→ return updated GeoJSON to frontend
```

netconvert is already installed (it ships with SUMO) and runs in ~100–500ms
for intersection-scale networks. The round-trip is fast enough for interactive
editing if triggered on explicit user save, not on every drag.

**What netconvert does that raw XML editing cannot:**
- Rebuilds junction shapes (the polygon fill around intersections)
- Recomputes implicit connections when lane count changes
- Validates road type constraints
- Recalculates internal lanes (the `_0` suffix lanes through junctions)

Skipping netconvert and editing net.xml directly with string manipulation
would produce a structurally invalid file.

---

## 3. File sharing between WebSUMO, SUMO, and OC

### 3.1 Current state

All three processes already share `/tmp/shared/sumotest/` as a filesystem
mount. This is the simplest possible coordination mechanism and it works for
the current read-only scenario: SUMO reads files at startup, WebSUMO reads
them to build GeoJSON, OC reads `oc_controller.json` at startup.

### 3.2 The editing problem

Adding editing introduces write concurrency. The risks are:

- WebSUMO's backend writes `fi.helsinki.269.net.xml` while SUMO has it open
- netconvert writes a new `net.xml` while OC is reading `oc_controller.json`
  (which references lane IDs from the network — if lane IDs change after a
  netconvert rebuild, the OC config is silently invalid)
- Two browser sessions (if multi-user) submit conflicting edits simultaneously

### 3.3 Practical options

**Option A — Shared filesystem + atomic file swap (simplest)**

Write edits to a temp file, then `os.replace()` (atomic on POSIX). SUMO and
OC are only reading at startup, so mid-run edits do not conflict. Editing only
applies after simulation restart.

```
edit → write to {scenario}.net.xml.tmp → os.replace() → notify frontend to reload
```

Coordination rule: editing is locked while a simulation is running. WebSUMO
already enforces this implicitly (Load is disabled while active). The constraint
becomes: you must Stop or Reset before editing is allowed.

This is sufficient for the near-term use case and requires no new infrastructure.

**Option B — Version-controlled scenario directory**

Each scenario is a git repository. Edits become commits. OC configs and net.xml
are co-versioned. If a structural edit changes lane IDs, the OC config is
checked/updated in the same commit.

```
edit committed → git hook validates OC config consistency → push → reload
```

Pros: full audit trail, branch-based experimentation, diff between versions.
Cons: adds git dependency, complicates the "just edit and reload" workflow.
Worth considering for production but overkill for the current stage.

**Option C — Session-scoped working copies**

Each editing session gets a working copy of the scenario directory. Edits are
applied in the copy. The user explicitly publishes the copy back to the shared
directory when satisfied.

```
start edit session → copy {scenario}/ to /tmp/edit-{session}/ →
edit in working copy → preview simulation from working copy →
publish → copy back to shared dir
```

Pros: isolated, safe to experiment, simulation preview without affecting others.
Cons: more disk use, more complex lifecycle management.

**Recommendation:** Start with Option A. The constraint that editing requires
the simulation to be stopped is acceptable and already implied by the UI.
Move to Option C if multi-user or long-running editing sessions become a
requirement.

### 3.4 OC config coordination — the hard constraint

This is the most important file-sharing concern. The OC config
(`oc_controller.json`) references SUMO IDs directly:
- `"sumo_name": "junction_fi.helsinki.269"` — junction ID
- Detector IDs that reference lane IDs (e.g. `approach_bbdbb89e38bf_car_0`)
- Signal group state strings indexed by signal head position

**If a structural edit changes lane IDs** (which netconvert may do when lane
count or edge geometry changes), the OC config becomes silently wrong. The
simulation will run with mismatched detector wiring and the controller will
not see the traffic it expects.

**Mitigations:**
1. For the short term: prohibit structural edits to edges that OC detectors
   reference. WebSUMO can read `oc_controller.json` and grey out those edges.
2. Medium term: after each netconvert rebuild, run a validation script that
   checks all OC-referenced IDs still exist in the new net.xml and reports
   any that have changed.
3. Long term: if lane IDs change, regenerate the OC config from the ITC data
   (re-run `graph2sumo` controller.py). This is only possible if the original
   ITC source data is available.

The graph2sumo pipeline already generates both files from the same source:
`build_and_extract.sh --repo fi.helsinki.269` produces `fi.helsinki.269.net.xml`
and `oc_controller.json` atomically. Treating edits to the network as
"diverging from the canonical build" — and making the divergence explicit —
is the cleanest mental model.

---

## 4. Generic vs. specific TraCI interface

### 4.1 What has been tried

**TraaS (TraCI as a Service):** A Java SOAP web service over TraCI exposing
~150 specific methods across most TraCI domains. The only HTTP-based TraCI
wrapper that reached any level of completeness. **Officially deprecated
November 2023** (SUMO issue #14026); the recommendation is to use libtraci
or libsumo instead. [sumo.dlr.de/docs/TraCI/TraaS.html]

**No REST/JSON wrapper exists.** Extensive search found no maintained
HTTP-JSON wrapper over TraCI. sumo-web3d (Sidewalk Labs, archived 2023)
used WebSocket for vehicle/person position streaming only.

**Generic parameter interface (0x7e):** TraCI does have a generic
`getParameter`/`setParameter` mechanism supported by 10 domains. However
all values are **strings only** — no typed variables. It covers user-defined
custom parameters and device attributes (e.g. battery level), not the full
typed getter/setter API. A proposal for a full generic interface (issue
#2344, opened May 2016) remains unimplemented with no assignee.
[sumo.dlr.de/docs/TraCI/GenericParameters.html]

### 4.2 Why a fully generic TraCI API endpoint is impractical

TraCI has ~20 domains, each with distinct typed variables:
- Simple scalars: int, float, double, string
- Colour: 4-byte RGBA struct
- 2D/3D positions
- Shape: list of 2D positions
- Compound objects: route stages, TLS program definitions, subscription results

There is no canonical serialisation format across all of these. Building a
generic `POST /api/traci { domain, object_id, variable, value }` endpoint
would require a type registry, per-variable validation, and serialisation
for every value type. This is essentially reimplementing TraCI's wire protocol
in JSON — a substantial project that would duplicate TRAAS (SOAP, deprecated)
without improving on it.

The type-heterogeneity is not accidental complexity; it reflects that "set
vehicle speed" (a float) and "set TLS phase plan" (a compound object with
phases, durations, and state strings) are fundamentally different operations
that warrant different API shapes.

### 4.3 The recommended approach: specific endpoints, added incrementally

Rather than a generic interface, add specific FastAPI endpoints for each
TraCI operation that WebSUMO actually needs, one at a time. Each endpoint
has a typed, validated request body and a clear purpose:

```python
# Already in session.py (scale command):
elif cmd == 'scale':
    v = max(0.1, min(float(msg.get('v', 1.0)), 5.0))
    session.pending_scale = v

# Next to add (TLS):
@api.post('/session/tls/{tls_id}')
async def set_tls_program(tls_id: str, program: TLSProgramModel) -> dict:
    ...

# Later (lane speed):
@api.patch('/session/lane/{lane_id}/speed')
async def set_lane_speed(lane_id: str, speed: float) -> dict:
    ...
```

This is not a limitation — it is the correct design. Each endpoint documents
exactly what it does, validates its input, and can be added and tested
independently. The "as we go" approach the user described is the right one.

**What does need a shared abstraction** is not the TraCI call itself but
the persistence layer: when a TraCI change is applied, should it also be
written to a file so it survives simulation restart? That question deserves
a consistent answer per edit type (see section 3.3).

---

## 5. Design patterns from OSM editors

### 5.1 iD editor changeset model

iD (the OpenStreetMap browser editor) uses an OsmChange diff format:
```xml
<osmChange version="0.6" generator="iD">
  <create><node id="-1" lat="51.5" lon="-0.1">...</node></create>
  <modify><way id="12345" version="3">...</way></modify>
  <delete><node id="99999" version="1"/></delete>
</osmChange>
```
Key design choices:
- **Full element replacement** in modify blocks (no field-level diff)
- **Negative IDs** for new elements (server assigns real IDs and returns them)
- **Transactional:** all-or-nothing per upload call
- **Changeset scoping:** session-level grouping of related edits

This model maps cleanly onto SUMO editing. Instead of OSM API upload, the
transaction goes to the WebSUMO backend which writes patch XML and runs
netconvert. The changeset concept is useful for grouping related edits (e.g.
"adjust lane count on approach arm" = modify 3 edges + reconnect junction).

### 5.2 JOSM remote control

JOSM exposes ~12 GET endpoints on `localhost:8111` for loading data
(`open_file`, `import`, `load_data`), creating elements (`add_node`,
`add_way`), and exporting the current layer as OSM XML. It **cannot write
to disk** — export returns the layer content in the HTTP response body.

The relevant design lesson: **export as HTTP response body, not file write**.
WebSUMO's `GET /api/network/{scenario}` already follows this pattern for
GeoJSON. Adding a `GET /api/network/{scenario}/net.xml` endpoint that serves
the raw net.xml is a useful addition for debugging and for feeding back into
JOSM if needed.

---

## 6. Revised implementation plan

### Phase 0 — Foundation (no new dependencies)

Add to WebSUMO backend:
- `GET /api/network/{scenario}/net.xml` — serve raw net.xml file
- `GET /api/network/{scenario}/tls` — return all TLS programs as JSON
  (using `sumolib.readNet()` and `TLSProgram` attributes)
- Editing lock: reject edit endpoints if a session is active

### Phase 1 — TLS editing (highest value, no netconvert)

```
GET  /api/network/{scenario}/tls              → list TLS programs
GET  /api/network/{scenario}/tls/{tls_id}     → get one program
PUT  /api/network/{scenario}/tls/{tls_id}     → save to .add.xml
POST /api/session/tls/{tls_id}               → apply via TraCI (live preview)
```

Persistence: write `{scenario}.tls.xml` using `TLSProgram.toXML()`. Reference
it from the `.sumocfg` as an additional file. No netconvert required.

Live preview: apply via `traci.trafficlight.setCompleteRedYellowGreenDefinition()`
while simulation is running. Save separately from preview.

**OC config impact:** TLS phase edits are exactly what OC controls at runtime.
A TLS edit in WebSUMO changes the *default* (fixed-time) TLS plan that SUMO
uses when OC is not running. OC overrides it dynamically. No OC config change
needed for this edit type.

### Phase 2 — Lane property editing (TraCI, no structural change)

```
PATCH /api/session/lane/{lane_id}   { speed?, allow?, disallow? }
```
Applied via `traci.lane.setMaxSpeed()` / `setAllowed()` at runtime. Persisted
to `{scenario}.lane_overrides.xml` as an additional file so they survive restart.

No netconvert. No OC config impact (lane IDs unchanged).

### Phase 3 — Structural editing (netconvert round-trip)

```
POST /api/network/{scenario}/edit
Body: OsmChange-inspired { create: [...], modify: [...], delete: [...] }
```

Backend:
1. Parse edit request
2. Generate patch XML files (`.edg.xml`, `.nod.xml`, `.con.xml`)
3. Run netconvert subprocess
4. Validate OC config against new net.xml (check all referenced IDs exist)
5. Return updated GeoJSON + any OC validation warnings

**Only enabled when no simulation is running** (enforced by the editing lock).

### Phase 4 — Frontend editing UI

Terra Draw integration in MapView (as established in prior research):
- Select mode: click to select edge/junction, show property panel
- TLS editor: phase ring table, duration sliders, state string editor
- Edge editor: lane count stepper, speed input, allow/disallow checkboxes
- Geometry edit: drag shape points (Terra Draw linestring mode)

All editing UI sends to the Phase 0–3 API endpoints above. The frontend
does not need to know whether the backend uses TraCI, sumolib, or netconvert.

---

## 7. Open questions remaining

1. **Lane ID stability across netconvert rebuilds:** When does netconvert
   change lane IDs? If adding a lane to an edge always appends (`_0`, `_1`,
   `_2` → `_0`, `_1`, `_2`, `_3`) and never renumbers, OC config stability
   is much more tractable. This needs a test against the Helsinki scenarios.

2. **Performance of netconvert at intersection scale:** For a single
   intersection (269/270 size), how long does the netconvert subprocess take?
   If <1 second, the editing loop is interactive. If >5 seconds, a loading
   state is needed. Benchmark before building the UI.

3. **Multiple TLS controllers per scenario:** Helsinki scenarios have multiple
   junctions. The TLS editor UI needs to handle selecting one junction out
   of several, and saving separate TLS programs. The `oc_controller.json`
   covers all junctions in one file. This multi-entity management needs a
   clear UX design.

---

## Sources

| Source | Finding |
|--------|---------|
| sumolib net/__init__.py lines 65–845 | No write-back on Net; TLSProgram.toXML() exists |
| sumolib tools/net/netdiff.py | Canonical patch/diff model for network editing |
| sumolib tools/net/patchVClasses.py | Example of sumolib read + patch write pattern |
| sumo.dlr.de/docs/TraCI/TraaS.html | TraaS SOAP service, deprecated Nov 2023 |
| github.com/eclipse-sumo/sumo/issues/14026 | TraaS deprecation issue |
| sumo.dlr.de/docs/TraCI/GenericParameters.html | 0x7e string-only generic parameter interface |
| github.com/eclipse-sumo/sumo/issues/2344 | Full generic TraCI interface proposal, open since 2016, unimplemented |
| wiki.openstreetmap.org/wiki/OsmChange | OsmChange diff format used by iD editor |
| wiki.openstreetmap.org/wiki/API_v0.6 | OSM API changeset upload protocol |
| wiki.openstreetmap.org/wiki/JOSM/RemoteControl | JOSM localhost:8111 remote control commands |
| josm.openstreetmap.de/wiki/Help/RemoteControlCommands | Full JOSM remote control endpoint list |
