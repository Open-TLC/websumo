# SUMO via NATS — Feasibility Research
## Replacing TraCI with a libsumo+NATS gateway

*Research completed: 2026-07-02. Based on local code analysis of OC and
WebSUMO, libsumo documentation, NATS benchmarks, and Eclipse MOSAIC
architecture study.*

---

## The proposed architecture

Instead of WebSUMO or OC owning a TraCI socket connection to SUMO, a single
**SUMO NATS Gateway** process embeds SUMO via libsumo and exposes all
simulation state and commands as NATS subjects. Both WebSUMO and OC's control
engine connect to NATS only — neither has a direct SUMO connection.

```
┌──────────────────────────────────────────────┐
│  SUMO NATS Gateway (new, single process)     │
│  ┌────────────┐   ┌──────────────────────┐  │
│  │  libsumo   │←──│  Command subscriber  │  │
│  │  (embedded)│──→│  State publisher     │  │
│  └────────────┘   └──────────────────────┘  │
└──────────────────────────┬───────────────────┘
                           │ NATS :4222
          ┌────────────────┼────────────────────┐
          │                │                    │
   OC Control Engine   WebSUMO backend     (future)
   (already NATS-native) (new subscriber)
          │                │
   detector.control.*  sim.state.269
   group.control.*     sim.cmd.269
```

This is not a speculative architecture. OC's control engine is **already
NATS-native** — it has never called TraCI directly. It subscribes to detector
data and publishes signal commands over NATS. The only process currently using
TraCI is `simengine_integrated.py`, which this gateway would replace. WebSUMO
would drop its TraCI session and become a NATS subscriber.

---

## 1. Do the tools exist?

### 1.1 libsumo

**libsumo** is SUMO's C++ simulation engine exposed as Python bindings,
eliminating the TCP socket entirely. Same API as TraCI:

```python
import libsumo as traci          # drop-in via LIBSUMO_AS_TRACI=1
# or
import libsumo
libsumo.start(["sumo", "-c", "scenario.sumocfg"])
libsumo.simulationStep()
positions = libsumo.vehicle.getIDList()
```

**Performance:** ~8× faster than socket TraCI in benchmarks (sumo-rl library,
widely reproduced in RL research). The speed gain comes from eliminating
serialisation and socket round-trips on every call.

**Availability:** pip-installable (`pip install libsumo`), SUMO 1.27.0 is
installed here. **libsumo Python bindings are not currently installed** (only
the C++ `libsumocpp.so` is present). They would need to be installed separately.

