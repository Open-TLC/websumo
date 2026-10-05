# Edge-aggregate "network heat" layer — design note

A link-level visualization layer: colour each network edge by its live
speed / density / occupancy, streamed as a few scalars per edge rather than a
per-vehicle snapshot.

**Why this, why now.** The meso-visualization research (`MESO_VIZ_RESEARCH.md`)
concluded that mesoscopic state is natively *edge/segment-level flow–density*, not
vehicle positions — so the honest meso view is a link choropleth, not the cosmetic
glyphs we currently draw. But the more useful finding is architectural and
mode-independent: on `area3` we hit 1 Hz / 0.7× real-time not because SUMO was slow
but because the per-frame **vehicle snapshot** (build + JSON + publish) scales with
*vehicle count*. An edge-aggregate view scales with *occupied-edge count*, which is
far smaller under congestion (many vehicles collapse to one edge record). So this
one layer is simultaneously:

1. the correct way to visualise meso runs,
2. the foundation for OC-relevant queue/approach views, and
3. the fix for the city-scale wall we hit — **in micro too**.

It is *additive*: the vehicle snapshot stays; this is a second, cheap layer that the
adaptive-rate machinery can fall back to instead of going blank under load.

---

## 1. Protocol — additive, stays `v: 1`

Add one **optional** field to `sim.{scenario}.state`, alongside `events` /
`maxRate` / `inspect` (same backward-compatible precedent — unknown fields are
ignored, missing field = feature absent):

```json
{
  "v": 1,
  "t": 123.4,
  "vehicles": [ ... ],
  "edges": [
    ["24577881#0", 11.8, 42.0, 0.31, 0],
    ["-23904458",   2.1, 95.0, 0.88, 7]
  ]
}
```

`edges` — array, optional. Each entry: **`[edgeId, meanSpeed_m_s, density_veh_km, occupancy_0_1, halting_count]`**.

- **Only non-empty edges are published** (an edge with no vehicles this frame is
  omitted; the client renders missing edges as free-flow / uncoloured). This is the
  bound that makes it cheap: payload ∝ occupied edges, not total edges (`area3` has
  ~52k edges but only a few thousand are ever occupied at once) and not vehicles.
- Metrics chosen to be meaningful in **both** engines. `meanSpeed` and `density`
  come straight from the libsumo `edge` domain; `occupancy` is the robust congestion
  proxy. **Deliberately excluded:** halting/`waitingTime` — the research verifier
  killed its use in meso (meso has no instantaneous speed, so halting isn't reliably
  populated). Use occupancy/density for "queue", not waiting time.

Document this as `edges` in `SIM_PROTOCOL.md` under the state schema once built.

---

## 2. Backend — `sumo_adapter.py` frame build

Collect edge metrics in the **`full` branch of `_do_step`** (the same gate that
already builds `vehicles` — so it runs only on UI frames, not every sim step, and
inherits the adaptive rate for free). Right after the `vehicles` loop:

```python
# edge-aggregate heat (meso-honest + cheap: ~O(occupied edges), not O(vehicles)).
# Only edges with vehicles this frame; client treats missing as free-flow.
edges = []
for eid in traci.edge.getIDList():
    if eid.startswith(':'):            # skip internal/junction edges
        continue
    n = traci.edge.getLastStepVehicleNumber(eid)
    if n == 0:
        continue
    edges.append([
        eid,
        round(traci.edge.getLastStepMeanSpeed(eid), 2),
        round(n / (edge_len_m[eid] / 1000.0), 1),   # edge_len_m cached from lane.getLength at startup
        round(traci.edge.getLastStepOccupancy(eid), 3),
    ])
out['edges'] = edges
```

(Length can be cached once at startup rather than queried per frame.)

**✅ Slice 0 verified (micro vs meso, `fi.helsinki.269`, t=300).** Edge getters work
in meso:
- `getLastStepVehicleNumber` and **density** (veh/km): **identical** across engines
  (count-based) — rock-solid.
- `getLastStepOccupancy`: **identical** across engines — the most robust metric;
  **default the choropleth to this.**
- `getLastStepMeanSpeed`: present and sane in meso, but a **segment average** — it
  differs from micro's car-following speed (e.g. 5.4 vs 2.5 on the same edge). Fine
  for a speed ramp as long as it's labelled engine-relative, not a micro equivalent.
- `getLastStepHaltingNumber`: **does** return meaningful values in meso (2–3 on busy
  edges) — see caveat §6; this is the *live* getter, distinct from the `meandata`
  file `waitingTime` field the research flagged.
- Gotchas confirmed: **`traci.edge.getLength` does not exist** — use
  `lane.getLength` (cache once); **skip `:`-prefixed internal edges.**

**Cost:** bounded by occupied edges; one libsumo call set per edge. Expected to be
cheaper than the current vehicle loop whenever edges hold >1 vehicle on average
(i.e. exactly the congested regime where the vehicle snapshot hurts).

---

## 3. Geometry keying — one-line `network.py` change

The road network GeoJSON (`build_network_geojson`, ~line 243) emits one LineString
**per lane**, keyed by `lane.getID()` only. To colour by edge, add the edge id to
the lane props (the generator features already do exactly this at line 155):

