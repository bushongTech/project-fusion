from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.lavinmq_client import send_command
from backend.synnax_client import (
    create_channels,
    write_to_synnax,
    graceful_shutdown,
    add_bang_bang_automation
)

app = FastAPI()

app.mount("/", StaticFiles(directory="frontend", html=True), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)

@app.on_event("startup")
async def startup_event():
    await create_channels()

@app.on_event("shutdown")
async def shutdown_event():
    await graceful_shutdown()

@app.post("/api/command")
async def handle_command(request: Request):
    data = await request.json()
    component_id = data.get("id")
    value = data.get("value")

    await send_command(component_id, value)
    await write_to_synnax(component_id, value)

    return {"status": "sent", "id": component_id, "value": value}

@app.post("/api/automation/bang-bang")
async def define_bang_bang(request: Request):
    body = await request.json()
    watch_channel = body["watch"]
    threshold = float(body["threshold"])
    do_channel = body["do"]
    do_value = float(body["do_value"])

    add_bang_bang_automation(watch_channel, threshold, do_channel, do_value)

    return {
        "status": "rule added",
        "watch": watch_channel,
        "threshold": threshold,
        "do": do_channel,
        "do_value": do_value
    }