**Critical constraint:** libsumo is **not thread-safe** and supports **only
one simulation instance per process**. The SWIG-generated bindings use static
global state; concurrent thread access causes crashes (SUMO issue #12893).
Consequence: the gateway must process all libsumo calls from a single thread,
and multiple simultaneous SUMO scenarios require separate OS processes.

**API gaps vs TraCI:**
- Subscriptions with extra parameters — were broken for years, fixed in recent
  releases. Verify against SUMO 1.27.0.
- `traci.addStepListener` — Python-only feature, not available in libsumo
- `traci.init()` / `traci.connect()` — not available, use `start()` only
- GUI (sumo-gui) — experimental on Linux, unsupported on Windows
- `vehicle.getLeader` in subscription context — known gap in Eclipse MOSAIC's
  libsumo coupling

[sumo.dlr.de/docs/Libsumo.html]

### 1.2 NATS and nats-py

OC **already depends on nats-py 2.9.0** in both `simengine/docker/requirements.txt`
and `control_engine/docker/requirements.txt`. The NATS broker is already defined
in `docker-compose.yaml` (`image: nats:latest`, port 4222).

OC uses **pure pub/sub** — no request/reply, no JetStream. This is confirmed
by reading `simengine.py` and `clockwork.py`: only `nats.publish()` and
`nats.subscribe()` are called. The architecture is intentionally loosely
coupled and asynchronous.

### 1.3 The critical discovery: OC is already decoupled

Reading `simengine.py` (the distributed-mode simengine, as opposed to
`simengine_integrated.py`):

```python
# simengine.py simplified loop
while traci.simulation.getMinExpectedNumber() > 0:
    traci.simulationStep()          # step SUMO
    system_timer.tick()
    await asyncio.sleep(next_step)
    await nats.publish(det_id, det_status)      # publish detectors
    await nats.publish(light_id, light_status)  # publish TLS state
```

And in `clockwork.py` (control engine):
```python
while True:
    traffic_controller.tick()       # compute signal state
    system_timer.tick()
    await asyncio.sleep(next_step)
    await nats.publish(channel, group_state)    # publish signal commands
```

**These two loops run independently.** The simengine does NOT wait for the
control engine to respond before calling `simulationStep()`. There is no
request/reply, no barrier, no acknowledgement. Signal commands from the control
engine arrive at the simengine asynchronously and are applied at the next
opportunity.

This is already how the system works. One-step latency (~100ms) in signal
commands is accepted as correct behaviour for traffic control.

---

## 2. Hiccups: simultaneous messages, ordering, waiting

### 2.1 The step boundary problem

The single hardest design question: **when does `libsumo.simulationStep()`
get called, and by whom?**

With TraCI, the master calls `simulationStep()` and everything else waits.
With NATS, there is no inherent master. Two approaches:

**Option A — Gateway self-clocked (recommended)**

The gateway runs its own step loop at a fixed wall-clock rate (e.g., every
50ms for 2× simulation speed). Before each step it drains a pending-commands
buffer; after each step it publishes state.

```python
async def gateway_loop():
    pending = []
    async def on_command(msg):
        pending.append(parse(msg))

    await nc.subscribe("sim.cmd.>", cb=on_command)

    while libsumo.simulation.getMinExpectedNumber() > 0:
        # Apply commands accumulated since last step
        for cmd in pending:
            apply_command(cmd)   # setScale, setTLS, etc.
        pending.clear()

        libsumo.simulationStep()

        # Publish state to all subscribers
        state = collect_state()
        await nc.publish("sim.state.269", encode(state))
        await asyncio.sleep(step_interval)
```

This is clean, predictable, and matches how OC's distributed simengine
already works. The gateway owns the step; everyone else is a subscriber.

**Option B — Step triggered by NATS command**

A designated controller publishes `sim.advance` and the gateway steps only
on receiving it. Enables external control of simulation pace but requires
coordination — if the controller crashes, the simulation freezes.

**Recommendation:** Option A for WebSUMO's use case. The simulation runs at
a configurable speed; WebSUMO controls speed via a `sim.cmd.scale` message
(which already exists as a concept).

### 2.2 Simultaneous messages from multiple publishers

If both WebSUMO and OC publish commands simultaneously to the gateway, NATS
delivers them serially to the single subscriber (one TCP connection per
subscriber). Delivery order at the gateway is determined by NATS server
arrival order, which is non-deterministic across publishers.

**In practice this is not a problem** because:
- WebSUMO commands (scale, pause, reset) and OC commands (signal states) are
  different NATS subjects with different handlers
- They do not conflict: WebSUMO's `sim.cmd.269.scale` and OC's
  `group.control.0.0` both get applied to the pending buffer before the next
  step regardless of arrival order
- Signal commands are idempotent (applying the latest state is always correct)

For the rare case where ordering matters (e.g., two WebSUMO clients submitting
conflicting scale commands), the pending buffer naturally resolves it: the
last value wins, which is correct semantics for a "set parameter" operation.

### 2.3 Do we need to wait for answers?

OC's current architecture says **no** — and that's intentional. The control
engine publishes signal commands and does not wait for confirmation that SUMO
applied them. The simengine applies whatever it received before the next step.

WebSUMO currently uses a WebSocket for vehicle positions, which is also fire-
and-forget. The frontend does not request a step; it receives updates
as they arrive.

The only place where request-reply semantics are genuinely needed:
- `POST /api/session/start` — needs to know if SUMO started successfully
- `GET /api/network/{scenario}` — needs to load the GeoJSON before rendering

Both of these happen before the simulation loop starts and can use NATS
request-reply (or a conventional HTTP endpoint, which is simpler and already
exists). The simulation loop itself is entirely push-based.

**NATS request-reply latency** when it is needed: median ~50–100µs on
localhost, p99 ~314µs. Completely within budget for any human-interactive
operation. [nats bench, nats-io/latency-tests]

### 2.4 What if no one is subscribed?

Core NATS is at-most-once delivery. If WebSUMO's frontend is disconnected
when the gateway publishes `sim.state.269`, that message is lost. This is
identical to the current WebSocket behaviour and is acceptable: the next
step's state arrives 50–100ms later.

If you need guaranteed delivery (e.g., recording every step for replay), add
JetStream persistence on the state subject. This is a one-line configuration
change and does not affect the core loop.

---

## 3. Benefits and tradeoffs vs plain socket or WebSocket

### Benefits of NATS gateway over current TraCI approach

| Dimension | Current (TraCI socket) | NATS gateway (libsumo) |
|-----------|----------------------|------------------------|
| Who owns SUMO | Single master (WebSUMO or OC) | Gateway process, no conflict |
| Adding a second consumer | Requires `--num-clients` + barrier sync | Just subscribe to the topic |
| OC integration | OC must be embedded or replace WebSUMO | OC already speaks NATS, zero changes |
| Simulation speed | TraCI socket overhead every step | libsumo: ~8× faster, no socket |
| WebSUMO architecture | Owns TraCI, complex session management | Pure subscriber, stateless |
| Multi-intersection | N separate WebSUMO sessions | N subjects on one gateway |
| Debugging | Binary TraCI protocol | Human-readable JSON on NATS subjects |
| Replay / recording | Not built-in | JetStream one-liner |

### Tradeoffs and risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| libsumo not thread-safe | Medium | Single-threaded gateway loop; all libsumo calls from one thread. asyncio + `run_in_executor` for the blocking step call |
| NATS broker is a new dependency | Low | Single binary, zero config, Docker one-liner. Already in OC's docker-compose |
| libsumo not installed here | Low | `pip install libsumo` — same version as SUMO 1.27.0 available |
| API gaps (subscriptions, GUI) | Low | We don't use sumo-gui; check subscription behaviour before committing |
| Message ordering non-deterministic | Low | Gateway controls step; commands from all sources go into same pending buffer |
| One-step signal command lag | Acceptable | Already the case in OC distributed mode; 100ms lag is fine for traffic control |
| Gateway crash stops everything | Medium | Healthcheck + auto-restart; same risk as current single-process TraCI master |

### Comparison to plain WebSocket

A plain WebSocket between backend and frontend (what WebSUMO currently uses)
is fine for browser-to-server communication. It is **not** a substitute for
NATS as an inter-service bus because:
- WebSocket is point-to-point (one server, one browser). NATS is many-to-many.
- WebSocket has no subject routing. NATS has hierarchical subjects with
  wildcard subscriptions.
- Adding OC as a WebSocket client of WebSUMO creates coupling;
  subscribing to a NATS topic creates none.

The frontend continues to use WebSocket. NATS is the backend-to-backend layer.
WebSUMO's FastAPI backend subscribes to NATS and forwards state to the browser
via its existing WebSocket. No change to the frontend.

---

## 4. Practical steps and hardest problems to test first

### Step 1 — Install libsumo and verify it works

```bash
pip install libsumo==1.27.0
python -c "import libsumo; libsumo.start(['sumo', '-c', '/tmp/shared/sumotest/fi.helsinki.269.sumocfg']); print(libsumo.simulation.getTime()); libsumo.close()"
```

This is the first gate. If libsumo imports, starts, and steps the Helsinki 269
scenario correctly, the approach is viable. **This is the first thing to test.**

Expected issue: libsumo and the SUMO TraCI Python package may share global state
(both come from the same SUMO install). Test in a clean virtual environment.

### Step 2 — Verify libsumo thread/async safety in practice

libsumo must be called from one thread. With asyncio, use `run_in_executor`
for the blocking `simulationStep()` call:

```python
loop = asyncio.get_running_loop()
await loop.run_in_executor(executor, libsumo.simulationStep)
```

But libsumo's callbacks and state must not be accessed from other threads
concurrently. Test that pending-command application and state reading work
correctly in the single-executor pattern.

### Step 3 — Build the minimal gateway (50–80 lines)

```python
# sumo_gateway.py sketch
import asyncio, libsumo, nats, json

async def run(sumocfg, scenario):
    nc = await nats.connect("nats://localhost:4222")
    pending = []

    async def on_cmd(msg):
        pending.append(json.loads(msg.data))
    await nc.subscribe(f"sim.cmd.{scenario}", cb=on_cmd)

    loop = asyncio.get_running_loop()
    from concurrent.futures import ThreadPoolExecutor
    exe = ThreadPoolExecutor(max_workers=1)

    libsumo.start(["sumo", "-c", sumocfg])
    step_s = 0.05  # 20 steps/sec = 1x speed

    while libsumo.simulation.getMinExpectedNumber() > 0:
        for cmd in pending:
            apply(cmd)          # setScale, setTLS, etc.
        pending.clear()

        await loop.run_in_executor(exe, libsumo.simulationStep)

        state = {
            "t": libsumo.simulation.getTime(),
            "vehicles": [...],
            "tls": {...},
            "detectors": {...},
        }
        await nc.publish(f"sim.state.{scenario}", json.dumps(state).encode())
        await asyncio.sleep(step_s)

    libsumo.close()
    await nc.drain()
```

Test this against the 269 scenario first. Verify vehicle positions arrive
correctly by subscribing from a separate Python script.

### Step 4 — Verify OC topics align

OC's control engine subscribes to `detector.control.*` (format confirmed from
`clockwork.py` and `outputs.py`). The gateway needs to publish on these exact
topics, not just `sim.state.269`. Check that the detector IDs match between:
- OC's `oc_controller.json` (the `"wired"` detector list)
- The SUMO detector IDs in `fi.helsinki.269.net.xml`

