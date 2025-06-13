async function fetchAutomations() {
  const response = await fetch('/automations');
  const data = await response.json();
  const list = document.getElementById('automation-list');
  list.innerHTML = '';
  data.forEach(rule => {
    const li = document.createElement('li');
    li.textContent = JSON.stringify(rule);
    const btn = document.createElement('button');
    btn.textContent = 'Delete';
    btn.onclick = async () => {
      await fetch(`/automations?watch=${rule.watch}&do=${rule.do}`, { method: 'DELETE' });
      fetchAutomations();
    };
    li.appendChild(btn);
    list.appendChild(li);
  });
}

document.getElementById('automation-form').onsubmit = async (e) => {
  e.preventDefault();
  const type = document.getElementById('type').value;
  const watch = document.getElementById('watch').value;
  const doVal = document.getElementById('do').value;
  const doValue = document.getElementById('do_value').value;
  const threshold = document.getElementById('threshold').value;
  const min = document.getElementById('min').value;
  const max = document.getElementById('max').value;
  const delay = document.getElementById('delay').value;

  const rule = {
    type,
    watch,
    do: doVal,
    do_value: parseFloat(doValue),
  };

  if (type === "bang-bang" || type === "rising" || type === "falling")
    rule.threshold = parseFloat(threshold);

  if (type === "range") {
    rule.min = parseFloat(min);
    rule.max = parseFloat(max);
  }

  if (type === "delayed") {
    rule.threshold = parseFloat(threshold);
    rule.delay = parseFloat(delay);
  }

  await fetch('/automations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rule),
  });

  fetchAutomations();
};

document.getElementById("type").addEventListener("change", (e) => {
  const type = e.target.value;
  document.getElementById("threshold-group").style.display = ["bang-bang", "delayed", "rising", "falling"].includes(type) ? "block" : "none";
  document.getElementById("min-max-group").style.display = type === "range" ? "block" : "none";
  document.getElementById("delay-group").style.display = type === "delayed" ? "block" : "none";
});

fetchAutomations();