import aio_pika
import yaml
import json
import time

CONFIG_PATH = "/config/message_broker_config.yaml"
CMD_EXCHANGE = "CMD_BC"

async def send_command(component_id: str, value):
    with open(CONFIG_PATH, "r") as f:
        config = yaml.safe_load(f)

    lavin = config["brokers"]["lavinmq"]
    lavin_url = f"amqp://{lavin['username']}:{lavin['password']}@{lavin['host']}:{lavin['port']}/{lavin['virtual_host']}"

    message = {
        "Source": "ultra-slinky",
        "Time Stamp": str(time.time_ns()),  # nanoseconds
        "Data": {component_id: value}
    }

    connection = await aio_pika.connect_robust(lavin_url)
    async with connection:
        channel = await connection.channel()

        # Declare exchange in case it's not already declared
        await channel.declare_exchange(CMD_EXCHANGE, aio_pika.ExchangeType.FANOUT, durable=True)
        exchange = await channel.get_exchange(CMD_EXCHANGE)

        await exchange.publish(
            aio_pika.Message(body=json.dumps(message).encode()),
            routing_key=""
        )