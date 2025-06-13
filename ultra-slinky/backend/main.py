from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi import status

from backend.synnax_client import (
    create_channels,
    graceful_shutdown,
    add_bang_bang_automation,
    list_bang_bang_automations,
    remove_bang_bang_automation
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

@app.get("/api/automation/bang-bang")
async def get_all_bang_bang_rules():
    return list_bang_bang_automations()

@app.delete("/api/automation/bang-bang")
async def delete_bang_bang_rule(request: Request):
    body = await request.json()
    watch_channel = body["watch"]
    do_channel = body["do"]

    removed = remove_bang_bang_automation(watch_channel, do_channel)
    if removed is None:
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"error": "Rule not found"})
    return {
        "status": "rule removed",
        "watch": watch_channel,
        "do": do_channel
    }