import asyncio
import aio_pika
import yaml
import json
import random
import time
from nicegui import ui

# Shared UI state
shared_state = {
    'sim_rate_hz': 1,
    'sensor_ranges': {},
    'latest_values': {}
}

# Setup NiceGUI UI
def setup_ui():
    ui.label('Strand Burner Simulator').classes('text-2xl font-bold mb-4')

    with ui.card().classes('mb-4'):
        ui.label('Simulation Rate (Hz)')
        sim_rate_slider = ui.slider(min=1, max=100, value=shared_state['sim_rate_hz'], step=1)
        sim_rate_slider.on_change(lambda e: shared_state.update({'sim_rate_hz': e.value}))
        ui.label().bind_text_from(sim_rate_slider, 'value', lambda v: f'{v} Hz')

    with ui.card().classes('mb-4'):
        ui.label('Sensor Ranges')
        range_container = ui.column().classes('gap-2')

        def update_sensor_controls():
            range_container.clear()
            for sensor_id, (min_val, max_val) in shared_state['sensor_ranges'].items():
                with range_container:
                    ui.label(sensor_id).classes('text-bold')
                    min_input = ui.number(label='Min', value=min_val, on_change=lambda e, sid=sensor_id: update_range(sid, e.value, None))
                    max_input = ui.number(label='Max', value=max_val, on_change=lambda e, sid=sensor_id: update_range(sid, None, e.value))

        def update_range(sensor_id, new_min, new_max):
            cur_min, cur_max = shared_state['sensor_ranges'].get(sensor_id, (1, 100))
            shared_state['sensor_ranges'][sensor_id] = (
                new_min if new_min is not None else cur_min,
                new_max if new_max is not None else cur_max
            )

        update_sensor_controls()

    with ui.card().classes('mb-4'):
        ui.label('Live Telemetry').classes('text-bold')
        value_grid = ui.column()

        def update_live_values():
            with value_grid:
                value_grid.clear()
                for key, value in shared_state['latest_values'].items():
                    ui.label(f"{key}: {value}")

        ui.timer(1.0, update_live_values)

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
            shared_state['sensor_ranges'][channel_id] = (1, 100)
        elif info['type'] == 'control':
            controls[channel_id] = 0

lavin = broker_config['brokers']['lavinmq']

# Extract queue names
tlm_queue = next(q['name'] for ex in lavin['exchanges'] if ex['name'] == 'TLM' for q in ex['queues'] if q['name'] == 'strand-burner-auto-tlm')
cmd_queue = next(q['name'] for ex in lavin['exchanges'] if ex['name'] == 'CMD_BC' for q in ex['queues'] if q['name'] == 'strand-burner-auto-cmd')

def timestamp_ms():
    return int(time.time() * 1000)

# Telemetry simulator
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

# Command consumer
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

# Main async function
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
            ui.run_async(host='0.0.0.0', port=8520),
            publish_telemetry(channel),
            consume_commands(channel)
        )

if __name__ == "__main__":
    asyncio.run(main())