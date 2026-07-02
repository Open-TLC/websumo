# Replacing TraCI with NATS — Feasibility Research
## `nats_traci`: SUMO accessible as a NATS service

*Research completed: 2026-07-02. Verified 2026-07-02: libsumo 1.27.0 installed
and tested against fi.helsinki.269. Based on: TraCI C++ source analysis,
TraCI Python source code reading (connection.py, domain.py, main.py),
NATS protocol benchmarks, and nRPC/nats-grpc design patterns.*

---

## The idea in one paragraph

Instead of SUMO exposing a proprietary binary TCP server (TraCI) that
exactly one master process connects to, run SUMO embedded via libsumo inside
a thin adapter process that speaks NATS. Any number of clients — OC, WebSUMO,
a recorder, a dashboard — subscribe and publish on NATS subjects. OC replaces
`import traci` with `import nats_traci as traci`: same call syntax, NATS
transport underneath. WebSUMO subscribes to broadcast state subjects instead
of running its own TraCI session. No `--num-clients`, no TraCI ownership
conflicts, no need to modify SUMO's C++ source.

---

## 1. How the existing TraCI protocol works at the wire level

Understanding this is required before anything else.

### Wire format

TraCI uses a two-level binary framing scheme over TCP:

```
TCP message (one send/recv cycle):
  [4 bytes]  Total message length, big-endian uint32 (includes itself)
  [N bytes]  One or more commands concatenated, each with:
               [1 byte]   Command length (or 0x00 sentinel for extended)
               [1 byte]   Command identifier (cmdID)
               [N bytes]  Payload (typed: type-tag byte + value bytes)

Types:  ubyte=0x07  int32=0x09  double=0x0B  string=0x0C  compound=0x0F
        2D position=0x01  colour=0x11  stringList=0x0E  ...
All multi-byte values are big-endian.
```

### simulationStep at the wire level

Calling `traci.simulationStep()` is a **single round-trip**:

1. Client sends: outer length + `CMD_SIMSTEP (0x02)` + raw double (target time)
2. SUMO advances the simulation
3. SUMO sends back: one TCP reply containing `int32(numSubscriptions)` followed
   by N subscription result bundles (one per active subscription), all in one
   framed message
4. Client reads all N bundles and populates `_subscriptionMapping`

**This is the key: one step = one request-reply = one TCP round-trip regardless
of how many subscriptions are active.** This maps directly to one NATS
request-reply.

### The multi-client barrier (`--num-clients`)

SUMO's C++ `TraCIServer` accept-loops until exactly N TCP connections arrive,
then requires each client to issue `CMD_SETORDER (0x03)` with a unique integer
priority. Per step: SUMO processes all commands from client 1 in priority order
until it receives `CMD_SIMSTEP`, then client 2, …, then client N, then finally
advances the simulation. All N clients must issue their step call before SUMO
moves forward.

This is a **tight synchronous barrier** with no tolerance for a slow or crashed
client. Replacing it with NATS removes this coupling entirely.

---

## 2. SUMO's C++ source: can the transport be replaced?

### Where TraCI lives

```
src/traci-server/
  TraCIServer.cpp / .h       — accept loop, command dispatch, multi-client barrier
  TraCIServerAPI_Vehicle.cpp  — one file per domain
  TraCIServerAPI_Lane.cpp
  TraCIServerAPI_TrafficLight.cpp
  ... (one per domain)

src/foreign/tcpip/
  socket.h / socket.cpp      — the TCP implementation (third-party "foreign" code)
  storage.h / storage.cpp    — byte-buffer framing
```

