document.addEventListener('DOMContentLoaded', async () => {
    const buttonsContainer = document.getElementById('service-buttons');
    const iframe = document.getElementById('iframe');
    const iframeTitle = document.getElementById('iframe-title');
  
    window.addEventListener("message", (event) => {

      const data = event.data;
      if (data?.type === "LOGIN_SUCCESS") {
        const { username, admin_status } = data;
    
        console.log("User logged in:", username, "Admin:", admin_status);
    
        // Optional: persist in session storage
        sessionStorage.setItem("user", JSON.stringify({ username, admin_status }));
      }
    });

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