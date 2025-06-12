import time
import yaml
import json
import asyncio
from synnax import Synnax, TimeStamp, DataType
import aio_pika

CONFIG_PATH = "/config/message_broker_config.yaml"

sensor_channels = {}
control_channels = {}
feedback_channels = {}
time_channels = {}
writers = {}

client = Synnax(
    host="synnax",
    port=9095,
    username="synnax",
    password="seldon",
    secure=False
)

streamer = None
amqp_conn = None
amqp_channel = None

def map_channel_ids_from_yaml(config_path="/config/config.yaml"):
    with open(config_path, "r") as f:
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

    with open(CONFIG_PATH, "r") as f:
        broker_config = yaml.safe_load(f)
    lavin = broker_config["brokers"]["lavinmq"]
    lavin_url = f"amqp://{lavin['username']}:{lavin['password']}@{lavin['host']}:{lavin['port']}/{lavin['virtual_host']}"

    amqp_conn = await aio_pika.connect_robust(lavin_url)
    amqp_channel = await amqp_conn.channel()
    await amqp_channel.declare_exchange("CMD_BC", aio_pika.ExchangeType.FANOUT, durable=True)

    channel_map = map_channel_ids_from_yaml()
    start = TimeStamp.now()

    for channel_id, ch_type in channel_map.items():
        try:
            if ch_type == "sensor":
                time_index = client.channels.create({
                    "name": f"{channel_id}-T",
                    "data_type": DataType.TIMESTAMP,
                    "is_index": True
                }, retrieve_if_name_exists=True)

                sensor = client.channels.create({
                    "name": channel_id,
                    "data_type": DataType.FLOAT32,
                    "index": time_index.key
                }, retrieve_if_name_exists=True)

                time_channels[f"{channel_id}-T"] = time_index.key
                sensor_channels[channel_id] = sensor.key

                writers[channel_id] = client.open_writer(
                    start=start,
                    channels=[time_index.key, sensor.key],
                    authorities=[255, 255],
                    enable_auto_commit=True
                )

            elif ch_type == "control":
                time_index = client.channels.create({
                    "name": f"{channel_id}-T",
                    "data_type": DataType.TIMESTAMP,
                    "is_index": True
                }, retrieve_if_name_exists=True)

                control = client.channels.create({
                    "name": channel_id,
                    "data_type": DataType.FLOAT32,
                    "index": time_index.key
                }, retrieve_if_name_exists=True)

                feedback = client.channels.create({
                    "name": f"{channel_id}-F",
                    "data_type": DataType.FLOAT32,
                    "virtual": True
                }, retrieve_if_name_exists=True)

                time_channels[f"{channel_id}-T"] = time_index.key
                control_channels[channel_id] = control.key
                feedback_channels[f"{channel_id}-F"] = feedback.key

                writers[channel_id] = client.open_writer(
                    start=start,
                    channels=[time_index.key, control.key, feedback.key],
                    authorities=[255, 255, 0],
                    enable_auto_commit=True
                )
        except Exception as e:
            print(f"Error creating channel {channel_id}: {e}")

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

async def start_feedback_streamer():
    global streamer

    feedback_keys = list(feedback_channels.values())
    if not feedback_keys:
        return

    streamer = client.open_streamer(feedback_keys)
    print("[ultra-slinky] Feedback streamer started")

    async for frame in streamer:
        current = frame[-1]
        for channel_key, value in current.items():
            control_id = [k for k, v in feedback_channels.items() if v == channel_key]
            if not control_id:
                continue

            control_name = control_id[0].replace("-F", "")
            command_packet = {
                "Source": "Synnax Console",
                "Time Stamp": str(int(time.time() * 1e9)),
                "Data": {control_name: value}
            }

            await amqp_channel.default_exchange.publish(
                aio_pika.Message(body=json.dumps(command_packet).encode()),
                routing_key=""
            )
            print(f"[ultra-slinky] Published feedback for {control_name}: {value}")

async def graceful_shutdown():
    if streamer:
        streamer.close()
        print("[ultra-slinky] Streamer closed")

    for id, writer in writers.items():
        try:
            await writer.close()
            print(f"[ultra-slinky] Writer closed for {id}")
        except Exception as e:
            print(f"Failed to close writer for {id}: {e}")

    if amqp_channel:
        await amqp_channel.close()
    if amqp_conn:
        await amqp_conn.close()
    print("[ultra-slinky] AMQP connection closed")