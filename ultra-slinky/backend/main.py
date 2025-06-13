from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import asyncio
import synnax_client

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(synnax_client.create_channels())

@app.on_event("shutdown")
async def shutdown_event():
    await synnax_client.graceful_shutdown()

@app.get("/automations")
def get_automations():
    return synnax_client.list_automations()

@app.post("/automations")
def add_automation(rule: dict):
    required_keys = ["type", "watch", "do", "do_value"]
    for key in required_keys:
        if key not in rule:
            raise HTTPException(status_code=400, detail=f"Missing key: {key}")

    rule_type = rule["type"]
    if rule_type not in ["bang-bang", "range", "delayed", "rising", "falling"]:
        raise HTTPException(status_code=400, detail="Unsupported automation type")

    if rule_type == "bang-bang" and "threshold" not in rule:
        raise HTTPException(status_code=400, detail="Missing 'threshold' for bang-bang rule")
    if rule_type == "range" and ("min" not in rule or "max" not in rule):
        raise HTTPException(status_code=400, detail="Missing 'min' or 'max' for range rule")
    if rule_type == "delayed" and ("threshold" not in rule or "delay" not in rule):
        raise HTTPException(status_code=400, detail="Missing 'threshold' or 'delay' for delayed rule")
    if rule_type in ["rising", "falling"] and "threshold" not in rule:
        raise HTTPException(status_code=400, detail="Missing 'threshold' for edge rule")

    synnax_client.add_automation(rule)
    return {"status": "added", "rule": rule}

@app.delete("/automations")
def delete_automation(watch: str, do: str):
    success = synnax_client.remove_automation(watch, do)
    if not success:
        raise HTTPException(status_code=404, detail="Rule not found")
    return {"status": "deleted", "watch": watch, "do": do}

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8500)