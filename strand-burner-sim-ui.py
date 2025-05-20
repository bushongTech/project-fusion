from nicegui import ui

shared_state = {
    'sim_rate_hz': 1,
    'sensor_ranges': {},
    'latest_values': {}
}

def setup_ui():
    ui.label('Strand Burner Simulator').classes('text-2xl font-bold mb-4')

    # SIM RATE
    with ui.card().classes('mb-4'):
        ui.label('Simulation Rate (Hz)')
        sim_rate_slider = ui.slider(min=1, max=100, value=shared_state['sim_rate_hz'], step=1)
        sim_rate_slider.on_change(lambda e: shared_state.update({'sim_rate_hz': e.value}))
        ui.label().bind_text_from(sim_rate_slider, 'value', lambda v: f'{v} Hz')

    # SENSOR RANGES
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

    # LIVE VALUES
    with ui.card().classes('mb-4'):
        ui.label('Live Telemetry').classes('text-bold')
        value_grid = ui.column()

        def update_live_values():
            value_grid.clear()
            for key, value in shared_state['latest_values'].items():
                value_grid.add(ui.label(f"{key}: {value}"))

        ui.timer(1.0, update_live_values)

    ui.run(title='Strand Burner Sim UI', host='0.0.0.0', port=8520, dark=True)