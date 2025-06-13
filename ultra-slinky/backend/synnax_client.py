import time
import yaml
import json
import asyncio
import aio_pika
from synnax import Synnax, TimeStamp, DataType

CONFIG_PATH = "/config/config.yaml"
BROKER_CONFIG_PATH = "/config/message_broker_config.yaml"

sensor_channels = {}
control_channels = {}
feedback_channels = {}
time_channels = {}
writers = {}
automation_writers = {}
tlm_watch_values = {}

client = Synnax(
    host="synnax",
    port=9095,
    username="synnax",
    password="seldon",
    secure=False
)

amqp_conn = None
amqp_channel = None
streamer = None

def map_channel_ids_from_yaml():
    with open(CONFIG_PATH, "r") as f:
        parsed = yaml.safe_load(f)

    id_map = {}
    if "channels" in parsed:
        for group in parsed["channels"].values():
            if "channels" in group:
                for id, channel in group["channels"].items():
                    id_map[id] = channel["type"]
    return id_map

async def create_channels():
    global amqp_conn, amqp_channel

    with open(BROKER_CONFIG_PATH, "r") as f:
        broker_cfg = yaml.safe_load(f)
    lavin = broker_cfg["brokers"]["lavinmq"]
    lavin_url = f"amqp://{lavin['username']}:{lavin['password']}@{lavin['host']}:{lavin['port']}/{lavin['virtual_host']}"

    amqp_conn = await aio_pika.connect_robust(lavin_url)
    amqp_channel = await amqp_conn.channel()
    await amqp_channel.declare_exchange("CMD_BC", aio_pika.ExchangeType.FANOUT, durable=True)

    channel_map = map_channel_ids_from_yaml()
    start = TimeStamp.now()

    for channel_id, ch_type in channel_map.items():
        try:
            time_index = client.channels.create({
                "name": f"{channel_id}-T",
                "data_type": DataType.TIMESTAMP,
                "is_index": True
            }, retrieve_if_name_exists=True)

            data_channel = client.channels.create({
                "name": channel_id,
                "data_type": DataType.FLOAT32,
                "index": time_index.key
            }, retrieve_if_name_exists=True)

            time_channels[f"{channel_id}-T"] = time_index.key

            if ch_type == "sensor":
                sensor_channels[channel_id] = data_channel.key
                writers[channel_id] = client.open_writer(
                    start=start,
                    channels=[time_index.key, data_channel.key],
                    authorities=[255, 255],
                    enable_auto_commit=True
                )

            elif ch_type == "control":
                control_channels[channel_id] = data_channel.key

                feedback_channel = client.channels.create({
                    "name": f"{channel_id}-F",
                    "data_type": DataType.FLOAT32,
                    "virtual": True
                }, retrieve_if_name_exists=True)

                feedback_channels[f"{channel_id}-F"] = feedback_channel.key

                writers[channel_id] = client.open_writer(
                    start=start,
                    channels=[time_index.key, data_channel.key, feedback_channel.key],
                    authorities=[255, 255, 0],
                    enable_auto_commit=True
                )
        except Exception as e:
            print(f"Error setting up channel {channel_id}: {e}")

    asyncio.create_task(consume_tlm())
    asyncio.create_task(start_feedback_streamer())

async def write_to_synnax(channel_id: str, value):
    timestamp = TimeStamp.now()
    if channel_id in sensor_channels:
        await writers[channel_id].write({
            time_channels[f"{channel_id}-T"]: timestamp,
            sensor_channels[channel_id]: value
        })
    elif channel_id in control_channels:
        await writers[channel_id].write({
            time_channels[f"{channel_id}-T"]: timestamp,
            control_channels[channel_id]: value
        })

async def consume_tlm():
    with open(BROKER_CONFIG_PATH, "r") as f:
        config = yaml.safe_load(f)
    lavin = config["brokers"]["lavinmq"]
    lavin_url = f"amqp://{lavin['username']}:{lavin['password']}@{lavin['host']}:{lavin['port']}/{lavin['virtual_host']}"

    connection = await aio_pika.connect_robust(lavin_url)
    channel = await connection.channel()
    await channel.declare_exchange("TLM", aio_pika.ExchangeType.FANOUT, durable=True)
    queue = await channel.declare_queue("ultra-slinky-tlm", durable=True)
    await queue.bind("TLM")

    async with queue.iterator() as messages:
        async for message in messages:
            async with message.process():
                try:
                    data = json.loads(message.body.decode())
                    if "Data" in data:
                        await handle_tlm(data)
                except Exception as e:
                    print(f"Error processing TLM: {e}")

async def handle_tlm(packet):
    tlm_data = packet["Data"]
    timestamp = TimeStamp.now()

    for channel, value in tlm_data.items():
        await write_to_synnax(channel, value)

        for (watch, do), config in tlm_watch_values.items():
            if watch == channel and value >= config["threshold"]:
                print(f"[ultra-slinky] Automation triggered: {watch} ≥ {config['threshold']} → {do} = {config['do_value']}")
                writer = client.open_writer(
                    start=timestamp,
                    channels=[time_channels[f"{do}-T"], control_channels[do]],
                    authorities=[254, 254],
                    enable_auto_commit=True
                )
                automation_writers[do] = writer
                await writer.write({
                    time_channels[f"{do}-T"]: timestamp,
                    control_channels[do]: config["do_value"]
                })

async def start_feedback_streamer():
    global streamer
    feedback_keys = list(feedback_channels.values())
    if not feedback_keys:
        return

    streamer = client.open_streamer(feedback_keys)
    print("[ultra-slinky] Feedback streamer started")

    async for frame in streamer:
        current = frame[-1]
        for feedback_key, value in current.items():
            for k, v in feedback_channels.items():
                if v == feedback_key:
                    control_id = k.replace("-F", "")
                    packet = {
                        "Source": "Synnax Console",
                        "Time Stamp": str(time.time_ns()),
                        "Data": {control_id: value}
                    }
                    await amqp_channel.default_exchange.publish(
                        aio_pika.Message(body=json.dumps(packet).encode()),
                        routing_key=""
                    )
                    print(f"[ultra-slinky] Feedback: {control_id} = {value}")

def add_bang_bang_automation(watch_channel: str, threshold: float, do_channel: str, do_value: float):
    tlm_watch_values[(watch_channel, do_channel)] = {
        "threshold": threshold,
        "do_value": do_value
    }

def list_bang_bang_automations():
    return {
        f"{watch}->{do}": {
            "watch": watch,
            "do": do,
            "threshold": config["threshold"],
            "do_value": config["do_value"]
        }
        for (watch, do), config in tlm_watch_values.items()
    }

def remove_bang_bang_automation(watch_channel: str, do_channel: str):
    return tlm_watch_values.pop((watch_channel, do_channel), None)

async def graceful_shutdown():
    if streamer:
        streamer.close()

    for w in writers.values():
        await w.close()

    for w in automation_writers.values():
        await w.close()

    if amqp_channel:
        await amqp_channel.close()
    if amqp_conn:
        await amqp_conn.close()

    print("[ultra-slinky] Shutdown complete")