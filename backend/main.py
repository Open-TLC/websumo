import sys
sys.path.insert(0, '/usr/local/lib/python3.14/site-packages/sumo/tools')

import asyncio
import glob
import gzip
import json
import os
import pathlib
import re
import signal
import subprocess
import tempfile
import time

import nats as nats_client
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRouter
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from network import build_network_geojson

SCENARIOS_DIR = os.environ.get('SCENARIOS_DIR', '/tmp/shared/sumotest')
NATS_URL      = os.environ.get('NATS_URL', 'nats://localhost:4222')
FRONTEND_DIST = pathlib.Path(__file__).parent.parent / 'frontend' / 'dist'
ADAPTER_SCRIPT = pathlib.Path(__file__).parent / 'sumo_adapter.py'
# The production build is served same-origin from this app, so CORS is only
# needed for the Vite dev server. Default to the dev origins; override with a
# comma-separated ALLOWED_ORIGINS. Never '*' — these endpoints spawn processes.
ALLOWED_ORIGINS = os.environ.get(
    'ALLOWED_ORIGINS',
    'http://localhost:5173,http://127.0.0.1:5173',
).split(',')

app = FastAPI(title='WebSUMO')
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=['*'],
    allow_headers=['*'],
)

api = APIRouter(prefix='/api')

_adapter_proc: subprocess.Popen | None = None


