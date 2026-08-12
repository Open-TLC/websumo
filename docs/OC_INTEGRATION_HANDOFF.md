# OpenController Integration — Handoff Package

**Date:** 2026-08-11  
**Status:** Ready for OC team review and integration.

This package contains everything needed for Open Controller to integrate WebSUMO
visualization into its simengine — whichever module owns the SUMO step loop
(`simengine.py`, already async and NATS-connected, is the natural first target;
`simengine_integrated.py` is the standalone entry point).

---

## Contents

### 1. **SIM_PROTOCOL.md** — Simulation State Protocol Specification

A complete, versioned protocol for publishing simulation state to NATS. Defines:
- Subject hierarchy: `sim.{scenario}.state`, `.log`, `.end`, `cmd.*`
- Message schemas: vehicles, persons, TLS, detectors, events, commands
- Semantics: timing, atomicity, error handling
- Example code: a minimal simengine loop

**Read this first.** This is the contract: if OC's simengine publishes these subjects with this schema, WebSUMO will visualize it.

### 2. **simbridge.py** — Synchronous NATS Bridge for Simengines

A Python module that handles all NATS I/O for a simengine. It:
- Runs NATS in a background thread (asyncio event loop)
- Offers simple synchronous methods (`publish_step()`, `collect_commands()`) for the main (simengine) thread
- Is thread-safe and handles all timing/buffering

**Drop this file into your codebase.** It's dependency-light: only `nats-py` and Python stdlib.

**Key methods:**
- `bridge = SimBridge(scenario="fi.helsinki.269", files={"net": ..., "detectors": ..., "routes": ...})`
  — initialize; `files` are served on `sim.{scenario}.net/detectors/routes` so
  WebSUMO renders disk-less (omit to keep serving from the WebSUMO host's disk)
- `bridge.publish_step(state_dict)` — publish each step (call after `traci.simulationStep()`)
- `cmds = bridge.collect_commands()` — drain pending commands (pause, speed, scale, etc.)
- `bridge.publish_end()` — signal sim ended
- `bridge.close()` — clean shutdown

**Helper functions:**
- `serialize_vehicles(traci, net, scenario)` — convert vehicles to WebSUMO format
- `serialize_persons(traci, net)` — convert pedestrians/cyclists
- `serialize_tls(traci)` — convert TLS states
- `serialize_detectors(traci)` — convert detector occupancies

### 3. **INTEGRATING_WITH_OC.md** — Step-by-Step Integration Guide

A practical walkthrough for integrating the bridge into simengine_integrated.py:
- What to import
- How to initialize the bridge
- Where to call `publish_step()` and `collect_commands()` in your loop
- How to handle commands (pause, speed, scale, etc.)
- Complete minimal example
- Testing checklist
- Troubleshooting

**Follow this guide to integrate the bridge.**

---

## Quick summary: What needs to change in OC

In OC's `services/simengine/src/simengine_integrated.py`:

1. **Import the bridge:**
   ```python
   from simbridge import SimBridge, serialize_vehicles, serialize_persons, serialize_tls, serialize_detectors
   import sumolib
   ```

2. **Initialize before the main loop** (serve the static files so WebSUMO is disk-less):
   ```python
   net = sumolib.net.readNet(net_xml_path, withInternal=False)
   bridge = SimBridge(scenario=scenario_id, nats_url="nats://localhost:4222", files={
       "net":       net_xml_path,                                 # required
       "detectors": net_xml_path.replace(".net.xml", ".detectors.xml"),  # optional
       "routes":    net_xml_path.replace(".net.xml", ".rou.xml"),         # optional
   })
   ```

3. **Collect commands at the start of each step:**
   ```python
   cmds = bridge.collect_commands()
   if "pause" in cmds:
       paused = True
   # ... etc for speed, scale, stop
   ```

4. **Publish state after `traci.simulationStep()`:**
   ```python
   traci.simulationStep()
   state = {
       "v": 1,
       "t": traci.simulation.getTime(),
       "vehicles": serialize_vehicles(traci, net, scenario_id),
       "persons": serialize_persons(traci, net),
       "tls": serialize_tls(traci),
       "detectors": serialize_detectors(traci),
       "_empty": traci.simulation.getMinExpectedNumber() == 0,
   }
   bridge.publish_step(state)
   ```

5. **Clean shutdown:**
   ```python
   bridge.close()
   ```

**That's it. No change to control logic, no new dependencies beyond `nats-py`, no SUMO C++ modifications.**

---

## Deployment

Once integrated:

```bash
# Terminal 1: NATS broker
nats-server

# Terminal 2: OC simengine (with bridge)
python services/simengine/src/simengine_integrated.py --conf config.json

# Terminal 3: WebSUMO backend — disk-less; discovers + fetches everything
#             over NATS. No scenario files needed on this host.
SCENARIOS_DIR=/tmp/empty python websumo/backend/main.py

# Browser: http://localhost:8775  → select the scenario, Load, Start.
# (or add WebSUMO as a service in docker-compose.yaml)
```

**No shared files.** Because the bridge serves `sim.{scenario}.net/detectors/routes`
and publishes state, the WebSUMO backend needs **nothing on its own disk**: it
discovers the scenario from its live state, fetches the network + overlays over
NATS on Load, and attaches to OC's sim on Start (it never spawns or kills a
simengine of its own). No shared `SCENARIOS_DIR`, no volume mounts.

