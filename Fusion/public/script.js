document.addEventListener("DOMContentLoaded", async () => {
    const container = document.getElementById("component-container");

    const response = await fetch("/api/components");
    const components = await response.json();

    const valueDisplays = {};
    const commandDisplays = {};
    const latestValues = {};
    const pendingCommands = {}; // { id: value }

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

            let commandDiv;
            if (component.type === "control") {
                commandDiv = document.createElement("div");
                commandDiv.className = "command-display";
                commandDiv.textContent = "Last Fusion Command: —";
                card.appendChild(commandDiv);
                commandDisplays[component.id] = commandDiv;
            }

            if (component.type === "control") {
                if (component.data_type === "bool") {
                    const openBtn = document.createElement("button");
                    const closeBtn = document.createElement("button");
                    openBtn.textContent = "Open (0)";
                    closeBtn.textContent = "Close (1)";

                    openBtn.addEventListener("click", async () => {
                        await sendCommand(component.id, 0);
                    });

                    closeBtn.addEventListener("click", async () => {
                        await sendCommand(component.id, 1);
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
                        await sendCommand(component.id, value);
                    });

                    card.appendChild(setBtn);
                }
            }

            container.appendChild(card);
        });
    }

    async function sendCommand(id, value) {
        try {
            await fetch("/api/command", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, value }),
            });

            // Track the pending command and highlight yellow
            pendingCommands[id] = value;

            const card = document.querySelector(`[data-id="${id}"]`);
            if (card) {
                card.classList.remove("matched");
                card.classList.add("pending");
            }

            if (commandDisplays[id]) {
                commandDisplays[id].textContent = `Last Fusion Command: ${value}`;
            }
        } catch (err) {
            console.error("[FUSION] Failed to send command:", err);
        }
    }

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

                if (component.type === "control") {
                    const pendingValue = pendingCommands[id];

                    if (pendingValue !== undefined && value === pendingValue) {
                        card.classList.remove("pending");
                        card.classList.add("matched");
                        delete pendingCommands[id];
                    }
                }

                if (component.type === "control" && component.data_type === "bool") {
                    card.classList.remove("status-on", "status-off");
                    if (value === 0) card.classList.add("status-on");
                    else if (value === 1) card.classList.add("status-off");
                }
            }
        }
    };

    renderUI();
});