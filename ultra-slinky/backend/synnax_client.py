import asyncio
import json
import os
import time
from typing import Dict, Any

import aio_pika
import yaml
from synnax import Synnax, DataType, TimeStamp

CONFIG_PATH = "config/config.yaml"
BROKER_CONFIG_PATH = "config/message_broker_config.yaml"
AUTOMATION_RULES_PATH = "automations.json"

CMD_EXCHANGE = "CMD_BC"
TLM_EXCHANGE = "TLM"
TLM_QUEUE = "ultra-slinky-tlm"

synnax_client = Synnax("synnax", 9095, "synnax", "seldon", secure=False)

time_channel_map = {}
channel_map = {}
writers_map = {}

automations = []

def load_automation_rules():
    global automations
    if os.path.exists(AUTOMATION_RULES_PATH):
        with open(AUTOMATION_RULES_PATH, "r") as f:
            automations = json.load(f)

def save_automation_rules():
    with open(AUTOMATION_RULES_PATH, "w") as f:
        json.dump(automations, f, indent=2)

def add_automation(rule: Dict[str, Any]):
    automations.append(rule)
    save_automation_rules()

def remove_automation(watch: str, do: str) -> bool:
    global automations
    before = len(automations)
    automations = [r for r in automations if not (r["watch"] == watch and r["do"] == do)]
    save_automation_rules()
    return len(automations) < before

def list_automations():
    return automations

def should_trigger(rule: Dict[str, Any], value: float, last_value: float = None) -> bool:
    typ = rule["type"]
    if typ == "bang-bang":
        return value >= rule["threshold"]
    if typ == "range":
        return rule["min"] <= value <= rule["max"]
    if typ == "delayed":
        return value >= rule["threshold"]
    if typ == "rising" and last_value is not None:
        return last_value < rule["threshold"] <= value
    if typ == "falling" and last_value is not None:
        return last_value > rule["threshold"] >= value
    return False

delayed_tasks = {}

async def execute_do(rule):
    do = rule["do"]
    val = rule["do_value"]
    writer = writers_map.get(do)
    if writer:
        ts = TimeStamp.now()
        await writer.write({
            time_channel_map[f"{do}-T"]: ts,
            channel_map[do]: val
        })

async def handle_tlm_packet(payload, last_values):
    ts = TimeStamp.now()
    data = payload.get("Data", {})
    for k, v in data.items():
        last_v = last_values.get(k)
        last_values[k] = v

        if k in channel_map and k in writers_map:
            await writers_map[k].write({
                time_channel_map[f"{k}-T"]: ts,
                channel_map[k]: v
            })

        for rule in automations:
            if rule["watch"] == k:
                if rule["type"] == "delayed" and should_trigger(rule, v, last_v):
                    key = f"{k}->{rule['do']}"
                    if key not in delayed_tasks:
                        delayed_tasks[key] = asyncio.create_task(
                            delayed_action(rule, key)
                        )
                elif should_trigger(rule, v, last_v):
                    await execute_do(rule)

async def delayed_action(rule, key):
    await asyncio.sleep(rule["delay"])
    await execute_do(rule)
    delayed_tasks.pop(key, None)

async def create_channels():
    with open(CONFIG_PATH) as f:
        parsed = yaml.safe_load(f)

    for group in parsed.get("channels", {}).values():
        for channel_id, props in group["channels"].items():
            if props["type"] not in ["sensor", "control"]:
                continue
            ts_channel = await synnax_client.channels.create({
                "name": f"{channel_id}-T",
                "dataType": "timestamp",
                "isIndex": True
            }, retrieve_if_name_exists=True)

            data_channel = await synnax_client.channels.create({
                "name": channel_id,
                "dataType": DataType.FLOAT32,
                "index": ts_channel.key
            }, retrieve_if_name_exists=True)

            time_channel_map[f"{channel_id}-T"] = ts_channel.key
            channel_map[channel_id] = data_channel.key

            writer = await synnax_client.open_writer({
                "start": TimeStamp.now(),
                "channels": [ts_channel.key, data_channel.key],
                "authorities": [255, 255],
                "enableAutoCommit": True
            })
            writers_map[channel_id] = writer

    load_automation_rules()
    await setup_lavinmq()
    asyncio.create_task(start_feedback_streamer())

async def setup_lavinmq():
    with open(BROKER_CONFIG_PATH, "r") as f:
        broker = yaml.safe_load(f)["brokers"]["lavinmq"]

    url = f"amqp://{broker['username']}:{broker['password']}@{broker['host']}:{broker['port']}/{broker['virtual_host']}"
    conn = await aio_pika.connect_robust(url)
    ch = await conn.channel()
    await ch.declare_exchange(TLM_EXCHANGE, aio_pika.ExchangeType.FANOUT, durable=True)
    q = await ch.declare_queue(TLM_QUEUE, durable=True)
    await q.bind(exchange=TLM_EXCHANGE)

    last_values = {}

    async with q.iterator() as it:
        async for msg in it:
            async with msg.process():
                payload = json.loads(msg.body.decode())
                await handle_tlm_packet(payload, last_values)

async def start_feedback_streamer():
    feedback_keys = [k for k in channel_map if k.endswith("-F")]
    if not feedback_keys:
        return
    streamer = await synnax_client.open_streamer(feedback_keys)
    async for frame in streamer:
        latest = frame[-1]
        for key, value in latest.items():
            if key.endswith("-F"):
                do = key[:-2]
                command_packet = {
                    "Source": "Synnax Console",
                    "Time Stamp": str(time.time_ns()),
                    "Data": {do: value}
                }
                await publish_cmd(command_packet)

cmd_channel = None
cmd_conn = None

async def publish_cmd(packet: dict):
    global cmd_conn, cmd_channel
    if cmd_conn is None:
        with open(BROKER_CONFIG_PATH, "r") as f:
            broker = yaml.safe_load(f)["brokers"]["lavinmq"]
        url = f"amqp://{broker['username']}:{broker['password']}@{broker['host']}:{broker['port']}/{broker['virtual_host']}"
        cmd_conn = await aio_pika.connect_robust(url)
        cmd_channel = await cmd_conn.channel()
        await cmd_channel.declare_exchange(CMD_EXCHANGE, aio_pika.ExchangeType.FANOUT, durable=True)

    await cmd_channel.default_exchange.publish(
        aio_pika.Message(body=json.dumps(packet).encode()),
        routing_key=""
    )

async def graceful_shutdown():
    for w in writers_map.values():
        await w.close()
    if cmd_channel:
        await cmd_channel.close()
    if cmd_conn:
        await cmd_conn.close()