```python
props = {'id': lane.getID(), 'type': ptype, 'edge': lane.getEdge().getID()}
```

Then the frontend groups lane features by `edge` and colours all lanes of an edge
by that edge's metric. (Alternative: derive edge from lane id by stripping the
`_<index>` suffix — but SUMO ids aren't guaranteed to make that safe, so prefer the
explicit prop.) Geometry is fetched once on Load and never changes — only the
per-frame scalars stream.

---

## 4. Frontend — `ws.ts` + `MapView.tsx`

**ws.ts:** add `edges` to the state type and thread it through `onStep`:

```ts
export type EdgeStat = [string, number, number, number]  // [id, speed, density, occ]
// onStep signature gains:  edges: EdgeStat[]
this.onStep?.(d.vehicles ?? [], d.tls ?? {}, d.detectors ?? {}, d.persons ?? [],
              d.t ?? 0, d.maxRate, d.edges ?? [])
```

**MapView.tsx:** build a `Map<edgeId, metric>` from `edges` each frame, then add a
deck.gl `PathLayer` (or `GeoJsonLayer`) over the road geometry:

- `getColor`: look up the feature's `edge` in the map → colour ramp (speed: green→red
  reversed; or density/occupancy: transparent→red). Missing edge → free-flow colour.
- Put the lookup behind `updateTriggers: { getColor: [frameMetricVersion] }` so only
  the colour buffer recomputes — geometry/positions never do (the research doc's key
  deck.gl perf lever).
- A small legend + a metric toggle (speed / density / occupancy).

**Mode-aware defaulting:** heat layer **on by default in meso**, optional in micro;
vehicle glyphs **demoted in meso** — badge them "approximate" and default them off
(they're cosmetic there). In micro, glyphs stay primary and heat is an optional
overlay. The backend can hint the mode by including e.g. `"engine": "meso"` in the
state (or the client infers from the presence of `edges` + absence of trustworthy
positions) — decide during slice 1.

---

## 5. Slices (incremental, cheapest-first)

0. **✅ Spike (done):** verified the `edge`-domain getters micro vs meso on
   `fi.helsinki.269`. Occupancy & density identical across engines; speed is a meso
   segment-average; halting works live. Final tuple: `[edgeId, meanSpeed, density,
   occupancy]`, default-colour **occupancy**. (See §2.) `area3`-scale confirmation
   folds into slice 1's validation.
1. **Heat channel + choropleth (core value):** `edges` in the frame build +
   protocol, `edge` prop in geometry, `PathLayer` coloured by the chosen metric,
   legend + toggle. Validate payload size and frame cost on `area3` meso **and**
   micro at ~6k vehicles.
2. **✅ Per-approach queue indicators (done):** `halting_count` added to the `edges`
   tuple (live meso-compatible queue measure); stoplines tagged with their `edge`;
   a `TextLayer` ('approach-queues') labels each controlled approach with its halting
   count (deduped to one label per edge, coloured amber→red by severity, shown when
   ≥1). **Per-link / per-group toggle** (`Q:LINK`/`Q:GRP`, shown only in OC mode):
   group mode aggregates halting over each OC signal group's distinct approach edges
   (via the `link_group` sigIdx→group join) and labels `"<group>:<n>"` at the mean of
   that group's stopline midpoints. Group halting is approximate — edge-level data
   mapped onto groups (a shared/ multi-edge group can't be split finer under meso).
   Per-link verified streaming/rendering (micro, 269). **Per-group needs OC mode
   (oc270) to have groups — visual eyeball still pending there.**
3. **Mode-aware glyphs:** demote/badge vehicle dots in meso; wire the default-on/off
   logic.
4. *(Later, not scheduled)* time–space / MFD / cumulative-curve analysis panels.

---

## 6. Caveats / open questions

- **Metric default:** speed is the most intuitive LOS colour; occupancy is the best
  congestion/queue proxy. Likely ship both with a toggle; default speed.
- **Payload at scale:** confirm occupied-edge count on `area3` under peak — expected
  low-thousands, each a 4-element array. If it's ever large, publish only edges whose
  metric *changed* beyond a threshold (delta encoding), mirroring how `det_on` only
  reports active detectors.
- **Halting in meso:** the *live* `getLastStepHaltingNumber` returns values in meso
  (slice-0 confirmed), so it's usable for queue indicators — but it's derived from the
  segment-average speed, so treat it as approximate. The research doc's refuted claim
  was about the `meandata` **file** `waitingTime` field, a different path; don't use
  that one.
- **Meso fidelity:** per the research, meso underestimates congestion and delays
  upstream queue build-up — annotate the legend ("meso: approximate") so the heat
  isn't over-trusted. Slice 1's micro-vs-meso comparison quantifies the gap.
- **Granularity:** this is edge-level, not segment-level. SUMO meso segments edges at
  ~100 m but the `edge` domain aggregates over the whole edge; sub-edge queue detail
  is out of scope here.

Tracked in `TODO.md` §4. Research basis: `docs/MESO_VIZ_RESEARCH.md`.
