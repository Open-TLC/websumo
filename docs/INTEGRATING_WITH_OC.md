# Integrating WebSUMO with Open Controller

**Target:** Enable WebSUMO's web UI to visualize Open Controller's simulations over NATS, without any TraCI socket ownership or `--num-clients` barriers.

**Outcome:** WebSUMO subscribers see the same live simulation as OC's control engine, in a browser-based UI instead of sumo-gui.

> **Which OC engine to integrate.** The bridge attaches to whichever OC module
> owns the SUMO step loop. `simengine.py` (already async and NATS-connected) is
> the natural first target; `simengine_integrated.py` is the standalone
> integrated-mode entry point. Filenames below are illustrative — apply the same
> two calls (publish state, drain commands) wherever OC's step loop lives.

---

## Overview

WebSUMO provides two components:

1. **SIM_PROTOCOL.md** — A specification for publishing simulation state to NATS. This is the contract: if OC's simengine publishes to these subjects with this schema, WebSUMO can visualize it.

2. **simbridge.py** — A Python module that handles all NATS I/O for you. Your simengine imports it, calls two simple methods per step, and the rest is automatic.

This guide walks through the minimal changes needed in OC's simengine (the module
that owns the SUMO step loop — see the note above).

---

## Prerequisites

- NATS broker running (WebSUMO assumes it's at `nats://localhost:4222`; configurable via `NATS_URL` env var).
- OC already uses libsumo (or TraCI); no change to the SUMO integration itself.
- Python 3.10+, `nats-py>=2.9.0` installed.

---

## Step-by-step integration

### 1. Copy simbridge.py into your repo

Add WebSUMO's `backend/simbridge.py` to your codebase. For example:

```
open_controller/
  services/
    simengine/
      src/
        simengine_integrated.py
        simbridge.py          ← copy here
        ...
```

Or vendor it in a shared location. The file has no dependencies beyond `nats-py` and Python stdlib.

### 2. Update simengine_integrated.py

#### Import the bridge

```python
# At the top of your file
from simbridge import SimBridge, serialize_vehicles, serialize_persons, serialize_tls, serialize_detectors
import sumolib
```

#### Initialize the bridge

In your setup/initialization section (after SUMO is started, before the main step loop):

```python
# Assume scenario ID is passed as a config or argument
scenario_id = "fi.helsinki.269"  # or read from config

# Load sumolib's network for coordinate conversion
net = sumolib.net.readNet(f"path/to/{scenario_id}.net.xml", withInternal=False)

# Initialize the bridge
bridge = SimBridge(scenario=scenario_id, nats_url="nats://localhost:4222")
```

#### Publish each step's state

In your main step loop, **after calling `traci.simulationStep()`**, publish the state:

```python
while True:
    # ... existing control logic ...

    # Step the simulation
    traci.simulationStep()

    # Publish this step to NATS (for WebSUMO and other subscribers)
    state = {
        "v": 1,  # protocol version
        "t": round(traci.simulation.getTime(), 1),
        "vehicles": serialize_vehicles(traci, net, scenario_id),
        "persons": serialize_persons(traci, net),
        "tls": serialize_tls(traci),
        "detectors": serialize_detectors(traci),
        "_empty": traci.simulation.getMinExpectedNumber() == 0,
    }
    bridge.publish_step(state)

    # Check for termination
    if state["_empty"]:
        bridge.publish_end()
        break
```

#### Collect and handle commands (optional)

WebSUMO can send control commands (`pause`, `resume`, `speed`, `scale`, `spawn`, etc.). To respond:

```python
# At the start of each step, before stepping:
cmds = bridge.collect_commands()

if "pause" in cmds:
    paused = True
elif "resume" in cmds:
    paused = False

if "speed" in cmds:
    speed_req = cmds["speed"].get("v", 1.0)

if "scale" in cmds:
    traffic_scale = cmds["scale"].get("v", 1.0)
    traci.simulation.setScale(traffic_scale)

# ... rest of your logic ...

if paused:
    # Don't step if paused; just keep stepping the loop
    # (or wait for resume), but publish any events you collected
    pass
else:
    traci.simulationStep()
```

#### Close the bridge on exit

At the end of your simengine (when exiting the loop):

```python
finally:
    traci.close()
    bridge.close()
```

---

## Minimal example

Here's a complete, minimal `simengine_integrated.py` demonstrating the integration:

```python
#!/usr/bin/env python3
"""Simplified Open Controller integrated mode with WebSUMO bridge."""

import sys
import json
import logging

import libsumo as traci
import sumolib

from simbridge import SimBridge, serialize_vehicles, serialize_persons, serialize_tls, serialize_detectors

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def run_integrated(config_path: str):
    """Run OC in integrated mode, publishing to NATS."""
    
    # Load configuration
    with open(config_path) as f:
        config = json.load(f)
    
    scenario_id = config.get("scenario_id", "test_scenario")
    sumocfg = config.get("sumocfg")
    
    # Start SUMO (libsumo, in-process)
    logger.info(f"Starting SUMO: {sumocfg}")
    traci.start(["sumo", "-c", sumocfg, "--step-length", "0.1", "--no-step-log"])
    
    # Load network for coordinate conversion
    net_xml = sumocfg.replace(".sumocfg", ".net.xml")
    net = sumolib.net.readNet(net_xml, withInternal=False)
    
    # Initialize WebSUMO bridge
    logger.info(f"Initializing WebSUMO bridge for scenario: {scenario_id}")
    bridge = SimBridge(scenario=scenario_id, nats_url="nats://localhost:4222")
    
    paused = False
    speed_req = 1.0
    scale_req = 1.0
    
    try:
        step_count = 0
        while True:
            # Collect commands from WebSUMO
            cmds = bridge.collect_commands()
            
            if "pause" in cmds:
                paused = True
                logger.info("Paused")
            elif "resume" in cmds:
                paused = False
                logger.info("Resumed")
            elif "stop" in cmds:
                logger.info("Stop requested")
                break
            
            if "speed" in cmds:
                speed_req = cmds["speed"].get("v", 1.0)
                logger.info(f"Speed set to {speed_req}x")
            
            if "scale" in cmds:
                scale_req = cmds["scale"].get("v", 1.0)
                traci.simulation.setScale(scale_req)
                logger.info(f"Scale set to {scale_req}")
            
            # If paused, sleep and continue without stepping
            if paused:
                import time
                time.sleep(0.05)
                continue
            
            # === Your OC control logic here ===
            # Example: read detectors, compute signal state, set TLS
            # for detector_id in traci.inductionloop.getIDList():
            #     occ = traci.inductionloop.getLastStepOccupancy(detector_id)
            #     # ... compute signal state based on occ ...
            #     traci.trafficlight.setRedYellowGreenState(tls_id, phase_state)
            # ===================================
            
            # Step the simulation
            traci.simulationStep()
            
            # Publish state to NATS (for WebSUMO visualization)
            state = {
                "v": 1,
                "t": round(traci.simulation.getTime(), 1),
                "vehicles": serialize_vehicles(traci, net, scenario_id),
                "persons": serialize_persons(traci, net),
                "tls": serialize_tls(traci),
                "detectors": serialize_detectors(traci),
                "_empty": traci.simulation.getMinExpectedNumber() == 0,
            }
            bridge.publish_step(state)
            
            # Check for end condition
            if state["_empty"]:
                logger.info("Simulation ended (no more vehicles)")
                bridge.publish_end()
                break
            
            step_count += 1
            if step_count % 100 == 0:
                logger.info(f"Step {step_count}, sim time {state['t']}")
    
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
    
    except Exception as e:
        logger.exception(f"Error in simulation loop: {e}")
    
    finally:
        traci.close()
        bridge.close()
        logger.info("Simulation closed")

if __name__ == "__main__":
    config_path = sys.argv[1] if len(sys.argv) > 1 else "config.json"
    run_integrated(config_path)
```

---

## Testing

### 1. Start NATS

```bash
nats-server  # assumes nats-server installed or docker
```

Or use Docker:

```bash
docker run -p 4222:4222 -p 8222:8222 nats:latest
```

### 2. Start OC's simengine (with bridge integrated)

```bash
cd open_controller
python services/simengine/src/simengine_integrated.py \
  --conf-file models/JS270_DEMO/contr/JS270_DEMO.json
```

### 3. Start WebSUMO backend

```bash
cd websumo
python backend/main.py
```

Or in Docker (if you've added WebSUMO to OC's docker-compose.yaml):

```bash
docker-compose up
```

### 4. Open browser

Navigate to `http://localhost:8775` (WebSUMO's default port).

You should see:
- The road network for the scenario
- Live vehicles, pedestrians, TLS signals
- Detectors lighting up as vehicles pass
- Speed/scale/pause controls
- The same simulation running in OC's control engine

---

## Command schema

WebSUMO publishes commands on `sim.{scenario}.cmd.*`. The bridge collects them; handle them as shown above. For the full list, see **SIM_PROTOCOL.md**, section "Commands".

Key commands:
- `pause` / `resume` — halt/restart simulation.
- `speed {v}` — real-time speed multiplier (1.0 = normal, 2.0 = 2× speed).
- `scale {v}` — traffic volume scale (1.0 = full, 0.5 = half).
- `select {kind, id}` — request inspection of a vehicle or TLS (you can skip this for MVP).
- `spawn {edge, vtype, lane?}` — inject a vehicle at an entry (optional; you can skip for MVP).

---

## Troubleshooting

### NATS connection fails

- Ensure NATS broker is running (`nats-server` or Docker).
- Check `NATS_URL` env var (defaults to `nats://localhost:4222`).
- Look for logs from `SimBridge` (uses Python logging).

### No vehicles visible in WebSUMO

- Check that OC's simengine is stepping (look for log output).
- Verify `bridge.publish_step()` is being called after each `simulationStep()`.
- Check NATS connectivity: `nats sub sim.{scenario}.state` from another terminal.

### WebSUMO shows old data / out of sync

- Ensure only one simengine is running per scenario (multiple publishers conflict).
- Check that WebSUMO's backend is relaying NATS messages (see `backend/main.py`).

---

## Next steps

- **Control logic:** Integrate OC's signal controller into the step loop. Read detectors, compute phase, set TLS — same as before, just now stepping libsumo instead of TraCI socket.
- **Multi-scenario:** If running multiple scenarios simultaneously, each gets its own `sim.{scenario}.*` namespace; no conflict.
- **Hardware-in-the-loop / distributed:** Once integrated mode works, the same bridge works for OC's other modes (distributed, HWIL) — only the simengine ownership changes, not the NATS contract.

---

## References

- **SIM_PROTOCOL.md** — Full protocol specification.
- **simbridge.py** — Source code and inline documentation.
- **docs/NATS_TRACI_REPLACEMENT_RESEARCH.md** — Background on why NATS replaces TraCI.
