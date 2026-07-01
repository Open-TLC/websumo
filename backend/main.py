import sys
sys.path.insert(0, '/usr/local/lib/python3.14/site-packages/sumo/tools')

import asyncio
import glob
import os
import pathlib

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from network import build_network_geojson
from session import handle_command, session_manager, step_loop

SCENARIOS_DIR = os.environ.get('SCENARIOS_DIR', '/tmp/shared/sumotest')

app = FastAPI(title='WebSUMO')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.get('/scenarios')
def list_scenarios() -> list[str]:
    cfgs = sorted(glob.glob(f'{SCENARIOS_DIR}/*.sumocfg'))
    return [pathlib.Path(c).stem for c in cfgs]


@app.get('/network/{scenario}')
def get_network(scenario: str) -> dict:
    net_xml = pathlib.Path(SCENARIOS_DIR) / f'{scenario}.net.xml'
    if not net_xml.exists():
        raise HTTPException(404, f'No net.xml for scenario: {scenario}')
    return build_network_geojson(str(net_xml))


class StartRequest(BaseModel):
    scenario: str


@app.post('/session/start')
async def start_session(req: StartRequest) -> dict:
    if session_manager.active:
        raise HTTPException(409, 'Session already active — stop it first')
    sumocfg = pathlib.Path(SCENARIOS_DIR) / f'{req.scenario}.sumocfg'
    net_xml = pathlib.Path(SCENARIOS_DIR) / f'{req.scenario}.net.xml'
    if not sumocfg.exists():
        raise HTTPException(404, f'Scenario not found: {req.scenario}')
    session_id = await session_manager.start(str(sumocfg), str(net_xml))
    return {'session_id': session_id}


@app.post('/session/stop')
async def stop_session() -> dict:
    await session_manager.stop()
    return {'ok': True}


@app.websocket('/ws/{session_id}')
async def ws_endpoint(websocket: WebSocket, session_id: str) -> None:
    session = session_manager.get(session_id)
    if not session:
        await websocket.close(code=1008, reason='Session not found')
        return

    await websocket.accept()
    session.websocket = websocket
    step_task = asyncio.create_task(step_loop(session))

    try:
        while True:
            data = await websocket.receive_json()
            handle_command(session, data)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        session.running = False
        step_task.cancel()
        try:
            await step_task
        except asyncio.CancelledError:
            pass
        await session_manager.stop()
