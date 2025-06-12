from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from backend.lavinmq_client import send_command
from backend.synnax_client import write_to_synnax

app = FastAPI()

# Serve static files from the frontend folder
app.mount("/", StaticFiles(directory="frontend", html=True), name="static")

# Enable CORS for all origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)

@app.post("/api/command")
async def handle_command(request: Request):
    data = await request.json()
    component_id = data.get("id")
    value = data.get("value")

    await send_command(component_id, value)
    await write_to_synnax(component_id, value)

    return {"status": "sent", "id": component_id, "value": value}