This is the **OC config coordination problem** identified in the prior
architecture research. It is the hardest functional problem, not an
infrastructure problem.

### Step 5 — Replace WebSUMO backend's TraCI session with NATS subscription

In `session.py`, replace `_connect() / do_step()` with a NATS subscriber:

```python
async def subscribe_loop(session, nc, scenario):
    async def on_state(msg):
        state = json.loads(msg.data)
        if session.websocket:
            await session.websocket.send_json(state)
    await nc.subscribe(f"sim.state.{scenario}", cb=on_state)
```

The WebSocket protocol to the browser is unchanged. The frontend never knows
whether the backend is using TraCI or NATS.

### Hardest problems in order

| Problem | Why hard | Test |
|---------|----------|------|
| libsumo import with existing SUMO install | Shared global state between libsumo and traci packages | Isolated venv, run both |
| Detector ID alignment between OC config and SUMO net | Silent mismatch means OC sees no traffic | Log unmatched IDs at startup |
| Signal command timing (which step gets which command) | Off-by-one causes wrong phase at junction | Compare against simengine_integrated reference run |
| asyncio + libsumo single-thread constraint | `run_in_executor` must be consistent | Stress test with many steps |
| NATS subject naming convention alignment | OC uses `detector.control.*`, gateway must match exactly | Read clockwork.py topic names before writing gateway |

