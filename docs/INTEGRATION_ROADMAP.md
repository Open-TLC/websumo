# WebSUMO + Open Controller — Integration Roadmap

*Status: planning / pre-integration. Last updated: 2026-07-02.*

---

## Current state

WebSUMO is a standalone SUMO viewer. It owns the TraCI connection, drives
`simulationStep()`, and streams vehicle positions and TLS states to the browser
over WebSocket. The Open Controller (OC) is a separate project with its own
TraCI connection and simulation loop. The two cannot currently run against the
same SUMO process without conflict.

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

### Option 1 — NATS publishing layer in WebSUMO *(next clear step)*

Add opt-in NATS publishing to WebSUMO's existing step loop. If a NATS broker
is reachable (`NATS_URL` env var), WebSUMO publishes simulation state each
step. If not, behaviour is identical to today.

**What changes:**
- `session.py`: publish `{t, vehicles, tls, detectors}` to `sim.state.<scenario>`
- `session.py`: subscribe to `sim.cmd.<scenario>` for signal overrides from OC
- `requirements.txt`: add `nats-py`
- No changes to frontend, WebSocket protocol, or TraCI logic

**What this enables:**
- OC's control engine can subscribe to detector data and publish signal
  commands without touching WebSUMO's internals
- Foundation for all further integration options
- Low risk: NATS is fully optional, nothing breaks without it

**What it does NOT solve:**
- Integrated mode (OC as TraCI master) — WebSUMO still cannot attach to an
  OC-owned SUMO process

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

If OC signal control is needed in WebSUMO *before* NATS is in place, OC's
`PhaseRingController` can be imported directly as a Python library inside
WebSUMO's `session.py`. WebSUMO remains TraCI master; OC's control engine is
called as a function each step with detector readings, and its signal output is
applied via TraCI. No NATS, no new processes.

This is a quick path to OC-controlled signals in the browser, but it couples
OC into WebSUMO's process and does not scale to distributed or multi-intersection
use cases. Treat it as a prototype, not a production architecture.

---

## Recommended sequence

| Step | Action | Prerequisite |
|------|--------|--------------|
| 1 | Add NATS publishing to WebSUMO (Option 1) | None — do when ready |
| 2 | Define and freeze NATS topic schema and command protocol | Option 1 done |
| 2b | *(If needed before step 2)* Import OC control engine as in-process library | Agreement that it's a prototype |
| 3 | Align with OC team on simengine ownership (Option 2 vs 3 vs 4) | OC roadmap discussion |
| 4 | Implement agreed integration pattern | Step 2 + step 3 |

The guiding principle: **interfaces first, integration second.** A stable NATS
topic schema agreed between WebSUMO and OC is worth more than any amount of
integration code built on assumptions that shift.