`TraCIServer.cpp` includes `foreign/tcpip/socket.h` and instantiates
`tcpip::Socket` as a concrete class. **`tcpip::Socket` has no virtual methods
and no base class.** There is no interface, no dependency injection point.
Replacing the transport requires either:
- Adding a `ITransport` abstract class and refactoring `TraCIServer` to use it
  (substantial C++ change in SUMO's core)
- Or running SUMO without its TCP server entirely — which libsumo does

**SUMO's own issue tracker has zero proposals for NATS, WebSocket, gRPC, or
MQTT as TraCI transport.** The only discussion (issue #8076, opened Jan 2021,
still open/backlog) mentions protobuf as a possible future serialisation
replacement, with no timeline and no implementation work started.
[github.com/eclipse-sumo/sumo/issues/8076]

**Conclusion: do not modify SUMO's C++ source.** Use libsumo instead.

### libsumo as the alternative

`src/libsumo/` is a completely separate directory from `src/traci-server/`.
`Simulation.cpp` calls `MSNet::getInstance()->simulationStep()` directly —
no sockets, no storage, no serialisation. The C++ code is identical to
what TraCI server calls internally, minus the network layer.

```cpp
// libsumo/Simulation.cpp (approximately)
void Simulation::step(const double time) {
    MSNet::getInstance()->simulationStep();   // direct kernel call
}
```

Python bindings via SWIG:
```python
import libsumo
libsumo.start(["sumo", "-c", "scenario.sumocfg"])
libsumo.simulationStep()
positions = libsumo.vehicle.getIDList()
libsumo.close()
```

Speed improvement: **~8× faster** than socket TraCI in benchmarks (all
overhead removed). [github.com/LucasAlegre/sumo-rl]

**Verified working on this machine** (`pip install libsumo==1.27.0` — libsumo
is a separate pip package from `eclipse-sumo`; one install command suffices).
Tested against fi.helsinki.269: start, simulationStep, vehicle.getIDList,
vehicle.getPosition, vehicle.getAngle, vehicle.getLength, vehicle.getLeader,
trafficlight.getIDList, trafficlight.getRedYellowGreenState — all correct.

**`LIBSUMO_AS_TRACI=1`** is an existing mechanism: setting this env var before
`import traci` causes `traci/__init__.py` to do `from libsumo import *`,
overwriting the `traci` namespace with libsumo symbols. Existing code using
`traci.vehicle.getSpeed()` works unchanged against libsumo. This same
mechanism is the foundation for `nats_traci`.

---

## 3. How `nats_traci` would work

### The abstraction seam in TraCI's Python client

Reading `connection.py` reveals a clean single dispatch point:

- `_sendExact()` (lines 124–152) — **the only method that touches the TCP
  socket**. It prepends the 4-byte length header, calls `socket.send()`, calls
  `_recvExact()`, decodes responses for all queued commands, then clears the
  queue.
- `_sendCmd()` (lines 210–232) — called by every domain getter and setter.
  Packs the binary frame into `self._string`, appends cmdID to `self._queue`,
  then immediately calls `_sendExact()`.
- `simulationStep()` (lines 359–379) — sends `CMD_SIMSTEP`, reads back the
  subscription bundle.

**All 22 domain modules** dispatch through `self._connection._sendCmd` (or
`_subscribe`, `_getSubscriptionResults`). None touch the socket directly. The
domain-to-connection binding is done in `Domain._register(connection, mapping)`
which shallow-copies the domain singleton and sets `dom._connection = connection`.

To replace the transport, subclass `Connection` and override `_sendExact` (or
`_sendCmd`):

```python
class NatsConnection(Connection):
    """Drop-in replacement: routes TraCI calls over NATS instead of TCP."""

    def __init__(self, nc, sim_id):
        self._nc = nc            # nats.aio.client.Client
        self._sim_id = sim_id
        self._string = bytes()
        self._queue  = []
        self._subscriptionMapping = {}
        self._lock = threading.Lock()
        # register all domain singletons against this connection
        for domain in DOMAINS:
            domain._register(self, self._subscriptionMapping)

    def _sendExact(self):
        # pack the outer message exactly as the real connection does
        msg_bytes = struct.pack("!i", len(self._string) + 4) + self._string
        # publish to NATS, await reply
        reply = asyncio.get_event_loop().run_until_complete(
            self._nc.request(
                f"sumo.{self._sim_id}.cmd",
                msg_bytes,
                timeout=2.0
            )
        )
        # parse the reply using the existing Storage machinery
        result = Storage(reply.data)
        # ... decode using existing _queue-based logic (same as original)
        self._string = bytes()
        self._queue  = []
        return result
```

This is the minimum change to redirect all TraCI I/O over NATS. The existing
`Storage` decoder, `_pack()` type serialiser, and all 22 domain files work
unchanged. The nats_traci client sends the same binary frames that normal
TraCI sends — the NATS adapter on the SUMO side just forwards them to libsumo.

### The SUMO adapter process

A small Python process embeds libsumo and bridges to NATS:

```python
import libsumo, nats, asyncio
from sumo.tools.traci import storage as traci_storage

async def run(sumocfg, sim_id):
    nc = await nats.connect("nats://localhost:4222")

    async def handle_traci_cmd(msg):
        # msg.data is a raw TraCI-framed binary message
        # parse command, dispatch to libsumo, serialise result
        result_bytes = dispatch_to_libsumo(msg.data)
        await msg.respond(result_bytes)

    await nc.subscribe(f"sumo.{sim_id}.cmd", cb=handle_traci_cmd)
    libsumo.start(["sumo", "-c", sumocfg])

    # Also publish broadcast state after each step
    # (handled inside dispatch_to_libsumo when CMD_SIMSTEP is received)
```

`dispatch_to_libsumo` reads the command byte from the binary frame, looks up
the libsumo call, executes it, and packs the result using the same Storage
format. `simulationStep` additionally publishes vehicle positions and TLS states
on broadcast subjects so WebSUMO can receive them without issuing its own
step request.

### Thread safety constraint

libsumo is **not thread-safe** — SWIG static global state. The adapter must
call all libsumo functions from **one thread**. With asyncio, use
`run_in_executor` with a single-worker `ThreadPoolExecutor` for the blocking
`libsumo.simulationStep()` call, and process all NATS callbacks in the event
loop thread that also owns the executor's single thread. In practice: one
asyncio event loop + one dedicated thread for libsumo calls + a queue between
them.

---

## 4. NATS subject schema

Based on Synadia's subject hierarchy best practices and the nRPC project's
design (the closest existing analogue — gRPC-style RPC over NATS):
[github.com/nats-rpc/nrpc]

```
# Simulation control (request-reply)
sumo.{sim_id}.cmd.simstep              → simulationStep(step=0.0)
sumo.{sim_id}.cmd.close                → close()
sumo.{sim_id}.cmd.load                 → load(args)

# Domain getters (request-reply)
sumo.{sim_id}.get.{domain}.{var}              → domain getter, no object ID
sumo.{sim_id}.get.{domain}.{var}.{object_id} → domain getter for specific object

# Domain setters (request-reply)
sumo.{sim_id}.set.{domain}.{var}.{object_id} → domain setter

# Subscriptions (push, published after each step)
sumo.{sim_id}.sub.vehicles             → all vehicle positions+angles+lengths
sumo.{sim_id}.sub.tls                  → all TLS states
sumo.{sim_id}.sub.detectors            → detector occupancies

# Examples
sumo.sim1.cmd.simstep
sumo.sim1.get.vehicle.id-list
sumo.sim1.get.vehicle.speed.veh0
sumo.sim1.set.vehicle.speed.veh0
sumo.sim1.get.trafficlight.phase.tl1
sumo.sim1.sub.vehicles                 ← WebSUMO subscribes here
```

The `sim_id` prefix enables multiple independent simulations on one NATS broker.
Wildcard `sumo.sim1.>` captures all events for one simulation.

**Serialisation:** MessagePack for request payloads and replies. No schema
required, handles all TraCI types (scalars, position tuples, colour structs,
string lists) naturally. 30–45% smaller than JSON, 2–3× faster encode/decode.
For the initial adapter, the binary TraCI frame can be passed through as-is
(zero re-serialisation), then migrated to MessagePack once stable.

---

## 5. Hiccups

### 5.1 Who triggers `simulationStep()`?

This is the hardest architectural question. Three options:

**Option A — Single step master (simplest)**
One client is designated the step master and calls `nats_traci.simulationStep()`
as before. The adapter advances libsumo and publishes broadcast state. All other
clients (WebSUMO, recorders) only subscribe to broadcasts — they never issue
`cmd.simstep`. This is the drop-in-compatible design: OC's existing step-master
role is preserved, just over NATS instead of TCP.

**Option B — Adapter self-clocked (decoupled)**
The adapter runs its own timer and steps libsumo at the configured simulation
speed. Clients only publish commands (set TLS state, set vehicle speed) and
subscribe to broadcasts. No client ever calls `simulationStep()`. This is
cleaner for WebSUMO's use case (pure observer) but breaks OC's integrated-mode
control flow where it must process detectors → compute signal → apply state
before the next step.

**Option C — Ordered multi-client step (parity with `--num-clients`)**
The adapter waits for a step request from each registered client before
advancing. Implemented via a simple counter: clients publish to
`sumo.sim1.cmd.simstep` with their `client_id`, adapter counts, steps when
all have checked in. More complex, adds per-client registration.

**Recommendation:** Start with Option A. OC is the natural step master in
integrated mode. WebSUMO subscribes to broadcasts. Option B can be added as
a mode for standalone WebSUMO operation.

### 5.2 Simultaneous set commands from multiple clients

If WebSUMO sets simulation scale and OC sets TLS state in the same step, both
NATS requests arrive at the adapter concurrently. Since the adapter processes
NATS callbacks in a single asyncio event loop, they are serialised by the event
loop before being dispatched to the libsumo thread. No race condition — last
write wins within a step, which is correct semantics for a "set" operation.

### 5.3 Do clients need to wait for answers?

**Getters:** Yes — must wait for the libsumo result. NATS request-reply handles
this. Timeout: 500ms is generous for any libsumo call.

**Setters:** No — fire-and-forget is correct for `setSpeed`, `setTLS`, `setScale`.
The value is applied before the next `simulationStep`. Use `publish()` not
`request()` for setters; this reduces latency and removes timeout complexity.

**simulationStep:** Must wait for the reply which includes subscription results.
One round-trip per step. At 10 steps/sec, this is 100ms budget; one NATS
request-reply is ~100–300µs in Python asyncio on localhost. Budget is fine.
[nats-io/latency-tests: p50=94µs, p99=314µs]

**Parallel getter batching:** For high-vehicle-count scenarios where many
per-vehicle queries are needed in one step, issue all getters with
`asyncio.gather()` so they fly in parallel. The adapter processes them
sequentially (single libsumo thread) but the NATS requests overlap in transit.
At 300µs/call, 333 calls fit in 100ms. For typical intersection sizes
(10–50 vehicles, 5–10 TLS phases), NATS overhead is completely invisible.

### 5.4 At-most-once delivery (fire and forget)

Core NATS has at-most-once delivery. If the adapter crashes mid-step, a setter
message may be lost. For traffic signal control this is acceptable — the next
step's signal command will correct it. If guaranteed delivery is needed for
specific commands (e.g., "load this sumocfg"), use NATS JetStream for those
messages only, keeping the fast path on core NATS.

---

## 6. Benefits vs plain TraCI socket

| Dimension | TraCI socket | nats_traci |
|-----------|-------------|------------|
| Max clients | `--num-clients N` barrier | Unlimited subscribers, no barrier |
| Slow/crashed client | Blocks all others | Isolated, others continue |
| Adding WebSUMO to an OC run | Requires `--num-clients 2` + step barrier | Subscribe to broadcast |
| Adding a recorder | Requires TraCI client slot | Subscribe to `sub.vehicles` |
| OC code change | Zero (already uses traci) | One line: `import nats_traci as traci` |
| WebSUMO code change | Manages TraCI session | Pure NATS subscriber |
| Debugging protocol | Binary, opaque | JSON/MessagePack, inspectable |
| Replay | Not built-in | JetStream on `sub.vehicles` subject |
| Performance vs TraCI | Baseline | libsumo ~8× faster for libsumo calls; NATS adds ~100–300µs overhead per step call |
| SUMO source changes | N/A | None required |

The net performance is: libsumo's ~8× gain minus NATS RTT per step call.
At 10 steps/sec, one NATS RTT costs ~300µs out of 100ms per step — 0.3%
overhead. The 8× libsumo gain applies to the actual simulation work, which
dominates. Overall: **faster than current TraCI socket approach while adding
the multi-subscriber capability**.

---

## 7. Practical steps and hardest problems to test first

### Step 1 — Install and verify libsumo ✓ DONE

```bash
pip install libsumo==1.27.0
```

`libsumo` is a **separate pip package** from `eclipse-sumo`. One install
command. Verified on this machine against fi.helsinki.269: all key calls work
including `vehicle.getLeader()`. No source build needed, no conflicts with
the existing `eclipse-sumo` install.

### Step 2 — Verify the `_sendExact` override pattern works

Write a `RecordingConnection` that subclasses `connection.Connection`, overrides
`_sendExact` to log the binary frame instead of sending it, and replays a
known response. Verify that all 22 domain calls work correctly through the
override. This validates the abstraction seam before adding any NATS code.

### Step 3 — Build the minimal adapter (50–100 lines)

A Python process that:
1. Loads libsumo with a known sumocfg
2. Connects to NATS
3. Subscribes to `sumo.sim1.cmd`
4. On each message: parses the command byte, calls the libsumo function,
   packs the result, responds via `msg.respond()`
5. After `CMD_SIMSTEP`: additionally publishes vehicle positions to
   `sumo.sim1.sub.vehicles`

Test from a second Python process using `nats_traci.simulationStep()` and
verify vehicles appear.

### Step 4 — Verify OC's use of traci works through nats_traci

OC's `simengine_integrated.py` calls about 8–10 distinct TraCI functions per
step:
- `traci.simulation.getMinExpectedNumber()`
- `traci.simulationStep()`
- `traci.vehicle.setSpeedMode()`, `setLaneChangeMode()`
- `traci.trafficlight.setRedYellowGreenState()`
- `traci.inductionloop.getLastStepVehicleNumber()`, `getLastStepOccupancy()`
- `traci.multientryexit.getLastStepVehicleNumber()`, `getLastStepVehicleIDs()`
- `traci.vehicle.getTypeID()`, `getSpeed()`, `getNextTLS()`, `getLeader()`

Run OC's simengine against the nats_traci adapter with the Helsinki 269
scenario and verify simulation output matches the reference output from
`simengine_integrated.py` with real TraCI. Compare vehicle counts and TLS
phase sequences.

### Hardest problems in order

| Problem | Why it is hard | First test |
|---------|---------------|-----------|
| libsumo Python bindings availability | ~~May not be in the installed SUMO pip package~~ **Resolved: separate pip package, installs cleanly, verified working** | ✓ Done |
| libsumo single-thread constraint | asyncio event loop + NATS callbacks + libsumo calls must all coordinate through one thread | Stress test: send 100 concurrent NATS requests, verify no crashes and correct results |
| Binary frame pass-through vs re-serialisation | If adapter passes raw TraCI binary through NATS (zero change), the binary format version must match between nats_traci client and adapter; if re-serialising to MessagePack, all ~300 variable types must be handled | Start with binary pass-through, migrate later |
| simulationStep subscription bundle | The step reply bundles N subscriptions. The adapter must collect all active subscriptions for this sim, run libsumo, pack the bundle, reply. The subscription registry must live in the adapter, not the client | Implement a server-side subscription registry |
| OC's `getLeader()` via libsumo | ~~Known libsumo gap~~ **Resolved: `vehicle.getLeader()` works correctly in libsumo 1.27.0 against Helsinki 269** | ✓ Done |

---

## 8. What does NOT need to change

- **OC's control engine** — already NATS-native, zero changes
- **OC's `simengine_integrated.py` logic** — replaces only the transport,
  not the algorithm; `import nats_traci as traci` is one line
- **WebSUMO's frontend** — unchanged; still receives WebSocket messages from
  the backend
- **WebSUMO's `/api/network/{scenario}`** — unchanged; GeoJSON rendering still
  uses sumolib
- **The SUMO network files** — unchanged; libsumo reads the same `.net.xml`,
  `.rou.xml`, `.sumocfg`
- **The OC config files** — unchanged; `oc_controller.json` maps detector IDs
  and signal groups regardless of transport

---

## Sources

| Source | Finding |
|--------|---------|
| sumo.dlr.de/docs/TraCI/Protocol.html | Wire format: two-level framing, big-endian, type tags |
| sumo.dlr.de/docs/TraCI/Control-related_commands.html | CMD_SIMSTEP=0x02, CMD_SETORDER=0x03, CMD_CLOSE=0x7F |
| eclipse-sumo/sumo src/traci-server/ | tcpip::Socket has no virtual methods; no transport abstraction |
| eclipse-sumo/sumo src/libsumo/Simulation.cpp | libsumo calls MSNet directly, no socket, same kernel |
| eclipse-sumo/sumo tools/traci/__init__.py | LIBSUMO_AS_TRACI=1 namespace overwrite mechanism |
| eclipse-sumo/sumo tools/traci/connection.py | _sendExact is the single TCP I/O point; _sendCmd dispatch |
| eclipse-sumo/sumo tools/traci/domain.py | Domain._register(connection) — all domains share one connection object |
| github.com/eclipse-sumo/sumo/issues/8076 | Only alternative-transport discussion; mentions protobuf, no NATS |
| sumo.dlr.de/docs/Libsumo.html | libsumo thread-safety, LIBSUMO_AS_TRACI, API gaps |
| github.com/LucasAlegre/sumo-rl | ~8× speed gain with libsumo vs TraCI |
| github.com/eclipse-sumo/sumo/issues/12893 | libsumo crashes with parallel instances |
| github.com/nats-rpc/nrpc | Closest existing analogue: gRPC-style RPC over NATS |
| github.com/cloudwebrtc/nats-grpc | gRPC over NATS, streaming pattern relevant for subscriptions |
| docs.nats.io/nats-concepts/core-nats/reqreply | NATS request-reply mechanics |
| github.com/nats-io/latency-tests | p50=94µs, p99=314µs RTT on localhost |
| www.synadia.com/blog/designing-nats-subject-hierarchies | Subject naming best practices |
| pypi.org/project/libsumo | libsumo 1.26.0 on PyPI, actively maintained |
