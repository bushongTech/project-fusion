document.addEventListener("DOMContentLoaded", async () => {
    const container = document.getElementById("component-container");
    const simToggle = document.getElementById("sim-toggle");
    const simLabel = document.getElementById("sim-label");
    const simIntervalControls = document.getElementById("sim-interval-controls");
    const simIntervalInput = document.getElementById("sim-interval");
    const simIntervalValue = document.getElementById("sim-interval-value");

    // Fetch components
    const response = await fetch("/api/components");
    const components = await response.json();

    // Stop all previous simulations on load
    await fetch("/api/simulate/stop-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
    }).catch((err) => console.error("Error stopping all simulations on page load:", err));

    const valueDisplays = {};
    const componentToggles = {};
    const isSimulating = {};
    const latestValues = {};

    simLabel.textContent = "No-Sim";
    simIntervalControls.style.display = "none"; // Hidden by default

    simToggle.addEventListener("change", async () => {
        const enabled = simToggle.checked;
        simLabel.textContent = enabled ? "Sim" : "No-Sim";
        simIntervalControls.style.display = enabled ? "block" : "none";
        renderUI();

        await fetch("/api/toggle-sim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        }).catch((err) => console.error("Error sending Sim toggle request:", err));

        if (!enabled) {
            // Remove glowing classes if Sim OFF
            document.querySelectorAll(".component-card.simulating").forEach((card) => {
                card.classList.remove("simulating");
            });
            Object.keys(isSimulating).forEach((id) => {
                isSimulating[id] = false;
            });
        }
    });

    simIntervalInput.addEventListener("input", () => {
        const interval = parseInt(simIntervalInput.value, 10);
        simIntervalValue.textContent = `${interval} ms`;
    });

    simIntervalInput.addEventListener("change", async () => {
        const interval = parseInt(simIntervalInput.value, 10);
        if (interval >= 25 && interval <= 10000) {
            await fetch("/api/set-interval", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ interval }),
            }).catch((err) => console.error("Error updating simulation interval:", err));
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

            if (simToggle.checked) {
                const toggleLabel = createToggleSwitch(component.id);
                card.appendChild(toggleLabel);
            }

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

                setBtn.addEventListener("click", async () => {
                    const toggle = componentToggles[component.id];
                    if (!toggle || !toggle.checked) return;

                    const min = parseFloat(minInput.value);
                    const max = parseFloat(maxInput.value);
                    if (isNaN(min) || isNaN(max) || min > max) return;

                    // Always stop old sim first
                    await fetch("/api/simulate/stop", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: component.id }),
                    }).catch((err) => console.error(err));

                    // Start new sim
                    await fetch("/api/simulate", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            id: component.id,
                            min: min,
                            max: max
                        }),
                    }).catch((err) => console.error(err));

                    isSimulating[component.id] = true;
                    card.classList.add("simulating");
                });

                card.appendChild(minInput);
                card.appendChild(maxInput);
                card.appendChild(setBtn);
            }

            if (component.type === "control") {
                if (component.data_type === "bool") {
                    const openBtn = document.createElement("button");
                    const closeBtn = document.createElement("button");
                    openBtn.textContent = "Open (0)";
                    closeBtn.textContent = "Close (1)";

                    const updateStatusColor = (state) => {
                        card.classList.remove("neutral", "status-on", "status-off");
                        card.classList.add(state === 1 ? "status-off" : "status-on");
                    };

                    openBtn.addEventListener("click", async () => {
                        const endpoint = simToggle.checked ? "/api/simulate" : "/api/no-sim";
                        const toggle = componentToggles[component.id];
                        if (toggle && !toggle.checked) return;

                        await fetch(endpoint, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: component.id, value: 0 }),
                        }).catch((err) => console.error(err));

                        updateStatusColor(0);
                    });

                    closeBtn.addEventListener("click", async () => {
                        const endpoint = simToggle.checked ? "/api/simulate" : "/api/no-sim";
                        const toggle = componentToggles[component.id];
                        if (toggle && !toggle.checked) return;

                        await fetch(endpoint, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: component.id, value: 1 }),
                        }).catch((err) => console.error(err));

                        updateStatusColor(1);
                    });

                    card.appendChild(openBtn);
                    card.appendChild(closeBtn);
                }

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

                    setBtn.addEventListener("click", async () => {
                        const value = parseFloat(valueInput.value);
                        if (isNaN(value)) return;

                        const toggle = componentToggles[component.id];
                        if (toggle && !toggle.checked) return;

                        // Always stop old sim first
                        await fetch("/api/simulate/stop", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: component.id }),
                        }).catch((err) => console.error(err));

                        await fetch("/api/simulate", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                id: component.id,
                                value: value
                            }),
                        }).catch((err) => console.error(err));

                        isSimulating[component.id] = true;
                        card.classList.add("simulating");
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

        toggle.addEventListener("change", async () => {
            if (!toggle.checked) {
                await fetch("/api/simulate/stop", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id }),
                }).catch((err) => console.error("Error stopping simulation:", err));

                const card = document.querySelector(`[data-id="${id}"]`);
                if (card) {
                    card.classList.remove("simulating");
                }
                isSimulating[id] = false;
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

            for (const [id, value] of Object.entries(telemetry.Data)) {
                if (id === undefined || value === null || value === undefined) {
                    console.warn(`[TELEMETRY] Ignoring invalid telemetry for ID: ${id}`);
                    continue;
                }

                latestValues[id] = value;

                if (valueDisplays[id]) {
                    valueDisplays[id].textContent = `Last Value: ${value}`;
                }

                const card = document.querySelector(`[data-id="${id}"]`);
                if (!card) continue;

                const component = components.find((c) => c.id === id);
                if (!component) continue;

                if (component.type === "control" && component.data_type === "bool") {
                    card.classList.remove("neutral", "status-on", "status-off");
                    if (value === 0) {
                        card.classList.add("status-on");
                    } else if (value === 1) {
                        card.classList.add("status-off");
                    } else {
                        card.classList.add("neutral");
                    }
                }
            }
        }
    };
});