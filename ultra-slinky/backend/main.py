from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import asyncio
import os

from synnax_client import (
    create_channels,
    graceful_shutdown,
    add_bang_bang_automation,
    list_bang_bang_automations,
    remove_bang_bang_automation,
)

app = FastAPI()

# Allow frontend to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static frontend files
app.mount("/static", StaticFiles(directory="frontend"), name="static")

@app.get("/", response_class=HTMLResponse)
async def get_index():
    return FileResponse("frontend/index.html")

@app.get("/automations")
async def get_automations():
    return list_bang_bang_automations()

@app.post("/automations")
async def create_automation(request: Request):
    data = await request.json()
    try:
        watch = data["watch"]
        threshold = float(data["threshold"])
        do = data["do"]
        do_value = float(data["do_value"])
        add_bang_bang_automation(watch, threshold, do, do_value)
        return {"status": "added", "rule": f"{watch} → {do}"}
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid automation rule: {e}")

@app.delete("/automations")
async def delete_automation(request: Request):
    data = await request.json()
    try:
        watch = data["watch"]
        do = data["do"]
        result = remove_bang_bang_automation(watch, do)
        if result:
            return {"status": "removed", "rule": f"{watch} → {do}"}
        else:
            raise HTTPException(status_code=404, detail="Rule not found")
    except KeyError:
        raise HTTPException(status_code=400, detail="Missing required fields")

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(create_channels())

@app.on_event("shutdown")
async def shutdown_event():
    await graceful_shutdown()

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8500))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)