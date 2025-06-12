async function sendCommand(id, value) {
  try {
    const response = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, value })
    });

    const result = await response.json();
    document.getElementById('status').innerText =
      `Sent → ${result.id}: ${result.value}`;
  } catch (err) {
    document.getElementById('status').innerText =
      `Error sending command: ${err.message}`;
  }
}