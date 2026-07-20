# Demo Plan — Floating-Car Egocentric Knowledge Graphs over NATS

*Branch: `v2x_experiments`. Highly experimental. Goal: a first working demo of
per-vehicle (egocentric) dynamic knowledge graphs, extracted from SUMO, grounded
on the static intersection graph, streamed as JSON-LD over NATS, and visualized.
Background & prior art: `DYNAMIC_VEHICLE_KG_RESEARCH.md`.*

## Goal

Mark selected SUMO vehicles as **floating cars** (probes). For each, build the
egocentric graph of what it "sees" (`:onLane`, `:following`, `:approaching`,
`:sees`), grounded on the shared static infrastructure IRIs, publish it as
**JSON-LD** over NATS, and **visualize** it in the browser. This is the smallest
end-to-end slice of the "shared infra graph + per-vehicle dynamic layer" idea.

## Design principle: grounding is a swappable seam (sim vs. real)

The ID→IRI grounding is trivial in SUMO only because SUMO hands us `getLaneID()`.
In the real world a vehicle has **GPS + heading** and must **map-match** onto the
infrastructure graph — error-prone (GPS ~2–5 m vs lane width ~3.5 m), so
`:onLane` becomes *probabilistic*. We do NOT solve that now, but we design for it:

- Grounding lives behind one function `ground(observation) → {IRI, confidence, alternatives}`.
  Demo impl = id lookup, `confidence 1.0`. Future impl = GPS map-match.
- Every dynamic triple carries a `confidence` field (1.0 in sim) so the schema is
  real-world-ready without re-modeling.
- SUMO is the ideal testbed to *quantify* grounding error later: it has both the
  true position and the true lane label, so we can inject GPS noise, run a
  map-matcher, and measure accuracy + downstream merge quality. (Not in this demo.)

## Components

### A — Configurable floating-car selection
A pluggable predicate in the adapter, `is_fcd(vid)`, from a config string:
- `manual` — generator-injected vehicles (`manual_*`) — **default** (interactive).
- `fraction:N` — random N of flow vehicles.
- `vtype:X` / `ids:...` — explicit.
Passed in the start request (like `scale`/`speed`).

### B — Egocentric extraction via libsumo (extend `sumo_adapter.py`)
`_ego_graph(vid, net)` — most of it is already computed:
- ego: `onLane`, `onEdge`, `speed`, `heading`, position (`getLaneID/Speed/Angle/Position`)
- `following`: leader IRI + `gap` (`getLeader`)
- `approaching`: next signal-group IRI + `distance` + `state` (`getNextTLS`)
- `sees`: vehicles within radius R (≈50 m) each with its lane IRI (`getNeighbors`/filter)
- grounding via component D; meta: `t`, `confidence` (1.0)
Publish per FCD vehicle on `kg.{scenario}.fcd.{vid}` at a configurable rate (~3 Hz).

### C — JSON-LD payload
JSON-LD = JSON for the UI + valid RDF via `@context`. One message = one probe's
egocentric snapshot; lane/junction values are IRIs into the static graph.
Minimal vocab first; SOSA/SSN provenance optional later.

### D — Grounding (ID → IRI)
Demo: a lookup built at adapter start, SUMO id → IRI, behind `ground(id)`.
**Gate task (Phase 0): confirm the mapping exists** — does the intersection `.ttl`
carry lane/edge/junction IRIs, and does graph2sumo's naming map to them
deterministically? Read `helsinki_intersections` + graph2sumo naming; do not modify them.

### E — Receiver + visualization (extend WebSUMO)
- Relay `kg.{scenario}.fcd.*` through the FastAPI WS (same as `state`/`log`/`inspect`).
- Click a floating car → overlay its egocentric graph on the map: line to leader
  (`following`), line to next signal (`approaching`, colored by state), thin links
  to neighbors (`sees`); a side panel shows the raw JSON-LD.
- Reuses the existing deck.gl map + selection/inspector.

## Decisions (defaults)

| Decision | Default | Why |
|---|---|---|
| FCD selection | `manual` (+ optional `fraction`) | interactive, reuses generators |
| Emit rate | ~3 Hz (configurable) | graphs heavier; eye doesn't need 10 Hz |
| Neighbor radius | 50 m | plausible sensing range; tunable |
| Payload | JSON-LD | JSON for UI, RDF for semantics |
| Viz | overlay on existing map + JSON-LD panel | reuses deck.gl + inspector |
| Location | websumo (`v2x_experiments`); read-only on graph repos | that's where stream + viewer are |

## Build order (smallest-first)

0. **Grounding check** — confirm SUMO id → `.ttl` IRI mapping is clean. *(gate)*
1. **Adapter** — `is_fcd` selector + `_ego_graph` + publish JSON-LD on `kg.{scenario}.fcd.{vid}`; verify with `nats sub`.
2. **Relay + raw JSON-LD panel** for a selected floating car. *(first light)*
3. **Map overlay** — leader / approaching / neighbor links. *(demo)*

## Out of scope for this demo (future)
- Real GPS map-matching + grounding uncertainty (design seam is in place).
- V2V merge of two egocentric graphs on shared IRIs, identity resolution, conflict/time-sync.
- RSP engine / persistent triple store, retention at scale, CPM/LDM interop mapping.
