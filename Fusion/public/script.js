document.addEventListener("DOMContentLoaded", async () => {
  const container = document.getElementById("component-container");

  const response = await fetch("/api/components");
  const components = await response.json();

  const valueDisplays = {};
  const commandDisplays = {};
  const latestValues = {};
  const pendingCommands = {};
  const simulationIntervals = {};

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

      let simToggle; // Declare here for use in event handlers

      if (component.type === "control") {
        const commandDiv = document.createElement("div");
        commandDiv.className = "command-display";
        commandDiv.textContent = "Last Fusion Command: —";
        card.appendChild(commandDiv);
        commandDisplays[component.id] = commandDiv;

        // Simulate toggle
        const simWrapper = document.createElement("div");
        simWrapper.className = "simulate-wrapper";
        simToggle = document.createElement("input");
        simToggle.type = "checkbox";
        simToggle.id = `sim-toggle-${component.id}`;
        const simLabel = document.createElement("label");
        simLabel.textContent = "Simulate";
        simLabel.htmlFor = simToggle.id;
        simWrapper.append(simToggle, simLabel);
        card.appendChild(simWrapper);

        if (component.data_type === "bool") {
          const openBtn = document.createElement("button");
          openBtn.textContent = "Open (0)";
          openBtn.onclick = () => {
            const value = 0;
            simToggle.checked
              ? simulateSensor(component.id, value)
              : sendCommand(component.id, value);
          };

          const closeBtn = document.createElement("button");
          closeBtn.textContent = "Close (1)";
          closeBtn.onclick = () => {
            const value = 1;
            simToggle.checked
              ? simulateSensor(component.id, value)
              : sendCommand(component.id, value);
          };

          card.append(openBtn, closeBtn);
        }

        if (component.data_type === "float") {
          const input = document.createElement("input");
          input.type = "number";
          input.className = "range-input";

          const setBtn = document.createElement("button");
          setBtn.textContent = "Set";
          setBtn.onclick = () => {
            const val = parseFloat(input.value);
            if (isNaN(val)) return;
            simToggle.checked
              ? simulateSensor(component.id, val)
              : sendCommand(component.id, val);
          };

          card.append(input, setBtn);
        }
      }

      if (component.type === "sensor") {
        const simWrapper = document.createElement("div");
        simWrapper.className = "simulate-wrapper";

        const simToggle = document.createElement("input");
        simToggle.type = "checkbox";
        simToggle.id = `sim-toggle-${component.id}`;

        const simLabel = document.createElement("label");
        simLabel.textContent = "Simulate";
        simLabel.htmlFor = simToggle.id;

        simWrapper.append(simToggle, simLabel);
        card.appendChild(simWrapper);

        const simControls = document.createElement("div");
        simControls.style.display = "none";
        simControls.style.flexDirection = "column";
        simControls.style.alignItems = "center";
        simControls.style.marginTop = "0.5rem";

        const minInput = document.createElement("input");
        minInput.type = "number";
        minInput.placeholder = "Min";
        minInput.className = "range-input";

        const maxInput = document.createElement("input");
        maxInput.type = "number";
        maxInput.placeholder = "Max";
        maxInput.className = "range-input";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = 1;
        slider.max = 100;
        slider.value = 1;
        const sliderLabel = document.createElement("span");
        sliderLabel.textContent = "1 Hz";

        const submitBtn = document.createElement("button");
        submitBtn.textContent = "Start Simulation";

        simControls.append(minInput, maxInput, slider, sliderLabel, submitBtn);
        card.appendChild(simControls);

        simToggle.addEventListener("change", () => {
          const id = component.id;
          if (simToggle.checked) {
            simControls.style.display = "flex";
          } else {
            simControls.style.display = "none";
            if (simulationIntervals[id]) {
              clearInterval(simulationIntervals[id]);
              delete simulationIntervals[id];
            }
          }
        });

        slider.addEventListener("input", () => {
          sliderLabel.textContent = `${slider.value} Hz`;
        });

        submitBtn.addEventListener("click", () => {
          const id = component.id;
          const min = parseFloat(minInput.value);
          const max = parseFloat(maxInput.value);
          const intervalMs = 1000 / parseFloat(slider.value);

          if (isNaN(min) || isNaN(max) || min >= max) {
            alert("Enter valid min/max values");
            return;
          }

          if (simulationIntervals[id]) clearInterval(simulationIntervals[id]);

          simulationIntervals[id] = setInterval(() => {
            const simulatedValue = parseFloat((Math.random() * (max - min) + min).toFixed(2));
            simulateSensor(id, simulatedValue);
          }, intervalMs);
        });
      }

      container.appendChild(card);
    });
  }

  async function sendCommand(id, value) {
    console.log("[FUSION] Attempting to send command:", { id, value });

    try {
      const res = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, value }),
      });

      const resultText = await res.text();
      console.log("[FUSION] Response:", res.status, resultText);
    } catch (err) {
      console.error("[FUSION] Failed to send command:", err);
    }
  }

  async function simulateSensor(id, value) {
    console.log("[FUSION] Simulating:", { id, value });

    try {
      const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, value }),
      });

      const resultText = await res.text();
      console.log("[FUSION] Simulate Response:", res.status, resultText);
    } catch (err) {
      console.error("[FUSION] Failed to simulate:", err);
    }
  }

  const eventSource = new EventSource("/events");
  eventSource.onmessage = (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "map") return;

    if (message.type === "telemetry") {
      const telemetry = message.payload;
      for (const [id, value] of Object.entries(telemetry.Data)) {
        if (value == null) continue;

        latestValues[id] = value;
        if (valueDisplays[id]) {
          valueDisplays[id].textContent = `Last Value: ${value}`;
        }

        const card = document.querySelector(`[data-id="${id}"]`);
        if (!card) continue;

        const component = components.find((c) => c.id === id);
        if (!component) continue;

        if (component.type === "control") {
          if (pendingCommands[id] !== undefined && value === pendingCommands[id]) {
            card.classList.remove("pending");
            card.classList.add("matched");
            delete pendingCommands[id];
          }

          if (component.data_type === "bool") {
            card.classList.remove("status-on", "status-off");
            if (value === 0) card.classList.add("status-on");
            else if (value === 1) card.classList.add("status-off");
          }
        }
      }
    }
  };

  renderUI();
});
