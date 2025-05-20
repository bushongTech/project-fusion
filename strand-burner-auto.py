import asyncio
import aio_pika
import yaml
import json
import random
import time
from nicegui import ui

# Shared state between the backend (simulator) and the UI.
# This acts like a shared memory area for both sides to interact.
shared_state = {
    'sim_rate_hz': 1,               # Default simulator frequency (1Hz = 1 message per second)
    'sensor_ranges': {},            # For each sensor, we'll store (min, max)
    'latest_values': {},            # The last known values for sensors + controls
    'ui_refresh_interval': 0.1      # UI will refresh at 10Hz by default (100ms)
}

# This function builds and launches the entire UI
def setup_ui():
    ui.label('Strand Burner Simulator').classes('text-2xl font-bold mb-4')

    # --- Section: Set how fast the simulator generates telemetry ---
    with ui.card().classes('mb-4'):
        ui.label('Simulation Rate (Hz)')
        sim_rate_slider = ui.slider(min=1, max=100, value=shared_state['sim_rate_hz'], step=1)
        sim_rate_slider.on_change(lambda e: shared_state.update({'sim_rate_hz': e.value}))
        ui.label().bind_text_from(sim_rate_slider, 'value', lambda v: f'{v} Hz')

    # --- Section: Choose how fast the UI updates its display ---
    with ui.card().classes('mb-4'):
        ui.label('UI Refresh Rate (Hz)')
        refresh_selector = ui.select(
            options=[('1 Hz', 1.0), ('5 Hz', 0.2), ('10 Hz', 0.1)],
            value=0.1  # Default is 10Hz
        ).classes('w-32')
        ui.label().bind_text_from(refresh_selector, 'value', lambda v: f"{1/float(v):.0f} Hz")
        refresh_selector.on_change(lambda e: shared_state.update({'ui_refresh_interval': float(e.value)}))

    # --- Section: Manually set sensor value ranges for the sim to use ---
    with ui.card().classes('mb-4'):
        ui.label('Sensor Ranges')
        range_container = ui.column().classes('gap-2')

        def update_sensor_controls():
            range_container.clear()
            for sensor_id, (min_val, max_val) in shared_state['sensor_ranges'].items():
                with range_container:
                    ui.label(sensor_id).classes('text-bold')
                    ui.number(label='Min', value=min_val,
                              on_change=lambda e, sid=sensor_id: update_range(sid, e.value, None))
                    ui.number(label='Max', value=max_val,
                              on_change=lambda e, sid=sensor_id: update_range(sid, None, e.value))

        def update_range(sensor_id, new_min, new_max):
            # This function updates the min/max range for a sensor when the user changes them in the UI
            cur_min, cur_max = shared_state['sensor_ranges'].get(sensor_id, (1, 100))
            shared_state['sensor_ranges'][sensor_id] = (
                new_min if new_min is not None else cur_min,
                new_max if new_max is not None else cur_max
            )

        update_sensor_controls()

    # --- Section: Display live telemetry values ---
    with ui.card().classes('mb-4'):
        ui.label('Live Telemetry').classes('text-bold')

        # Subsection: Sensors
        ui.label('Sensors').classes('text-sm text-gray-500')
        with ui.column() as sensor_grid:

            def update_sensor_values():
                sensor_grid.clear()
                for key in sensors:
                    value = shared_state['latest_values'].get(key, '—')
                    sensor_grid.add(ui.label(f"{key}: {value}"))

        # Subsection: Controls
        ui.label('Controls').classes('text-sm text-gray-500 mt-2')
        with ui.column() as control_grid:

            def update_control_values():
                control_grid.clear()
                for key in controls:
                    value = shared_state['latest_values'].get(key, '—')
                    control_grid.add(ui.label(f"{key}: {value}"))

        # This function calls both updates on a timer — the timer reschedules itself using the current UI refresh rate
        def dynamic_timer():
            update_sensor_values()
            update_control_values()
            ui.timer(shared_state.get('ui_refresh_interval', 0.1), dynamic_timer, once=True)

        dynamic_timer()

# Load configuration for brokers and sim structure
with open('/config/message_broker_config.yaml', 'r') as f:
    broker_config = yaml.safe_load(f)

with open('/config/config.yaml', 'r') as f:
    sim_config = yaml.safe_load(f)

# Parse the config and populate sensor/control lists
sensors = {}
controls = {}

for group in sim_config.values():
    for channel_id, info in group.get('channels', {}).items():
        if info['type'] == 'sensor':
            sensors[channel_id] = random.randint(1, 100)
            shared_state['sensor_ranges'][channel_id] = (1, 100)
        elif info['type'] == 'control':
            controls[channel_id] = 0

# Grab broker credentials and info from config
lavin = broker_config['brokers']['lavinmq']

# Look up the right queue names for TLM and CMD_BC
tlm_queue = next(q['name'] for ex in lavin['exchanges'] if ex['name'] == 'TLM'
                 for q in ex['queues'] if q['name'] == 'strand-burner-auto-tlm')

cmd_queue = next(q['name'] for ex in lavin['exchanges'] if ex['name'] == 'CMD_BC'
                 for q in ex['queues'] if q['name'] == 'strand-burner-auto-cmd')

# Helper: current time in ms
def timestamp_ms():
    return int(time.time() * 1000)

# Simulates telemetry packets and sends to LavinMQ every X ms
async def publish_telemetry(channel):
    exchange = await channel.declare_exchange("TLM", aio_pika.ExchangeType.FANOUT, durable=True)

    while True:
        rate = shared_state.get('sim_rate_hz', 1)
        interval = 1.0 / max(rate, 1)

        # Generate values within the user-defined range
        data = {}
        for sensor_id in sensors:
            min_val, max_val = shared_state['sensor_ranges'].get(sensor_id, (1, 100))
            data[sensor_id] = random.randint(min_val, max_val)

        # Add current control states to the packet
        data.update(controls)

        # Update shared state for the UI
        shared_state['latest_values'] = data.copy()

        # Format the outgoing packet
        packet = {
            "Source": "strand-burner-auto-tlm",
            "Time Stamp": timestamp_ms(),
            "Data": data
        }

        await exchange.publish(aio_pika.Message(body=json.dumps(packet).encode()), routing_key="")
        await asyncio.sleep(interval)

# Listens to the CMD_BC queue and applies incoming command values to controls
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

# The main function that launches everything: UI, telemetry, and command listener
async def main():
    setup_ui()  # Build and render the GUI layout

    # Connect to LavinMQ
    connection = await aio_pika.connect_robust(
        host=lavin['host'],
        port=lavin['port'],
        login=lavin['username'],
        password=lavin['password'],
        virtualhost=lavin['virtual_host'],
    )

    async with connection:
        channel = await connection.channel()

        # Start all tasks in parallel: NiceGUI server, telemetry simulator, and command listener
        await asyncio.gather(
            ui.run_async(host='0.0.0.0', port=8520),
            publish_telemetry(channel),
            consume_commands(channel)
        )

# Entry point for the whole app
if __name__ == "__main__":
    asyncio.run(main())