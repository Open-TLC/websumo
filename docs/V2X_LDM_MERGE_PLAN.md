# Plan — Merging Egocentric Graphs into a Shared Local Dynamic Map

*Branch: `v2x_experiments`. Follows `V2X_FCD_EGO_GRAPH_DEMO_PLAN.md` (per-vehicle
egocentric graphs are done). Goal: fuse the floating cars' egocentric graphs into
one shared **Local Dynamic Map (LDM)** — the first "collective perception" slice.*

## The idea

Each floating car publishes a first-person (egocentric) graph grounded on the
**shared infrastructure IRIs** (and, in sim, shared vehicle IRIs). Merging is then
mostly RDF set-union: the same `connection/…` or `veh:…` node in two graphs is the
*same node*. That coalescence is why we grounded everything to shared IRIs. The
merge produces a view richer than any single car's — the CPM/LDM value.

## Decisions (from discussion)

| Decision | Choice |
|---|---|
| Scope | Build the **all-probes** shared LDM; frontend can **filter to a pair** |
| Fusion site | **Separate NATS actor** `backend/fcd_fusion.py` (infra/edge fuses reports) |
| Provenance | Light `observedBy` + corroboration now; SOSA-mappable (schema already imports SOSA/SSN) |
| Object localisation | From **observations** (probes report neighbour lon/lat), not only self-reports |

## Merge semantics

An ego graph is first-person, so **the observer is implicit = its `@id`**. The
fusion node decomposes each incoming graph into subject-attributed facts:

- self-node (`veh:A`: onLane, pos, speed, heading) → a **self-report** by A (conf 1.0)
- each `sees[i]` about `veh:B` → an **observation of B by A** (lon/lat, speed, lane, range)
- `following` / `approaching` → A's relations to a leader / a `connection` (kept as A's contribution)

Across observers, everything keyed by the **shared subject IRI** collapses to one
object node carrying:

- `observedBy`: distinct probes with info on it (self counts)
- `sources` = |observedBy|; `confirmed` = `sources ≥ 2` (independent corroboration)
- a consensus `lon/lat/onLane/speed` (self-report preferred; else fused from observers)
- `isProbe`: whether the object is itself a floating car

### The honest sim-vs-real seam: data association
In sim, "A sees B" already uses B's real id, so cross-car **association is free and
perfect** — we key the merge on the shared IRI. In reality A only has "an object at
P" and must decide if it's the same object B saw (**data association**) — the hard
part of real CPM. Same shape as the grounding seam. Not solved now; SUMO is the
ideal place to later inject association noise and *measure* fusion quality.

## Message shape — `kg.{scenario}.ldm`

```json
{ "@context": { "@vocab":"…oct#", "veh":"urn:sim:{scenario}:veh:", "onLane":{"@type":"@id"} },
  "@id": "urn:sim:{scenario}:ldm", "@type": "LocalDynamicMap",
  "t": 123.4,
  "observers": ["flow_1.2","flow_3.0"],
  "objects": [
    { "@id":"veh:flow_5.1", "onLane":"…/exit/…/lane/D1",
      "lon":24.9, "lat":60.1, "speed":7.3,
      "observedBy":["flow_1.2","flow_3.0"], "sources":2, "confirmed":true, "isProbe":false },
    …
  ] }
```

The LDM is the **semantic** layer (who perceives whom, corroboration, fused
position). Ground-truth geometry still comes from the `state` stream — the map
joins them, so "collectively perceived" objects appear as a colored subset of all
traffic.

## Architecture

```
adapter (each probe) --kg.{sc}.fcd.{vid}--> NATS --> fcd_fusion (edge node)
                                                        |  kg.{sc}.ldm
                                              relay (main.py) --> browser
```

Fusion node lifecycle = the adapter's: `main.py` spawns `fcd_fusion.py` alongside
the adapter on `/adapter/start`, kills it on `/adapter/stop`.

## Build order (smallest-first)

1. **Adapter**: add `lon/lat/speed` to `sees` entries (cheap; enables observation
   localisation). *(prep)*
2. **Fusion node** `backend/fcd_fusion.py`: subscribe `kg.{sc}.fcd.>`, keep latest
   graph per probe in a short TTL window, and on a ~3 Hz tick emit the merged LDM
   on `kg.{sc}.ldm`. Verify with `nats sub`. *(first light)*
3. **Lifecycle + relay**: spawn/kill fusion in `main.py`; forward `ldm` to the
   browser like `fcd`.
4. **Viz**: an "LDM / shared map" toggle — draw a perception halo on each vehicle
   colored by `sources` (grey unseen / amber single-source / green confirmed); with
   two probes selected, shade A-only / B-only / both. A panel shows observers,
   #perceived, #confirmed, raw JSON-LD.

## Out of scope (future)
- Real data association + localisation uncertainty (seam in place).
- Full SOSA observation reification; RSP/triple-store persistence.
- Conflict detection across probes on conflicting `oct:Connection`s (natural next).
