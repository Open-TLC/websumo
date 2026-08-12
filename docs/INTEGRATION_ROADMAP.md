# WebSUMO + Open Controller — Integration Roadmap

*Status: planning / pre-integration. Last updated: 2026-07-03.*

---

## Current state

WebSUMO runs SUMO **in-process via libsumo** inside a standalone adapter
(`backend/sumo_adapter.py`), which drives `simulationStep()` and publishes
`{t, vehicles, tls, detectors}` to NATS (`sim.{scenario}.state`, plus `.end`
and `.log`); a FastAPI WebSocket relay forwards that to the browser and
forwards browser commands (`sim.{scenario}.cmd.*`) back. So **Option 1 below
(a NATS publishing layer) is already done** — WebSUMO is a NATS
publisher/subscriber, not a TraCI socket owner. The Open Controller (OC) is a
separate NATS-native project. The remaining integration work is the OC-facing
subject bridge (detector republish + signal-command intake — TODO item 2), not
the transport, which is why the option analysis below is now about *who owns
the SUMO process*, with the NATS substrate taken as given.

> The subsections below predate the migration and are kept for the option
> analysis (who should own the simulation). Where they say `session.py`, read
> `sumo_adapter.py`; where they say `sim.state.<scenario>` / `sim.cmd.<scenario>`,
> the shipped subjects are `sim.{scenario}.state` / `sim.{scenario}.cmd.*`.

---

## Decision context

Before committing to a deep integration, we want:

1. **Stable interfaces in WebSUMO** — the NATS topic schema, command protocol,
   and WebSocket message format should be settled and treated as a public API
   before anything external depends on them.
2. **Alignment with OC's own roadmap** — which integration pattern makes sense
   depends on where OC's architecture is heading (simengine vs. distributed
   mode, NATS topic naming conventions, etc.). That is beyond the current scope
   of WebSUMO work and needs a joint decision.
3. **No premature coupling** — it is better to have two well-defined independent
   tools with clear interfaces than a tightly coupled system built on assumptions
   that may change.

---

## Options

### Option 0 — Status quo (no integration)
Run WebSUMO and OC as completely independent tools against separate SUMO
instances. No shared state, no shared process. Simple but limits the use case:
you cannot see OC-controlled signals in the WebSUMO viewer.

**When appropriate:** during active development of either tool, or when the
simulation scenario does not require OC signal control.

---

### Option 1 — NATS publishing layer in WebSUMO ✅ *(DONE)*

The adapter publishes `{t, vehicles, tls, detectors}` to `sim.{scenario}.state`
each step and subscribes to `sim.{scenario}.cmd.*` for commands. `nats-py` is a
dependency; the browser talks to the adapter only through the FastAPI relay.

**What this enabled:**
- OC's control engine can subscribe to state and publish commands without
  touching WebSUMO's internals
- Foundation for all further integration options

**What it does NOT solve:**
- Integrated mode (OC as the simulation master) — WebSUMO still cannot attach
  to a SUMO/libsumo instance owned by another process; that is the subject of
  Options 2–4 below.

---

### Option 2 — WebSUMO as permanent simengine; OC control engine as NATS service

WebSUMO's backend remains the TraCI master in all modes. OC's control engine
is decoupled from TraCI entirely and runs as a pure NATS service: it receives
detector readings, computes signal states, and publishes them back. WebSUMO
applies the signal commands to SUMO.

```
Browser  ←WebSocket→  WebSUMO backend  ←TraCI→  SUMO
                            ↕ NATS
                      OC control engine
```

**Pros:**
- All simulation management commands (scale, demand, vehicle injection) live in
  WebSUMO — no additions needed to OC
- OC stays focused on signal logic
- Clear separation of concerns

**Cons:**
- OC's `simengine_integrated.py` entry point becomes redundant; OC's standalone
  mode (running without WebSUMO) would need a thin simengine shim
- Requires agreement with OC team on decoupling simengine from control engine

**Prerequisite:** OC roadmap alignment. Not a decision to make unilaterally.

---

### Option 3 — OC simengine as master; WebSUMO as pure NATS subscriber

OC's simengine owns TraCI and publishes simulation state to NATS. WebSUMO
subscribes and renders — it has no TraCI connection in this mode.

```
OC simengine  ←TraCI→  SUMO
     ↓ NATS (sim.state)
WebSUMO backend
     ↓ WebSocket
   Browser
```

All simulation management commands from the browser would be published to NATS
and handled by OC's simengine — meaning OC grows non-signal responsibilities
over time.

**Pros:**
- OC remains fully in control; WebSUMO is a passive viewer
- Matches the "integrated mode" use case directly

**Cons:**
- Every new simulation command (traffic scale, demand injection, etc.) requires
  an addition to OC's simengine — scope creep in the wrong direction
- WebSUMO loses standalone capability unless it retains its own TraCI path

**Prerequisite:** OC roadmap alignment. Risk of OC becoming a general simulation
proxy rather than a signal controller.

---

### Option 4 — Neutral simengine (new component)

A dedicated simengine process owns TraCI. Both OC control engine and WebSUMO
connect to it via NATS. Neither owns the simulation; the simengine is the
single source of truth.

```
Neutral simengine  ←TraCI→  SUMO
        ↕ NATS
OC control engine      WebSUMO backend  ←WebSocket→  Browser
```

**Pros:**
- Cleanest separation: signal control, visualisation, and simulation management
  are three independent concerns
- Standard interfaces between all components

**Cons:**
- New codebase to maintain
- Most complex to set up
- Premature unless OC and WebSUMO are both stable and the integration use case
  is well-defined

**Prerequisite:** both tools mature, interfaces agreed, joint architecture
decision.

---

## Lightweight interim option

NATS is already in place, so this is now moot as a *transport* shortcut. If a
purely in-process prototype is ever wanted, OC's `PhaseRingController` could be
imported directly inside `sumo_adapter.py` and called each step with detector
readings, its signal output applied via libsumo — no NATS hop. This couples OC
into the adapter's process and does not scale to distributed or
multi-intersection use; treat it as a prototype, not a production architecture.

This is a quick path to OC-controlled signals in the browser, but it couples
OC into WebSUMO's process and does not scale to distributed or multi-intersection
use cases. Treat it as a prototype, not a production architecture.

---

## Recommended sequence

| Step | Action | Status |
|------|--------|--------|
| 1 | Add NATS publishing to WebSUMO (Option 1) | ✅ done |
| 2 | Define and freeze the `sim.{scenario}.*` schema and command protocol | ✅ done — frozen (versioned `v: 1`) in `SIM_PROTOCOL.md` |
| 3 | Choose simulation-master ownership (Option 2 vs 3 vs 4) | ✅ **Option 3 chosen** — OC's simengine is master and adopts `sim.{scenario}.*` |
| 4 | Implement: OC vendors `backend/simbridge.py`, ~15 lines in its step loop | OC-side, hand-off ready — `INTEGRATING_WITH_OC.md` |

> **Direction.** WebSUMO exposes the `sim.{scenario}.*` interface (frozen in
> `SIM_PROTOCOL.md`); the integration is implemented on the OC side against it —
> OC's simengine publishes/consumes those subjects via `simbridge.py`, WebSUMO
> stays a pure subscriber. The other approaches below (adapter republishing
> `detector.control.*` / `group.control.*`; a `nats_traci` transport) were
> considered but are not planned at this stage.

The guiding principle held: **interfaces first, integration second.** The stable
`sim.{scenario}.*` schema (frozen in `SIM_PROTOCOL.md`) is the contract OC codes
against.
