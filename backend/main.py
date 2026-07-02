import sys
sys.path.insert(0, '/usr/local/lib/python3.14/site-packages/sumo/tools')

import glob
import os
import pathlib
import signal
import subprocess

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRouter
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from network import build_network_geojson

SCENARIOS_DIR = os.environ.get('SCENARIOS_DIR', '/tmp/shared/sumotest')
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
        pass  # pgrep not available


_kill_orphans()


@api.get('/scenarios')
def list_scenarios() -> list[str]:
    cfgs = sorted(glob.glob(f'{SCENARIOS_DIR}/*.sumocfg'))
    return [pathlib.Path(c).stem for c in cfgs]


@api.get('/network/{scenario}')
def get_network(scenario: str) -> dict:
    net_xml = pathlib.Path(SCENARIOS_DIR) / f'{scenario}.net.xml'
    if not net_xml.exists():
        raise HTTPException(404, f'No net.xml for scenario: {scenario}')
    return build_network_geojson(str(net_xml))


class StartRequest(BaseModel):
    scenario: str


@api.post('/adapter/start')
def start_adapter(req: StartRequest) -> dict:
    global _adapter_proc
    # stop tracked adapter and any orphaned processes
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
        [sys.executable, str(ADAPTER_SCRIPT), req.scenario],
        stdout=log,
        stderr=log,
    )
    return {'ok': True, 'scenario': req.scenario}


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


app.include_router(api)

if FRONTEND_DIST.exists():
    app.mount('/', StaticFiles(directory=str(FRONTEND_DIST), html=True), name='static')