Or in docker-compose (add to your compose file):

```yaml
  websumo:
    build:
      context: ../websumo
      dockerfile: Dockerfile
    ports:
      - "8775:8775"
    environment:
      NATS_URL: nats://nats:4222
    depends_on:
      - nats
```

---

## Design principles

- **Backward compatible:** OC's logic doesn't change. The bridge is purely a publish/subscribe adapter around the existing loop.
- **Minimal coupling:** The bridge is a single file, no shared state with OC, can be vendored or copied.
- **Protocol-first:** The contract is the NATS subject schema, not the code. OC can reimplement the bridge if needed.
- **Thread-safe:** OC's main loop (sync) talks to NATS (async) safely via a background thread.
- **Fail-safe:** If NATS is down, OC continues stepping (commands are lost, but simulation is not interrupted).

---

## Next steps for OC

1. Review **SIM_PROTOCOL.md** for the contract.
2. Copy **simbridge.py** into your codebase.
3. Follow **INTEGRATING_WITH_OC.md** to modify simengine_integrated.py.
4. Test with WebSUMO backend running locally (or in docker-compose).
5. Verify vehicle/TLS/detector visualization in the browser matches your control engine's output.

---

## Support & questions

All three documents are self-contained and have inline examples. For protocol clarifications, see **SIM_PROTOCOL.md**. For integration issues, see **INTEGRATING_WITH_OC.md** troubleshooting section.

The bridge module includes docstrings and type hints. The helper functions are self-explanatory.

---

## References

- **Root cause:** WebSUMO and OC both need to visualize/control SUMO. TraCI socket is single-master, so they conflict. NATS is many-to-many pub/sub, so they coexist.
- **libsumo:** No source changes needed; OC already uses it (or TraCI, which works the same).
- **NATS:** Standard message broker, trivial to install/docker, enables multi-client architecture.

---

## Files summary

| File | Size | Purpose |
|------|------|---------|
| `docs/SIM_PROTOCOL.md` | ~12 KB | Protocol specification (read first) |
| `backend/simbridge.py` | ~12 KB | NATS bridge (copy to OC) |
| `docs/INTEGRATING_WITH_OC.md` | ~11 KB | Integration guide (follow this) |
| (this file) | — | Handoff checklist |

Total: ~35 KB of documentation and code, ready to integrate.

**Ready for handoff to OC team.**
