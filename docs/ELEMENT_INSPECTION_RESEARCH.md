# Element Inspection in WebSUMO
## Feasibility research — click an element, see (and maybe edit) its properties

*Researched and verified 2026-07-03 against fi.helsinki.269 with sumolib/libsumo 1.27.0.
This is the web equivalent of sumo-gui's right-click → "Show Parameter" dialogs.*

## 1. What the tools expose, per element kind

Two complementary sources, mirroring the split already used everywhere in
WebSUMO: **sumolib reads the files** (static structure, available after Load,
no simulation needed) and **libsumo reads the running simulation** (dynamic
state, available between Start and end).

### Vehicles — libsumo `vehicle`: 106 getters (live only)

A full 27-field inspect measured **0.13 ms** — cheap enough to stream every
step for a selected vehicle. Highlights beyond what we already show:

| Group | Fields (verified) |
|-------|-------------------|
| Identity | typeID, vClass, length/width, route ID + edge list + current index |
| Motion | speed, allowedSpeed, acceleration, lane + lane position, signals (blinkers/brake) |
| Timing | departure time, depart delay, waiting time, accumulated waiting, **timeLoss**, odometer (getDistance) |
| Context | **getLeader** (id + gap), followers, **getNextTLS** (junction, link, distance, current signal!), nextLinks, junction foes |
| Emissions | CO₂, CO, NOx, PMx, HC, fuel, electricity, noise — per step, mg/s |
| Behaviour | speedFactor (per-vehicle randomness), tau, minGap, stop state, lane-change state |

`getNextTLS` is particularly good for a signal tool: the inspector can show
"this car is 1.0 m from junction X, facing red on link 6".

### Persons/pedestrians — libsumo `person`: 51 getters (live only)

