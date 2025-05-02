document.addEventListener('DOMContentLoaded', async () => {
    const buttonsContainer = document.getElementById('service-buttons');
    const iframe = document.getElementById('iframe');
    const iframeTitle = document.getElementById('iframe-title');
  
  
    // 2. Load microservices
    try {
      const res = await fetch('/api/microservices');
      const services = await res.json();
  
      if (services.length === 0) {
        buttonsContainer.innerHTML = "<p>No microservices with UIs found.</p>";
        return;
      }
  
      services.forEach(({ title, port }) => {
        const button = document.createElement('button');
        button.textContent = title;
        button.addEventListener('click', () => {
          iframe.src = `http://localhost:${port}`;
          iframeTitle.textContent = title;
        });
        buttonsContainer.appendChild(button);
      });
    } catch (error) {
      console.error('Error fetching services:', error);
      buttonsContainer.innerHTML = "<p>Error loading microservices.</p>";
    }
  });