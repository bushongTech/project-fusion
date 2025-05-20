import asyncio
import aio_pika
import yaml
import json
import random
import time

# Shared simulation state
sim_rate_hz = 1
sensor_ranges = {}
latest_values = {}

# Load broker config
with open('/config/message_broker_config.yaml', 'r') as f:
    broker_config = yaml.safe_load(f)

# Load simulation config
with open('/config/config.yaml', 'r') as f:
    sim_config = yaml.safe_load(f)

# Parse sensors and controls
sensors = {}
controls = {}

for group in sim_config.values():
    for channel_id, info in group.get('channels', {}).items():
        if info['type'] == 'sensor':
            sensors[channel_id] = random.randint(1, 100)
            sensor_ranges[channel_id] = (1, 100)
        elif info['type'] == 'control':
            controls[channel_id] = 0

# Broker setup
lavin = broker_config['brokers']['lavinmq']

tlm_queue = next(q['name'] for ex in lavin['exchanges'] if ex['name'] == 'TLM'
                 for q in ex['queues'] if q['name'] == 'strand-burner-auto-tlm')
cmd_queue = next(q['name'] for ex in lavin['exchanges'] if ex['name'] == 'CMD_BC'
                 for q in ex['queues'] if q['name'] == 'strand-burner-auto-cmd')

def timestamp_ms():
    return int(time.time() * 1000)

# Simulate and publish telemetry
async def publish_telemetry(channel):
    exchange = await channel.declare_exchange("TLM", aio_pika.ExchangeType.FANOUT, durable=True)
    while True:
        interval = 1.0 / max(sim_rate_hz, 1)
        data = {}
        for sensor_id in sensors:
            min_val, max_val = sensor_ranges.get(sensor_id, (1, 100))
            sensors[sensor_id] = random.randint(min_val, max_val)
            data[sensor_id] = sensors[sensor_id]
        data.update(controls)
        latest_values.update(data)

        packet = {
            "Source": "strand-burner-auto-tlm",
            "Time Stamp": timestamp_ms(),
            "Data": data
        }

        await exchange.publish(aio_pika.Message(body=json.dumps(packet).encode()), routing_key="")
        await asyncio.sleep(interval)

# Listen to CMD_BC and update controls
async def consume_commands(channel):
    exchange = await channel.declare_exchange("CMD_BC", aio_pika.ExchangeType.FANOUT, durable=True)
    queue = await channel.declare_queue(cmd_queue, durable=True)
    await queue.bind(exchange)

    async with queue.iterator() as queue_iter:
        async for message in queue_iter:
            async with message.process():
                try:
                    msg = json.loads(message.body.decode())
                    print(f"[CMD_BC] Received message:\n{json.dumps(msg, indent=2)}")
                    for k, v in msg.get("Data", {}).items():
                        if k in controls:
                            controls[k] = v
                            print(f"→ Updated control: {k} = {v}")
                except Exception as e:
                    print(f"CMD_BC error: {e}")

# Entry point
async def main():
    connection = await aio_pika.connect_robust(
        host=lavin['host'],
        port=lavin['port'],
        login=lavin['username'],
        password=lavin['password'],
        virtualhost=lavin['virtual_host'],
    )

    async with connection:
        channel = await connection.channel()
        await asyncio.gather(
            publish_telemetry(channel),
            consume_commands(channel)
        )

if __name__ == "__main__":
    asyncio.run(main())