Full API exists (position, stage, remaining stages, walking distance, the
vehicle they're riding). **Our scenarios contain zero persons** — graph2sumo
generates only vehicle flows (a `pedestrian` vType is defined but unused).
The inspector should support the kind, but it stays empty until demand
generation adds person flows.

### Road segments — both sources

**sumolib (static, after Load):** edge → name, type, function, **priority**,
speed limit, length, lane count, from/to node, generic `<param>`s; lane →
width, speed, **permission set** (vClass allow/disallow), shape, outgoing
connections with **direction (l/r/s), TLS ID and signal index**; node → type
(`traffic_light`/`priority`/...), fringe, incoming/outgoing edges,
connection/foe logic.

**libsumo (live):** lane/edge → occupancy %, vehicle count + IDs, halting
count, mean speed, waiting time, travel time, all emissions aggregated,
pending vehicles; `lane.getLinks` (verified) → per connection: target lane,
via internal lane, priority, open/closed **right now**, foe, **current signal
state**, direction, length. Verified lane inspect: 13 fields in **0.24 ms**.

### Traffic lights — libsumo is strictly richer than sumolib here

Live: current program, phase index, phase name, `getNextSwitch` (absolute time
of next change — the inspector can show a **countdown**), full program logic
(`getAllProgramLogics`: phases with durations/minDur/maxDur), controlled
links/lanes, `getBlockingVehicles`/`getRivalVehicles` per link, spent duration.
Static (sumolib, `withPrograms=True`): the same program table pre-Start,
plus signal-index → stop-line mapping (already used for rendering).

### Detectors — libsumo `inductionloop` (live) + XML (static)

Live: lane, position, `getTimeSinceDetection`, last-step + interval counts,
mean speeds, occupancy, `getVehicleData` (per crossing: vehicle ID, entry/exit
time, length). Static: the `{scenario}.detectors.xml` we already parse.

### Demand — files only (see §2)

`sumolib.xml.parse` reads the route file generically (verified):
28 flows with route, vType, vehsPerHour, begin/end; 4 vTypes with vClass,
length, maxSpeed. This enables a demand inspector: click an approach → show
the flows feeding it.

### How to represent it

- **Selection:** deck.gl layers are already used for vehicles, stop lines and
  detectors — making them `pickable` is a flag. Lanes/junctions render via
  MapLibre; either query rendered features on click or add a transparent
  pickable deck.gl overlay from the same GeoJSON (cleaner, one picking path).
- **Panel:** a right-side inspector card (the LOG overlay pattern), sections
  *Static* and *Live*. Static fields come from an extended network GeoJSON
  (embed edge/lane/node attributes as feature properties — no new endpoint
  needed) or a small `/api/inspect/{scenario}/{kind}/{id}` (sumolib, works
  without a simulation).
- **Live fields:** new command `sim.{scenario}.cmd.select` `{kind, id}`
  (fire-and-forget, consistent with the existing command style). The adapter
  keeps one selected element and attaches an `inspect` block to each state
  message (~0.1–0.3 ms, negligible). Deselect on click-away or when the
  element disappears (vehicle arrives). This also gives OC or any NATS client
  the same inspection stream for free.
- **Kinds for v1:** vehicle, lane (with its edge's static attrs), junction/TLS,
  detector. Persons when demand exists.

## 2. Missing pieces — not available via the live connection

Confirmed by API enumeration against 1.27.0:

| Missing live | Where it lives | Workaround |
|---|---|---|
| **Demand definitions** — flows (vehsPerHour, begin/end), route→flow mapping | `.rou.xml` only; no libsumo flow domain (flows appear only as materialized vehicles) | `sumolib.xml.parse` (verified) |
| Edge **priority**, **function**, name*, type | `.net.xml` | sumolib (parsed already) |
| Node/junction **type** (traffic_light/priority/…), fringe, foe matrix | `.net.xml` — live `junction` domain has only position/shape/incoming/outgoing | sumolib |
| Connection extras (keepClear, contPos, custom allow) | `.net.xml` | sumolib |
| Raw (pre-netconvert) geometry, `getRawShape` | `.net.xml` | sumolib |
| Detector config beyond lane/pos (period, output file) | `.detectors.xml` | ElementTree (parsed already) |
| sumocfg options | file; partially via `simulation.getOption` | file |
| Provenance (graph2sumo intersection graph, OSM origin) | not in any SUMO file — only encoded in our ID naming convention | helsinki_intersections repo |

*`edge.getStreetName` exists live; our networks have empty names.

Conversely everything dynamic is live-only — so a useful inspector **needs
both sources**, exactly like the log viewer needed both channels. The static
half works after Load with no simulation; the live half augments it after
Start. Same element, one panel, two data sources.

## 3. Is the inspector the right place to add editing?

**Yes for runtime parameters; no for structure.** The inspector is the natural
edit surface for exactly the fields libsumo can set — verified live:

| Edit | Verified call | Effect |
|---|---|---|
| Lane speed limit | `lane.setMaxSpeed` | immediate |
| Lane permissions | `lane.setAllowed` | immediate |
| TLS phase durations / full program | `trafficlight.setProgramLogic` | immediate |
| Force TLS phase | `trafficlight.setPhase` | immediate (OC-style control) |
| Vehicle behaviour (speed, type, route, speedFactor…) | `vehicle.set*` (48 setters) | immediate |
| vType defaults for future vehicles | `vehicletype.set*` (26 setters) | immediate |

Each edit is one small `sim.{scenario}.cmd.set` handler in the adapter —
the incremental-subjects approach already agreed in the roadmap.

**The honest caveat: these edits are runtime-only.** They die with the
simulation. Three persistence tiers follow from the earlier editing research
(`NETEDIT_EDITING_ARCHITECTURE.md`):

1. **Runtime tweaks (build now):** editable fields in the inspector, applied
   via libsumo, marked with a "this run only" badge. Zero file machinery.
2. **Persistable domains (natural next step):** the files we already own as
   plain XML — TLS programs (`tlLogic` in an additional file, no netconvert
   needed), flows (`.rou.xml`, we already rewrite it for duration stretching),
   detectors (`.detectors.xml`). A "save as scenario variant" button covers
   the main real-world need: tuning signal timings and demand.
3. **Structural edits (defer):** geometry, lanes, connections — require the
   netconvert round-trip; this is the web-netedit longer-term item and
   should not be smuggled in through an inspector panel.

**Better options considered:** a separate edit mode/page (netedit-style) is
the right home for tier 3 only — for tiers 1–2 it would duplicate the
inspector's selection UI and lose the killer feature: *observing the live
effect of a change on the running simulation next to the values you changed*.
Editing config files directly (netedit on the desktop, text editor) remains
available and unaffected since files stay the source of truth.

## Recommended scope for a first implementation (~1–1.5 days)

1. Pickable vehicles + detectors + junction/TLS + lanes; inspector panel with
   static section (GeoJSON properties, extended in `network.py`)
2. `cmd.select` → `inspect` block in state messages; live section updates per step
3. TLS view: program table, current phase highlighted, next-switch countdown
4. No editing in v1 — add tier-1 edits (lane speed, TLS durations) as the
   first follow-up, then evaluate tier-2 persistence

## Caveats

- libsumo getters throw on vanished IDs (arrived vehicle) — the adapter must
  try/except the inspect block and auto-deselect
- Vehicle IDs are per-run; a selection does not survive Reset
- Emissions are the default HBEFA model values — indicative, not calibrated
- Person inspection is dormant until demand generation produces person flows
