#!/usr/bin/env bash
#
# Run WebSUMO in the intended FILE-FREE (NATS-only) mode.
#
#   ./run.sh [scenario]     start the stack (default scenario: fi.helsinki.269)
#   ./run.sh stop           stop everything this script started
#
# File-free means the WebSUMO backend holds NO scenario files: a simengine
# (here, our own sumo_adapter.py — the stand-in for OC's simengine) serves the
# network + detectors + routes + live state entirely over NATS. The backend runs
# with an empty SCENARIOS_DIR and fetches everything on demand.
#
# Layout:
#   NATS  ──  backend (empty SCENARIOS_DIR, :8775)  ── browser
#     └────  simengine (reads real files, publishes over NATS)
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8775}"                                 # override with PORT=… (e.g. the only port a container exposes)
NATS_URL="${NATS_URL:-nats://localhost:4222}"
FILES_DIR="${SCENARIOS_DIR:-/tmp/shared/sumotest}"   # where the real scenario files live (simengine reads these)
EMPTY_DIR="/tmp/websumo-nofiles"                     # the backend's dir: intentionally empty (file-free)
SCENARIO="${1:-fi.helsinki.269}"
BLOG=/tmp/websumo-backend.log
SLOG=/tmp/websumo-simengine.log
NLOG=/tmp/websumo-nats.log

_stop() {
    pkill -f 'uvicorn main:app'  2>/dev/null || true
    pkill -f 'sumo_adapter.py'   2>/dev/null || true
}

if [[ "${1:-}" == "stop" ]]; then
    echo "Stopping WebSUMO backend + simengine (leaving NATS up)…"
    _stop
    echo "Stopped."
    exit 0
fi

# ---- 0. dependency check (fail loudly — this is what silently broke before) ----
missing=$(python3 - <<'PY'
mods = {"nats": "nats-py", "libsumo": "libsumo", "sumolib": "SUMO distribution",
        "fastapi": "fastapi", "uvicorn": "uvicorn[standard]", "pydantic": "pydantic"}
miss = []
for mod, pkg in mods.items():
    try:
        __import__(mod)
    except Exception:
        miss.append(f"{mod} (install: {pkg})")
print("\n".join(miss))
PY
)
if [[ -n "$missing" ]]; then
    echo "ERROR: missing Python dependencies:" >&2
    echo "$missing" | sed 's/^/  - /' >&2
    echo "" >&2
    echo "Install the pip deps with:  python3 -m pip install --user -r backend/requirements.txt" >&2
    echo "(sumolib comes from the SUMO distribution — install SUMO separately.)" >&2
    exit 1
fi

# ---- 1. scenario files must exist for the simengine to serve ----
if [[ ! -f "$FILES_DIR/$SCENARIO.sumocfg" ]]; then
    echo "ERROR: no scenario files for '$SCENARIO' in $FILES_DIR" >&2
    echo "  (set SCENARIOS_DIR=… to point at the built scenarios, or build them first)" >&2
    exit 1
fi

# ---- 2. NATS ----
if ! pgrep -f 'nats-server' >/dev/null; then
    echo "Starting NATS…"
    setsid "$HERE/nats-server" -c "$HERE/nats-server.conf" >"$NLOG" 2>&1 </dev/null &
    sleep 1
fi
pgrep -f 'nats-server' >/dev/null || { echo "ERROR: NATS failed to start (see $NLOG)" >&2; exit 1; }

# ---- 3. clean slate for backend + simengine ----
_stop
sleep 1
mkdir -p "$EMPTY_DIR"; rm -f "$EMPTY_DIR"/*        # backend dir stays empty (file-free)
rm -f /tmp/websumo_net_"$SCENARIO".*               # clear any cached fetched files

# ---- 4. backend (NO local files) ----
echo "Starting backend  (file-free: SCENARIOS_DIR=$EMPTY_DIR, port $PORT)…"
( cd "$HERE/backend" && SCENARIOS_DIR="$EMPTY_DIR" NATS_URL="$NATS_URL" \
    setsid python3 -m uvicorn main:app --host 0.0.0.0 --port "$PORT" >"$BLOG" 2>&1 </dev/null & )

# Wait until the backend is fully up BEFORE starting the simengine. The backend
# runs _kill_orphans() (kills stray sumo_adapter.py) at startup, so a simengine
# started too early would be killed by that race.
echo -n "Waiting for the backend"
for _ in $(seq 1 20); do
    sleep 1; echo -n "."
    curl -sf "http://localhost:$PORT/api/scenarios" >/dev/null 2>&1 && break
done
echo ""
curl -sf "http://localhost:$PORT/api/scenarios" >/dev/null 2>&1 \
    || { echo "ERROR: backend did not come up (see $BLOG)" >&2; tail -5 "$BLOG" >&2; exit 1; }

# ---- 5. simengine (serves the scenario over NATS) ----
echo "Starting simengine ($SCENARIO, files from $FILES_DIR)…"
( cd "$HERE/backend" && SCENARIOS_DIR="$FILES_DIR" NATS_URL="$NATS_URL" \
    setsid python3 sumo_adapter.py "$SCENARIO" >"$SLOG" 2>&1 </dev/null & )

# ---- 6. wait for the scenario to appear (discovery via live state) ----
echo -n "Waiting for the simengine to come online"
ok=""
for _ in $(seq 1 30); do
    sleep 1; echo -n "."
    if curl -s "http://localhost:$PORT/api/scenarios" 2>/dev/null | grep -q "$SCENARIO"; then ok=1; break; fi
done
echo ""
if [[ -z "$ok" ]]; then
    echo "ERROR: '$SCENARIO' never appeared over NATS. Logs:" >&2
    echo "  backend:   $BLOG"; echo "  simengine: $SLOG" >&2
    tail -5 "$SLOG" >&2 || true
    exit 1
fi

# ---- 7. verify the network renders over NATS (no local files) ----
feats=$(curl -s "http://localhost:$PORT/api/network/$SCENARIO" \
        | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('features',[])))" 2>/dev/null || echo 0)

echo ""
echo "✅ WebSUMO is up, FILE-FREE (all over NATS)."
echo "   URL:            http://localhost:$PORT   → pick '$SCENARIO', Load, Start"
echo "   backend dir:    $EMPTY_DIR  ($(ls -1 "$EMPTY_DIR" | wc -l | tr -d ' ') files — it holds none)"
echo "   network render: $feats features fetched over NATS"
echo "   logs:           backend=$BLOG  simengine=$SLOG"
echo "   stop with:      ./run.sh stop"
