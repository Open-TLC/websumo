#!/usr/bin/env bash
#
# Launch the Open Controller display demo (P1): WebSUMO renders OC's junction 270
# and overlays OC's live signal-group state (--opencontroller mode).
#
#   ./run_oc_demo.sh          start the demo
#   ./run_oc_demo.sh stop     stop backend + OC simengine (leaves NATS up)
#
# It is deliberately separate from run.sh (the file-free viewer). Topology:
#
#   NATS ── WebSUMO backend (:$PORT, OPENCONTROLLER=1)         ── browser
#     ├──── WebSUMO sumo_adapter (oc270)  → vehicles + net over NATS
#     └──── OC simengine (JS270)          → group.status.270.*  (the control state)
#
# Two independent SUMO sims: our adapter drives the *vehicles*, OC's simengine
# drives the *signal colours*. P1 shows OC's control state on the geography;
# wiring OC to actually drive WebSUMO's sim is the separate transport integration.
#
# Everything is env-configurable (nothing hard-codes the port):
#   PORT           backend/browser port                 (default 8775)
#   OC_REPO        path to the open_controller checkout  (default vendored copy)
#   OC_MODEL       controller conf for the group↔link join
#   SCENARIOS_DIR  where the oc270 scenario is staged    (default /tmp/shared/sumotest)
#   NATS_URL       NATS server                           (default nats://localhost:4222)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8775}"
NATS_URL="${NATS_URL:-nats://localhost:4222}"
OC_REPO="${OC_REPO:-/repos/graph2sumo/vendor/open_controller}"
OC_MODEL="${OC_MODEL:-$OC_REPO/models/JS270_DEMO/contr/JS270_DEMO.json}"
OC_CONTROL_CONF="${OC_CONTROL_CONF:-$OC_REPO/models/testmodel/oc_demo_full_features.json}"  # the OC brain (actuated control of 270)
SCENARIOS_DIR="${SCENARIOS_DIR:-/tmp/shared/sumotest}"
OC_SCENARIO="${OC_SCENARIO:-oc270}"           # WebSUMO scenario name OC publishes under
OC_TESTMODEL="$OC_REPO/models/testmodel"
SIMSRC="/tmp/oc_demo_simsource.json"          # generated: group.status on every step
BLOG=/tmp/oc_demo_backend.log
SLOG=/tmp/oc_demo_simengine.log

_stop() {
    pkill -f 'uvicorn main:app'  2>/dev/null || true
    pkill -f 'sumo_adapter.py'   2>/dev/null || true
    pkill -f 'simengine.py'      2>/dev/null || true
    pkill -f 'clockwork.py'      2>/dev/null || true
}

if [[ "${1:-}" == "stop" ]]; then
    echo "Stopping OC demo (backend + adapter + OC simengine; leaving NATS up)…"
    _stop; echo "Stopped."; exit 0
fi

# ---- 0. deps (fail loudly; jsmin is OC's config reader) ----
missing=$(python3 - <<'PY'
mods = {"nats":"nats-py","libsumo":"libsumo","sumolib":"SUMO distribution",
        "fastapi":"fastapi","uvicorn":"uvicorn[standard]","jsmin":"jsmin",
        # the OC control engine (clockwork) needs these to actuate the signals:
        "transitions":"transitions","pandas":"pandas"}
print("\n".join(f"{m} ({p})" for m,p in mods.items()
      if __import__("importlib").util.find_spec(m) is None))
PY
)
[[ -n "$missing" ]] && { echo "ERROR: missing deps:" >&2; echo "$missing" | sed 's/^/  - /' >&2; exit 1; }

# ---- 1. stage ONLY the net (WebSUMO renders it locally) — no sumocfg, so the
#         backend ATTACHES to OC's live sim instead of spawning its own adapter.
#         OC is the single sim: it runs the traffic and publishes it (step 1b). ----
[[ -f "$OC_TESTMODEL/net/JS270_def.net.xml" ]] \
    || { echo "ERROR: OC net not found under $OC_TESTMODEL (set OC_REPO)" >&2; exit 1; }
mkdir -p "$SCENARIOS_DIR"
cp "$OC_TESTMODEL/net/JS270_def.net.xml" "$SCENARIOS_DIR/$OC_SCENARIO.net.xml"
rm -f "$SCENARIOS_DIR/$OC_SCENARIO.sumocfg"   # ensure attach, not spawn

# ---- 1b. ensure OC's simengine publishes sim.<scenario>.state for WebSUMO (the
#          simbridge adoption). Apply the patch if this OC checkout lacks it. ----
if ! grep -q 'WEBSUMO_PUBLISH' "$OC_REPO/services/simengine/src/simengine.py"; then
    echo "Applying WebSUMO publish patch to OC simengine…"
    ( cd "$OC_REPO" && git apply "$HERE/patches/oc-simengine-websumo-publish.patch" ) \
        || echo "WARNING: could not apply patch — OC may not publish vehicles (see patches/)" >&2
fi