def _kill_orphans() -> None:
    """Kill any sumo_adapter.py processes left over from a previous server run."""
    try:
        result = subprocess.run(
            ['pgrep', '-f', 'sumo_adapter.py'],
            capture_output=True, text=True,
        )
        for pid in result.stdout.split():
            try:
                os.kill(int(pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
    except FileNotFoundError:
        pass


_kill_orphans()


# Scenarios published live over NATS (integrated mode: OC owns the sim, no local
# files on this host). scenario -> last-seen monotonic time; pruned by staleness.
_live_scenarios: dict[str, float] = {}
_LIVE_TTL_S = 15.0
_nc_app: 'nats_client.aio.client.Client | None' = None


@app.on_event('startup')
async def _connect_nats() -> None:
    """App-level NATS client: discover live scenarios + fetch networks on demand.

    Scenario ids contain dots (fi.helsinki.269), so a `.state` suffix can't be
    matched with a middle `*` wildcard — subscribe to `sim.>` and filter. The
    callback only parses the subject (no payload decode), so the 10 Hz state
    stream is cheap to track."""
    global _nc_app
    try:
        _nc_app = await nats_client.connect(NATS_URL)

        async def on_any(msg: 'nats_client.aio.msg.Msg') -> None:
            subj = msg.subject
            if subj.startswith('sim.') and subj.endswith('.state'):
                _live_scenarios[subj[len('sim.'):-len('.state')]] = time.monotonic()

        await _nc_app.subscribe('sim.>', cb=on_any)
    except Exception:
        _nc_app = None   # NATS down at startup — disk-only mode still works


def _live_scenario_ids() -> list[str]:
    now = time.monotonic()
    return [s for s, seen in _live_scenarios.items() if now - seen < _LIVE_TTL_S]


@api.get('/scenarios')
def list_scenarios() -> list[str]:
    """Local scenarios (built .sumocfg on disk) ∪ scenarios live on NATS."""
    local = {pathlib.Path(c).stem for c in glob.glob(f'{SCENARIOS_DIR}/*.sumocfg')}
    return sorted(local | set(_live_scenario_ids()))


# `scenario` is interpolated into filesystem paths, subprocess argv and NATS
# subjects, so every entry point must constrain it. The character class blocks
# path separators (no traversal); the allowlist ensures it maps to a real built
# scenario. See docs/CLEANUP_FIXLIST.md #1.
_SCENARIO_RE = re.compile(r'^[A-Za-z0-9._-]+$')


def _is_valid_scenario(scenario: str) -> bool:
    return bool(_SCENARIO_RE.match(scenario)) and scenario in list_scenarios()


def _require_scenario(scenario: str) -> None:
    if not _is_valid_scenario(scenario):
        raise HTTPException(404, f'Unknown scenario: {scenario}')


def _require_safe_name(scenario: str) -> None:
    """Regex-only guard (no path traversal / injection). Used where availability
    is proven another way — e.g. the network endpoint, which then confirms a
    scenario exists by finding its .net.xml on disk or fetching it over NATS."""
    if not _SCENARIO_RE.match(scenario):
        raise HTTPException(404, f'Invalid scenario: {scenario}')


async def _fetch_net_over_nats(scenario: str) -> pathlib.Path | None:
    """Request the scenario's .net.xml over NATS and cache it to a temp file.

    Integrated mode: OC owns the scenario and answers `sim.{scenario}.net` with
    the gzipped network (see simbridge.py). Returns the temp path, or None if no
    responder / NATS is down."""
    if _nc_app is None:
        return None
    tmp = pathlib.Path(tempfile.gettempdir()) / f'websumo_net_{scenario}.net.xml'
    if tmp.exists():
        return tmp
    try:
        reply = await _nc_app.request(f'sim.{scenario}.net', b'', timeout=5.0)
    except Exception:
        return None   # no responder within timeout
    try:
        xml = gzip.decompress(reply.data)
    except OSError:
        xml = reply.data   # tolerate an uncompressed responder
    tmp.write_bytes(xml)
    return tmp


def _run_load_check(scenario: str) -> None:
    """Run SUMO for one step in the background to capture load-time warnings.

    Populates the same stderr log the panel reads, so network/route warnings
    are visible right after Load — like sumo-gui's log on config open.
    Skipped while an adapter is running (it owns the log file).
    """
    if _adapter_proc and _adapter_proc.poll() is None:
        return
    cmd = ['sumo', '-c', f'{SCENARIOS_DIR}/{scenario}.sumocfg',
           '--no-step-log', '--end', '1']
    detectors_xml = f'{SCENARIOS_DIR}/{scenario}.detectors.xml'
    if os.path.exists(detectors_xml):
        cmd += ['--additional-files', detectors_xml]
    with open(f'/tmp/sumo_adapter_{scenario}.log', 'w') as log:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=log)


@api.get('/network/{scenario}')
async def get_network(scenario: str) -> dict:
    _require_safe_name(scenario)
    local = pathlib.Path(SCENARIOS_DIR) / f'{scenario}.net.xml'
    if local.exists():
        _run_load_check(scenario)
        return build_network_geojson(str(local))
    # Integrated mode: no local file — fetch the network over NATS from the
    # simengine that owns it. No load-check (we don't have the .sumocfg here).
    net = await _fetch_net_over_nats(scenario)
    if net is None:
        raise HTTPException(404, f'No net.xml on disk or via NATS for scenario: {scenario}')
    return build_network_geojson(str(net))


class StartRequest(BaseModel):
    scenario: str
    end: int | None = None   # simulation end time in seconds; None = use sumocfg default
    scale: float = 1.0       # initial traffic scale (0 = no flow insertion)
    speed: float = 1.0       # initial playback rate


@api.post('/adapter/start')
def start_adapter(req: StartRequest) -> dict:
    global _adapter_proc
    _require_scenario(req.scenario)
    if _adapter_proc and _adapter_proc.poll() is None:
        _adapter_proc.terminate()
        _adapter_proc.wait()
        _adapter_proc = None
    _kill_orphans()

    sumocfg = pathlib.Path(SCENARIOS_DIR) / f'{req.scenario}.sumocfg'
    if not sumocfg.exists():
        raise HTTPException(404, f'Scenario not found: {req.scenario}')

    log = open(f'/tmp/sumo_adapter_{req.scenario}.log', 'w')
    _adapter_proc = subprocess.Popen(
        [sys.executable, str(ADAPTER_SCRIPT), req.scenario, str(req.end or 0),
         str(req.scale), str(req.speed)],
        stdout=log,
        stderr=log,
    )
    return {'ok': True, 'scenario': req.scenario, 'end': req.end}


# runtime warnings already delivered as structured events on sim.{scenario}.log —
# filtered here so the stderr view shows only what the event stream can't
_DYNAMIC_WARNING = re.compile(
    r'Teleporting vehicle|teleports beyond|performs emergency stop'
)


@api.get('/adapter/log/{scenario}')
def get_adapter_log(scenario: str, lines: int = 200, full: bool = False) -> dict:
    """Tail of the adapter's stderr log (SUMO startup warnings, live C++ output)."""
    _require_scenario(scenario)
    path = pathlib.Path(f'/tmp/sumo_adapter_{scenario}.log')
    if not path.exists():
        return {'lines': []}
    out = path.read_text(errors='replace').splitlines()
    if not full:
        out = [l for l in out if not _DYNAMIC_WARNING.search(l)]
    return {'lines': out[-lines:]}


@api.post('/adapter/stop')
def stop_adapter() -> dict:
    global _adapter_proc
    if _adapter_proc:
        _adapter_proc.terminate()
        try:
            _adapter_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _adapter_proc.kill()
        _adapter_proc = None
    _kill_orphans()
    return {'ok': True}


@api.websocket('/ws/{scenario}')
async def ws_endpoint(websocket: WebSocket, scenario: str) -> None:
    """Relay NATS simulation state → browser, and browser commands → NATS."""
    if not _is_valid_scenario(scenario):
        await websocket.close(code=1008)   # policy violation
        return
    await websocket.accept()
    nc = await nats_client.connect(NATS_URL)

    async def on_state(msg: nats_client.aio.msg.Msg) -> None:
        try:
            await websocket.send_text(msg.data.decode())
        except Exception:
            pass

    async def on_end(msg: nats_client.aio.msg.Msg) -> None:
        try:
            await websocket.send_json({'type': 'end'})
        except Exception:
            pass

    await nc.subscribe(f'sim.{scenario}.state', cb=on_state)
    await nc.subscribe(f'sim.{scenario}.end',   cb=on_end)
    # log payloads already carry {"type": "log"} — forward verbatim like state
    await nc.subscribe(f'sim.{scenario}.log',   cb=on_state)

    try:
        while True:
            data = await websocket.receive_json()
            cmd = data.get('cmd', '')
            payload = json.dumps({k: v for k, v in data.items() if k != 'cmd'}).encode()
            await nc.publish(f'sim.{scenario}.cmd.{cmd}', payload)
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        await nc.drain()


app.include_router(api)

if FRONTEND_DIST.exists():
    app.mount('/', StaticFiles(directory=str(FRONTEND_DIST), html=True), name='static')
