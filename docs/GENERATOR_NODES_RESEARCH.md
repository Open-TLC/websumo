# Generator Nodes — Interactive Vehicle Injection
## Feasibility research

*Researched and verified 2026-07-02 against fi.helsinki.269 with libsumo 1.27.0.*

## The idea

Clickable "generator" markers at the upstream end of each approach edge.
Clicking one injects a single vehicle of a chosen type into the simulation at
that entry point. This gives interactive, per-vehicle demand control on top of
the background flows — useful for testing specific signal responses ("what
does the controller do when one tram arrives now?").

SUMO's own GUI has no click-to-spawn capability — vehicles come only from
route files or TraCI. This would be a genuinely new interactive feature.

## Feasibility: CONFIRMED

Verified by direct test against the Helsinki 269 scenario:

```python
libsumo.vehicle.add('manual_1', route_id, typeID='car',
                    depart='now', departLane='free',
                    departPos='free', departSpeed='max')
# → vehicle departed on the next simulation step, position valid
```

Also verified:
- **Runtime route creation** — `libsumo.route.add('rt', [from_edge, to_edge])`
  works, so injection is not limited to predefined routes
- **All vehicle types** — car, truck, tram all injectable (tram requires a
  tram-compatible route; see caveats)

### Key findings from testing

1. **`departLane='free'` / `departPos='free'` are required.** With the default
   `'base'` departure position, insertion silently queues if the entry cell is
   occupied — the vehicle sits in the pending list indefinitely under load.
   With `'free'`, SUMO picks any open slot and the vehicle departed within
   one step in testing.

2. **vClass compatibility is enforced.** Injecting a car onto a tram route
   raises `TraCIException: not allowed to depart on any lane of edge ...`.
   Generator nodes must therefore be typed: car/truck generators on car
   approach edges, tram generators on tram edges.

3. **Insertion can still queue under congestion.** If the whole approach is
   jammed, even 'free' insertion waits. `libsumo.simulation.getPendingVehicles()`
   exposes the queue, so the UI can show "queued" feedback rather than
   silently dropping the click.

4. **Vehicle IDs must be unique** across the whole run — a simple
   `manual_{counter}` in the adapter suffices.

## Design sketch

### Backend — network.py

Emit generator features at the upstream end of every entry edge (edges with
no incoming connections; in our networks these are the `approach_*` edges):

```python
# for each entry edge: Point at shape[0], plus which vtypes it accepts
{'type': 'Feature',
 'properties': {'type': 'generator', 'edge': edge_id,
                'vclasses': ['passenger', 'truck']},   # from lane allow masks
 'geometry': {'type': 'Point', 'coordinates': [lon, lat]}}
```

### Adapter — sumo_adapter.py

New command subject, ~20 lines:

```
sim.{scenario}.cmd.spawn    payload: {"edge": "approach_...", "vtype": "car",
                                      "dest": "exit_..." (optional)}
```

Handler logic:
1. Find routes starting with the given edge (cache `route_id → edges` at
   startup from `route.getIDList()` + `route.getEdges()`)
2. If `dest` given, pick the matching route (or `route.add` a runtime one);
   otherwise pick randomly among routes from that edge
3. `vehicle.add(f'manual_{n}', route, typeID=vtype, depart='now',
   departLane='free', departPos='free', departSpeed='max')`
4. Wrap in try/except — respond on an error subject or log; a jammed approach
   should not crash the adapter

Injected vehicles automatically appear in the existing `sim.{scenario}.state`
stream — no changes needed to the state message or vehicle rendering.

### Frontend — MapView + Controls

1. Render generator markers (deck.gl `ScatterplotLayer`, `pickable: true`) —
   e.g. green circles with a "+" at approach entries
2. `onClick` → publish `cmd.spawn` with the edge ID and the currently selected
   vehicle type
3. Vehicle type selector: a small toggle in the control panel (car / truck /
   tram) determining what a generator click injects
4. Optional later: click generator then click an exit to choose the
   destination; without it, destination is random among valid routes

### Effort estimate

| Piece | Size |
|-------|------|
| network.py generator features | ~25 lines |
| Adapter spawn command + route cache | ~30 lines |
| MapView markers + click handling | ~40 lines |
| Controls vehicle-type selector | ~20 lines |
| **Total** | **~1 day including testing** |

## Caveats

- **Tram destinations are constrained** — tram routes exist only between tram
  edges; the route cache handles this naturally by only offering valid routes
- **Spawn during paused state** — `vehicle.add` while paused is fine (the
  vehicle departs when stepping resumes), but the UI should indicate this
- **Injected vehicles are not persisted** — they exist only in the running
  simulation; a Reset removes them (this is the expected behaviour)
- **Traffic scale does not affect manual vehicles** — `simulation.setScale`
  only multiplies flow-based insertion, which is arguably the desired
  semantics (manual = exact)