---

## 5. What this means for OC integration

If the gateway is built, OC integration becomes **trivial for the control engine**:
- OC control engine already subscribes to `detector.control.*` — gateway publishes there
- OC control engine already publishes to `group.control.*` — gateway subscribes there
- **Zero changes to OC's control engine code**

The only OC component that changes is `simengine_integrated.py` — it becomes
unnecessary (the gateway replaces it). In OC's distributed mode, the simengine
already delegates to NATS anyway.

For WebSUMO, the session management simplifies: no TraCI connection to manage,
no `--remote-port`, no stale connection cleanup, no `ThreadPoolExecutor`. The
backend becomes a NATS subscriber that forwards state to the browser.

The `INTEGRATION_ROADMAP.md` Option 2 ("WebSUMO as permanent simengine") and
Option 3 ("OC simengine as master") both converge on this gateway pattern:
**a neutral process owns libsumo and speaks NATS to everyone**.

---

## Sources

| Source | Finding |
|--------|---------|
| sumo.dlr.de/docs/Libsumo.html | libsumo API, thread-safety constraint, LIBSUMO_AS_TRACI |
| github.com/LucasAlegre/sumo-rl | ~8× speed gain with libsumo vs TraCI |
| github.com/eclipse-sumo/sumo/issues/12893 | libsumo crash with parallel instances |
| pypi.org/project/libsumo | libsumo 1.26.0 on PyPI, actively maintained |
| docs.nats.io/nats-concepts/core-nats/reqreply | NATS request-reply pattern |
| docs.nats.io/using-nats/nats-tools/nats_cli/natsbench | NATS bench latency numbers |
| github.com/nats-io/latency-tests | NATS p50=94µs, p99=314µs on localhost |
| docs.nats.io/nats-concepts/jetstream | JetStream for guaranteed delivery |
| eclipse.dev/mosaic/docs/simulators/traffic_simulator_sumo | MOSAIC step synchronization |
| eclipse.dev/mosaic/docs/extending_mosaic/simulator_coupling | MOSAIC conservative time management |
| OC simengine/src/simengine.py lines 450–495 | Confirmed async pub/sub, no step sync |
| OC control_engine/src/clockwork.py lines 54–200 | NATS topics, subscribe patterns |
| OC simengine/docker/requirements.txt | nats-py 2.9.0 already a dependency |
| OC docker-compose.yaml | NATS broker already in OC stack |
