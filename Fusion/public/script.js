document.addEventListener("DOMContentLoaded", async () => {
    const container = document.getElementById("component-container");
    const simToggle = document.getElementById("sim-toggle");
    const simLabel = document.getElementById("sim-label");
    const simIntervalControls = document.getElementById("sim-interval-controls");
    const simIntervalInput = document.getElementById("sim-interval");
    const simIntervalValue = document.getElementById("sim-interval-value");

    const response = await fetch("/api/components");
    const components = await response.json();

    const valueDisplays = {};
    const componentToggles = {};
    const isSimulating = {};
    const latestValues = {};

    simLabel.textContent = "No-Sim";
    simIntervalControls.style.display = "none"; // hidden by default

    simToggle.addEventListener("change", () => {
        const enabled = simToggle.checked;
        simLabel.textContent = enabled ? "Sim" : "No-Sim";
        simIntervalControls.style.display = enabled ? "block" : "none";
        renderUI();

        fetch("/api/toggle-sim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        }).catch((err) => {
            console.error("Error sending Sim toggle request:", err);
        });
    });

    simIntervalInput.addEventListener("input", () => {
        const interval = parseInt(simIntervalInput.value, 10);
        simIntervalValue.textContent = `${interval} ms`;
    });

    simIntervalInput.addEventListener("change", () => {
        const interval = parseInt(simIntervalInput.value, 10);
        if (interval >= 25 && interval <= 10000) {
            fetch("/api/set-interval", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ interval }),
            }).catch((err) => {
                console.error("Error updating simulation interval:", err);
            });
        }
    });

    function renderUI() {
        container.innerHTML = "";

        components.forEach((component) => {
            const card = document.createElement("div");
            card.className = "component-card neutral";
            card.dataset.id = component.id;

            const title = document.createElement("div");
            title.className = "component-title";
            title.textContent = component.id;
            card.appendChild(title);

            const valueDiv = document.createElement("div");
            valueDiv.className = "value-display";
            valueDiv.textContent = "Last Value: —";
            card.appendChild(valueDiv);
            valueDisplays[component.id] = valueDiv;

            // Only show toggle if Sim mode is active
            if (simToggle.checked) {
                const toggleLabel = createToggleSwitch(component.id);
                card.appendChild(toggleLabel);
            }

            // --- Sensor Handling (float sensors) ---
            if (component.type === "sensor" && simToggle.checked) {
                const minInput = document.createElement("input");
                const maxInput = document.createElement("input");
                const setBtn = document.createElement("button");

                minInput.type = "number";
                maxInput.type = "number";
                minInput.placeholder = "Min";
                maxInput.placeholder = "Max";
                minInput.className = "range-input";
                maxInput.className = "range-input";
                setBtn.textContent = "Set";

                setBtn.addEventListener("click", () => {
                    const toggle = componentToggles[component.id];
                    if (!toggle || !toggle.checked) return;

                    const min = parseFloat(minInput.value);
                    const max = parseFloat(maxInput.value);
                    if (isNaN(min) || isNaN(max) || min > max) return;

                    fetch("/api/simulate", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: component.id, min, max }),
                    }).catch((err) => console.error(err));

                    isSimulating[component.id] = true;
                    card.classList.add("simulating");
                });

                card.appendChild(minInput);
                card.appendChild(maxInput);
                card.appendChild(setBtn);
            }

            // --- Control Handling ---
            if (component.type === "control") {
                // --- Bool Control ---
                if (component.data_type === "bool") {
                    const openBtn = document.createElement("button");
                    const closeBtn = document.createElement("button");
                    openBtn.textContent = "Open (0)";
                    closeBtn.textContent = "Close (1)";

                    const updateStatusColor = (state) => {
                        card.classList.remove("neutral", "status-on", "status-off");
                        card.classList.add(state === 1 ? "status-off" : "status-on"); // 1 = closed = yellow, 0 = open = green
                    };

                    openBtn.addEventListener("click", () => {
                        const endpoint = simToggle.checked
                            ? "/api/simulate"
                            : "/api/no-sim";
                        const toggle = componentToggles[component.id];
                        if (toggle && !toggle.checked) return;

                        fetch(endpoint, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: component.id, value: 0 }),
                        }).catch((err) => console.error(err));

                        updateStatusColor(0);
                    });

                    closeBtn.addEventListener("click", () => {
                        const endpoint = simToggle.checked
                            ? "/api/simulate"
                            : "/api/no-sim";
                        const toggle = componentToggles[component.id];
                        if (toggle && !toggle.checked) return;

                        fetch(endpoint, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: component.id, value: 1 }),
                        }).catch((err) => console.error(err));

                        updateStatusColor(1);
                    });

                    card.appendChild(openBtn);
                    card.appendChild(closeBtn);
                }

                // --- Float Control ---
                if (component.data_type === "float") {
                    const inputWrapper = document.createElement("div");
                    inputWrapper.style.display = "flex";
                    inputWrapper.style.alignItems = "center";
                    inputWrapper.style.gap = "0.5rem";
                    inputWrapper.style.marginTop = "0.5rem";

                    const valueInput = document.createElement("input");
                    valueInput.type = "number";
                    valueInput.placeholder = "Value";
                    valueInput.className = "range-input";

                    const unitLabel = document.createElement("span");
                    unitLabel.textContent = component.unit || "";
                    unitLabel.style.color = "#aaa";
                    unitLabel.style.fontSize = "0.9rem";

                    inputWrapper.appendChild(valueInput);
                    inputWrapper.appendChild(unitLabel);
                    card.appendChild(inputWrapper);

                    const setBtn = document.createElement("button");
                    setBtn.textContent = "Set";

                    setBtn.addEventListener("click", () => {
                        const value = parseFloat(valueInput.value);
                        if (isNaN(value)) return;

                        const endpoint = simToggle.checked
                            ? "/api/simulate"
                            : "/api/no-sim";
                        const toggle = componentToggles[component.id];
                        if (toggle && !toggle.checked) return;

                        fetch(endpoint, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: component.id, value }), // ✅ Only sending id and value for float controls
                        }).catch((err) => console.error(err));
                    });

                    card.appendChild(setBtn);
                }
            }

            container.appendChild(card);
        });
    }

    function createToggleSwitch(id) {
        const toggleLabel = document.createElement("div");
        toggleLabel.style.display = "flex";
        toggleLabel.style.alignItems = "center";
        toggleLabel.style.gap = "0.5rem";
        toggleLabel.style.margin = "0.5rem 0";

        const labelText = document.createElement("span");
        labelText.textContent = "Simulate:";
        labelText.style.fontSize = "0.9rem";

        const switchContainer = document.createElement("label");
        switchContainer.className = "switch small";

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        componentToggles[id] = toggle;

        const slider = document.createElement("span");
        slider.className = "slider";

        switchContainer.appendChild(toggle);
        switchContainer.appendChild(slider);

        toggleLabel.appendChild(labelText);
        toggleLabel.appendChild(switchContainer);

        toggle.addEventListener("change", () => {
            if (!toggle.checked) {
                // If unchecked, stop simulation
                fetch("/api/simulate/stop", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id }),
                }).catch((err) => console.error(err));
            }
        });

        return toggleLabel;
    }

    renderUI();

    const eventSource = new EventSource("/events");
    eventSource.onmessage = (event) => {
        const message = JSON.parse(event.data);

        if (message.type === "map") {
            console.log("[EVENT] Map received:", message.payload);
            return;
        }

        if (message.type === "telemetry") {
            const telemetry = message.payload;
            const id = Object.keys(telemetry.Data)[0];
            const value = telemetry.Data[id];

            if (id === undefined || value === null || value === undefined) {
                console.warn(
                    `[TELEMETRY] Ignoring invalid telemetry: ${JSON.stringify(telemetry)}`
                );
                return;
            }

            latestValues[id] = value;

            if (valueDisplays[id]) {
                valueDisplays[id].textContent = `Last Value: ${value}`;
            }

            const card = document.querySelector(`[data-id="${id}"]`);
            if (!card) return;

            const component = components.find((c) => c.id === id);
            if (!component) {
                console.warn(`[TELEMETRY] No component config found for ID: ${id}`);
                return;
            }

            // Only update border colors for boolean controls
            if (component.type === "control" && component.data_type === "bool") {
                card.classList.remove("neutral", "status-on", "status-off");

                if (value === 0) {
                    card.classList.add("status-on"); // open = green
                } else if (value === 1) {
                    card.classList.add("status-off"); // closed = yellow
                } else {
                    card.classList.add("neutral"); // fallback
                }
            } else if (
                component.type === "control" &&
                component.data_type === "float"
            ) {
                // Float sensor or float control simulation: random between min and max
                if (min === undefined || max === undefined) {
                    return res
                        .status(400)
                        .send("Missing min/max values for float simulation");
                }

                simIntervals[id] = setInterval(() => {
                    const randomValue = parseFloat(
                        (Math.random() * (max - min) + min).toFixed(2)
                    );
                    const packet = {
                        Source: "Fusion",
                        "Time Stamp": Math.floor(Date.now() / 1000),
                        Data: { [id]: randomValue },
                    };
                    broadcastPacket("telemetry", packet);
                }, simulationIntervalMs);

                console.log(
                    `[SIMULATE] Started simulating float ${id} between ${min}-${max} every ${simulationIntervalMs}ms.`
                );
            }
            // Otherwise (sensors or non-bool controls), do nothing to border color
            // Just leave "simulating" class if it exists
        }
    };
});
