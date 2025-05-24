import asyncio
import aio_pika
import json
import time

LAVINMQ_HOST = "lavinmq0"
QUEUE_NAME = "multi-translator-sim"
CMD_EXCHANGE = "CMD_BC"
TLM_EXCHANGE = "TLM"

async def main():
    connection = await aio_pika.connect_robust(
        f"amqp://guest:guest@{LAVINMQ_HOST}/"
    )

    async with connection:
        channel = await connection.channel()

        cmd_exchange = await channel.declare_exchange(CMD_EXCHANGE, aio_pika.ExchangeType.FANOUT)
        queue = await channel.declare_queue(QUEUE_NAME, durable=True)
        await queue.bind(cmd_exchange)

        tlm_exchange = await channel.declare_exchange(TLM_EXCHANGE, aio_pika.ExchangeType.FANOUT)

        print(f"[multi-translator-sim] Listening on queue '{QUEUE_NAME}'...")

        async with queue.iterator() as queue_iter:
            async for message in queue_iter:
                async with message.process():
                    try:
                        data = json.loads(message.body.decode())
                        payload = data.get("Data")

                        if not payload or not isinstance(payload, dict):
                            continue

                        timestamp = int(time.time() * 1000)

                        echo_packet = {
                            "Source": "multi-translator-sim",
                            "Time Stamp": timestamp,
                            "Data": payload,
                        }

                        await tlm_exchange.publish(
                            aio_pika.Message(
                                body=json.dumps(echo_packet).encode()
                            ),
                            routing_key=""
                        )

                    except Exception as e:
                        print(f"[ERROR] Failed to process message: {e}")

if __name__ == "__main__":
    asyncio.run(main())