# ---- 2. demo-local simengine conf: publish group.status EVERY step (not on
#         change), so signal colours appear immediately in the browser. This is
#         a generated copy — the OC repo is never modified. ----
python3 - "$OC_TESTMODEL/simsource.json" "$SIMSRC" <<'PY'
import json, re, sys
d = json.loads(re.sub(r'//[^\n]*', '', open(sys.argv[1]).read()))
d['outputs']['sig_outputs']['trigger'] = 'update'
json.dump(d, open(sys.argv[2], 'w'), indent=1)
PY

# ---- 3. NATS ----
if ! pgrep -f 'nats-server' >/dev/null; then
    echo "Starting NATS…"
    setsid "$HERE/nats-server" -c "$HERE/nats-server.conf" >/tmp/oc_demo_nats.log 2>&1 </dev/null &
    sleep 1
fi

# ---- 4. clean slate, then OC-mode backend on $PORT ----
_stop; sleep 1
echo "Starting WebSUMO backend  (OPENCONTROLLER=1, port $PORT)…"
( cd "$HERE/backend" && SCENARIOS_DIR="$SCENARIOS_DIR" NATS_URL="$NATS_URL" \
    OPENCONTROLLER=1 OC_MODEL="$OC_MODEL" \
    setsid python3 -m uvicorn main:app --host 0.0.0.0 --port "$PORT" >"$BLOG" 2>&1 </dev/null & )

echo -n "Waiting for the backend"
for _ in $(seq 1 20); do sleep 1; echo -n "."
    curl -sf "http://localhost:$PORT/api/oc/join" >/dev/null 2>&1 && break; done
echo ""
curl -sf "http://localhost:$PORT/api/oc/join" | grep -q '"enabled": *true' \
    || { echo "ERROR: OC mode not enabled (see $BLOG)" >&2; tail -5 "$BLOG" >&2; exit 1; }

# ---- 5. OC simengine: the single sim. Publishes group.status.270.* (overlay)
#         AND sim.$OC_SCENARIO.state (the traffic WebSUMO renders, via
#         WEBSUMO_PUBLISH). WebSUMO attaches to this — it never runs its own sim. ----
echo "Starting OC simengine (group.status.270.* + sim.$OC_SCENARIO.state)…"
( cd "$OC_REPO" && WEBSUMO_PUBLISH="$OC_SCENARIO" setsid python3 services/simengine/src/simengine.py \
    --nats-server "$(echo "$NATS_URL" | sed -E 's#.*//([^:]+).*#\1#')" \
    --conf "$SIMSRC" --sumo-conf="models/testmodel/JS270_med_traffic.sumocfg" \
    >"$SLOG" 2>&1 </dev/null & )

echo -n "Waiting for OC group.status on the bus"
for _ in $(seq 1 20); do sleep 1; echo -n "."
    if python3 - <<PY 2>/dev/null; then break; fi
import asyncio, nats
async def m():
    nc = await asyncio.wait_for(nats.connect("$NATS_URL"), 3)
    got = {"n": 0}
    async def cb(_): got["n"] += 1
    await nc.subscribe("group.status.270.>", cb=cb)
    await asyncio.sleep(1.5); await nc.drain()
    raise SystemExit(0 if got["n"] else 1)
asyncio.run(m())
PY
done
echo ""

# ---- 6. OC control engine (clockwork): the BRAIN. Without it the simengine
#         holds every signal red (it waits for external control), so the overlay
#         would be a frozen all-red. With it, the signals are actuated live. ----
CLOG=/tmp/oc_demo_control_engine.log
echo "Starting OC control engine ($OC_CONTROL_CONF → group.control.270.*)…"
( cd "$OC_REPO" && setsid python3 services/control_engine/src/clockwork.py \
    --conf-file="$OC_CONTROL_CONF" \
    --nats-server "$(echo "$NATS_URL" | sed -E 's#.*//([^:]+).*#\1#')" \
    >"$CLOG" 2>&1 </dev/null & )
sleep 3
pgrep -f clockwork.py >/dev/null \
    || { echo "WARNING: control engine did not start — signals will stay red (see $CLOG)" >&2; tail -3 "$CLOG" >&2; }

# ---- 7. confirm OC is publishing its traffic (the closed loop) ----
echo -n "Waiting for OC to publish its traffic (sim.$OC_SCENARIO.state)"
for _ in $(seq 1 20); do sleep 1; echo -n "."
    if python3 - <<PY 2>/dev/null; then break; fi
import asyncio, nats
async def m():
    nc = await asyncio.wait_for(nats.connect("$NATS_URL"), 3)
    got = {"n": 0}
    async def cb(_): got["n"] += 1
    await nc.subscribe("sim.$OC_SCENARIO.state", cb=cb)
    await asyncio.sleep(1.5); await nc.drain()
    raise SystemExit(0 if got["n"] else 1)
asyncio.run(m())
PY
done
echo ""

echo ""
echo "✅ OC coherent demo is up — WebSUMO renders OC's actual controlled traffic."
echo "   URL:       http://localhost:$PORT   → select '$OC_SCENARIO', Load, Start (attaches)"
echo "   what:      OC is the single sim; its cars obey OC's signals and OC reacts to them"
echo "   OC panel:  15 signal groups; stoplines colour live by OC's actuated control"
echo "   logs:      backend=$BLOG  simengine=$SLOG  control=$CLOG"
echo "   stop:      ./run_oc_demo.sh stop"
