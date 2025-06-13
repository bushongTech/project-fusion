document.getElementById('automation-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const watch = document.getElementById('watch').value.trim();
  const threshold = parseFloat(document.getElementById('threshold').value);
  const doChannel = document.getElementById('do').value.trim();
  const doValue = parseFloat(document.getElementById('doValue').value);

  const payload = { watch, threshold, do: doChannel, do_value: doValue };

  try {
    await fetch('/api/automation/bang-bang', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    document.getElementById('automation-form').reset();
    await loadAutomationRules();
  } catch (err) {
    console.error('Failed to add rule:', err);
  }
});

async function loadAutomationRules() {
  try {
    const response = await fetch('/api/automation/bang-bang');
    const rules = await response.json();
    const list = document.getElementById('automation-list');
    list.innerHTML = '';

    for (const key in rules) {
      const rule = rules[key];
      const li = document.createElement('li');
      li.textContent = `${rule.watch} ≥ ${rule.threshold} → ${rule.do} = ${rule.do_value}`;

      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove';
      removeBtn.onclick = async () => {
        await fetch('/api/automation/bang-bang', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ watch: rule.watch, do: rule.do })
        });
        await loadAutomationRules();
      };

      li.appendChild(removeBtn);
      list.appendChild(li);
    }
  } catch (err) {
    console.error('Failed to load automation rules:', err);
  }
}

window.onload = loadAutomationRules;