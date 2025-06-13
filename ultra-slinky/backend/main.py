from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import uvicorn
import json
from synnax_client import load_existing_automations, add_automation_rule, remove_automation_rule, automation_lock

app = FastAPI()

# Static frontend files
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

AUTOMATIONS_FILE = Path("automations.json")

@app.on_event("startup")
async def startup_event():
    AUTOMATIONS_FILE.touch(exist_ok=True)
    if AUTOMATIONS_FILE.read_text().strip() == "":
        AUTOMATIONS_FILE.write_text("[]")
    await load_existing_automations(AUTOMATIONS_FILE)

@app.get("/automations")
async def list_automations():
    async with automation_lock:
        with AUTOMATIONS_FILE.open("r") as f:
            return json.load(f)

@app.post("/automations")
async def create_automation(request: Request):
    data = await request.json()
    async with automation_lock:
        with AUTOMATIONS_FILE.open("r+") as f:
            rules = json.load(f)
            rules.append(data)
            f.seek(0)
            json.dump(rules, f, indent=2)
            f.truncate()
    await add_automation_rule(data)
    return JSONResponse(content={"status": "added"}, status_code=201)

@app.delete("/automations")
async def delete_automation(watch: str, do: str):
    async with automation_lock:
        with AUTOMATIONS_FILE.open("r+") as f:
            rules = json.load(f)
            new_rules = [r for r in rules if not (r["watch"] == watch and r["do"] == do)]
            f.seek(0)
            json.dump(new_rules, f, indent=2)
            f.truncate()
    await remove_automation_rule(watch, do)
    return JSONResponse(content={"status": "deleted"}, status_code=200)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8500)