document.addEventListener("DOMContentLoaded", async () => {
    const container = document.getElementById("component-container");
    const response = await fetch("/api/components");
    const components = await response.json();

    const simToggle = document.getElementById("sim-toggle");
    const simLabel = document.getElementById("sim-label");
    const intervalAdjuster = document.getElementById("interval-adjuster");
    const intervalInput = document.getElementById("interval-input");

    const valueDisplays = {};
    const componentToggles = {};
    const isSimulating = {};
    const latestValues = {};

    simLabel.textContent = "No-Sim";

    simToggle.addEventListener("change", () => {
        const enabled = simToggle.checked;
        simLabel.textContent = enabled ? "Sim" : "No-Sim";
        intervalAdjuster.style.display = enabled ? "block" : "none";
        renderUI();

        fetch("/api/toggle-sim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        })
            .then((res) => {
                if (!res.ok) {
                    console.error("Failed to toggle Sim mode on server.");
                }
            })
            .catch((err) => {
                console.error("Error sending Sim toggle request:", err);
            });
    });

    function renderUI() {
        container.innerHTML = "";

        components.forEach((component) => {
            const card = document.createElement("div");
            card.className = "component-card";
            card.classList.add("neutral");
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

            if (component.type === "sensor" && simToggle.checked) {
                const toggleLabel = createToggleSwitch(component.id);
                card.appendChild(toggleLabel);

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
                    if (!toggle.checked) return;

                    const min = parseFloat(minInput.value);
                    const max = parseFloat(maxInput.value);
                    if (isNaN(min) || isNaN(max) || min > max) return;

                    fetch("/api/simulate", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            id: component.id,
                            min,
                            max,
                            interval: parseInt(intervalInput.value, 10),
                        }),
                    });

                    isSimulating[component.id] = true;
                    card.classList.add("simulating");
                });

                card.appendChild(minInput);
                card.appendChild(maxInput);
                card.appendChild(setBtn);
            }

            if (component.type === "control") {
                if (simToggle.checked) {
                    const toggleLabel = createToggleSwitch(component.id);
                    card.appendChild(toggleLabel);
                }

                if (component.data_type === "bool") {
                    const openBtn = document.createElement("button");
                    const closeBtn = document.createElement("button");
                    openBtn.textContent = "Open";
                    closeBtn.textContent = "Close";

                    const updateStatusColor = (state) => {
                        card.classList.remove("neutral", "status-open", "status-closed");
                        card.classList.add(state === 0 ? "status-open" : "status-closed");
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
                        });
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
                        });
                        updateStatusColor(1);
                    });

                    updateStatusColor(0);
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
                            body: JSON.stringify({ id: component.id, value }),
                        });
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

        return toggleLabel;
    }

    renderUI();

    const eventSource = new EventSource("/events");
    eventSource.onmessage = (event) => {
        const { id, value } = JSON.parse(event.data);
        latestValues[id] = value;

        if (valueDisplays[id]) {
            valueDisplays[id].textContent = `Last Value: ${value}`;
        }

        const card = document.querySelector(`[data-id="${id}"]`);
        if (card && componentToggles[id]) {
            card.classList.remove("neutral", "status-open", "status-closed");
            card.classList.add(value === 0 ? "status-open" : "status-closed");
        }
    };
});
