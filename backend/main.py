import sys
sys.path.insert(0, '/usr/local/lib/python3.14/site-packages/sumo/tools')

import glob
import json
import os
import pathlib
import re
import signal
import subprocess

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

app = FastAPI(title='WebSUMO')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
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


@api.get('/scenarios')
def list_scenarios() -> list[str]:
    cfgs = sorted(glob.glob(f'{SCENARIOS_DIR}/*.sumocfg'))
    return [pathlib.Path(c).stem for c in cfgs]


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
def get_network(scenario: str) -> dict:
    net_xml = pathlib.Path(SCENARIOS_DIR) / f'{scenario}.net.xml'
    if not net_xml.exists():
        raise HTTPException(404, f'No net.xml for scenario: {scenario}')
    _run_load_check(scenario)
    return build_network_geojson(str(net_xml))


class StartRequest(BaseModel):
    scenario: str
    end: int | None = None   # simulation end time in seconds; None = use sumocfg default


@api.post('/adapter/start')
def start_adapter(req: StartRequest) -> dict:
    global _adapter_proc
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
        [sys.executable, str(ADAPTER_SCRIPT), req.scenario, str(req.end or 0)],
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
