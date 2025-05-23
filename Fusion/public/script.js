document.addEventListener("DOMContentLoaded", async () => {
  const container = document.getElementById("component-container");

  const response = await fetch("/api/components");
  const components = await response.json();

  const valueDisplays = {};
  const commandDisplays = {};
  const latestValues = {};
  const pendingCommands = {};
  const simulationIntervals = {}; // { id: intervalID }

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

      // --- Simulate Toggle ---
      const simWrapper = document.createElement("div");
      simWrapper.className = "simulate-wrapper";
      simWrapper.style.marginTop = "0.75rem";

      const simToggle = document.createElement("input");
      simToggle.type = "checkbox";
      simToggle.id = `sim-toggle-${component.id}`;

      const simLabel = document.createElement("label");
      simLabel.textContent = "Simulate";
      simLabel.htmlFor = simToggle.id;
      simLabel.style.marginLeft = "0.5rem";

      simWrapper.appendChild(simToggle);
      simWrapper.appendChild(simLabel);
      card.appendChild(simWrapper);

      // --- Interval Slider ---
      const intervalWrapper = document.createElement("div");
      intervalWrapper.style.display = "none"; // hidden initially
      intervalWrapper.style.marginTop = "0.5rem";
      intervalWrapper.style.display = "flex";
      intervalWrapper.style.alignItems = "center";
      intervalWrapper.style.gap = "0.5rem";

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = 1;
      slider.max = 100;
      slider.value = 1;

      const sliderLabel = document.createElement("span");
      sliderLabel.textContent = `1 Hz`;

      slider.addEventListener("input", () => {
        sliderLabel.textContent = `${slider.value} Hz`;
      });

      intervalWrapper.appendChild(slider);
      intervalWrapper.appendChild(sliderLabel);
      card.appendChild(intervalWrapper);

      // Toggle logic
      simToggle.addEventListener("change", () => {
        const id = component.id;

        if (simToggle.checked) {
          intervalWrapper.style.display = "flex";

          const intervalMs = 1000 / parseFloat(slider.value);
          simulationIntervals[id] = setInterval(() => {
            const simulatedValue =
              component.data_type === "bool"
                ? Math.round(Math.random())
                : parseFloat((Math.random() * 100).toFixed(2));

            sendCommand(id, simulatedValue);
          }, intervalMs);
        } else {
          intervalWrapper.style.display = "none";

          if (simulationIntervals[id]) {
            clearInterval(simulationIntervals[id]);
            delete simulationIntervals[id];
          }
        }
      });

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