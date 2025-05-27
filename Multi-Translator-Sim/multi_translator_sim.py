import asyncio
import aio_pika
import yaml
import json
import time

CONFIG_PATH = "/config/message_broker_config.yaml"

CMD_EXCHANGE = "CMD_BC"
TLM_EXCHANGE = "TLM"
CMD_QUEUE = "multi-translator-sim-cmd"
TLM_QUEUE = "multi-translator-sim-tlm"

async def main():
    with open(CONFIG_PATH, "r") as f:
        config = yaml.safe_load(f)

    lavin = config["brokers"]["lavinmq"]
    lavin_url = f"amqp://{lavin['username']}:{lavin['password']}@{lavin['host']}:{lavin['port']}/{lavin['virtual_host']}"

    connection = await aio_pika.connect_robust(lavin_url)
    channel = await connection.channel()

    await channel.declare_exchange(CMD_EXCHANGE, aio_pika.ExchangeType.FANOUT, durable=True)
    await channel.declare_exchange(TLM_EXCHANGE, aio_pika.ExchangeType.FANOUT, durable=True)

    cmd_queue = await channel.declare_queue(CMD_QUEUE, durable=True)
    await cmd_queue.bind(exchange=CMD_EXCHANGE)

    await channel.declare_queue(TLM_QUEUE, durable=True)

    print("[multi-translator-sim] Listening on CMD_BC...")

    async with cmd_queue.iterator() as queue_iter:
        async for message in queue_iter:
            async with message.process():
                try:
                    body = json.loads(message.body.decode())
                    if not isinstance(body, dict) or "Data" not in body:
                        continue

                    timestamp_ns = time.time_ns()
                    echo_packet = {
                        "Source": body.get("Source", "Unknown"),
                        "Time Stamp": str(timestamp_ns),
                        "Data": body["Data"]
                    }

                    telemetry_exchange = await channel.get_exchange(TLM_EXCHANGE)
                    await telemetry_exchange.publish(
                        aio_pika.Message(body=json.dumps(echo_packet).encode()),
                        routing_key=""
                    )

                except Exception as e:
                    print(f"[multi-translator-sim] Error: {e}")

if __name__ == "__main__":
    asyncio.run(main())