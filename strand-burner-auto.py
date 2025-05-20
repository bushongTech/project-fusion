import asyncio
import aio_pika
import yaml
import json
import random
import time
from strand_burner_sim_ui import shared_state, setup_ui

# Load configuration files
with open('/config/message_broker_config.yaml', 'r') as f:
    broker_config = yaml.safe_load(f)

with open('/config/config.yaml', 'r') as f:
    sim_config = yaml.safe_load(f)

# Initialize sensors and controls
sensors = {}
controls = {}

for group in sim_config.values():
    for channel_id, info in group.get('channels', {}).items():
        if info['type'] == 'sensor':
            sensors[channel_id] = random.randint(1, 100)
            shared_state['sensor_ranges'][channel_id] = (1, 100)  # default
        elif info['type'] == 'control':
            controls[channel_id] = 0

lavin = broker_config['brokers']['lavinmq']

# Extract queues
tlm_queue = next(q['name'] for ex in lavin['exchanges'] if ex['name'] == 'TLM' for q in ex['queues'] if q['name'] == 'strand-burner-auto-tlm')
cmd_queue = next(q['name'] for ex in lavin['exchanges'] if ex['name'] == 'CMD_BC' for q in ex['queues'] if q['name'] == 'strand-burner-auto-cmd')

def timestamp_ms():
    return int(time.time() * 1000)

async def publish_telemetry(channel):
    exchange = await channel.declare_exchange("TLM", aio_pika.ExchangeType.FANOUT, durable=True)
    while True:
        rate = shared_state.get('sim_rate_hz', 1)
        interval = 1.0 / max(rate, 1)

        data = {}
        for k in sensors:
            min_val, max_val = shared_state['sensor_ranges'].get(k, (1, 100))
            data[k] = random.randint(min_val, max_val)
        data.update(controls)

        shared_state['latest_values'] = data.copy()

        packet = {
            "Source": "strand-burner-auto-tlm",
            "Time Stamp": timestamp_ms(),
            "Data": data
        }

        await exchange.publish(aio_pika.Message(body=json.dumps(packet).encode()), routing_key="")
        await asyncio.sleep(interval)

async def consume_commands(channel):
    exchange = await channel.declare_exchange("CMD_BC", aio_pika.ExchangeType.FANOUT, durable=True)
    queue = await channel.declare_queue(cmd_queue, durable=True)
    await queue.bind(exchange)

    async with queue.iterator() as queue_iter:
        async for message in queue_iter:
            async with message.process():
                try:
                    raw = message.body.decode()
                    msg = json.loads(raw)
                    print(f"[CMD_BC] Received message:\n{json.dumps(msg, indent=2)}")
                    for k, v in msg.get("Data", {}).items():
                        if k in controls:
                            controls[k] = v
                            print(f"→ Updated control: {k} = {v}")
                except Exception as e:
                    print(f"CMD_BC error: {e}")

async def main():
    setup_ui()

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