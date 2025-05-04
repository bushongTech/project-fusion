const container = document.querySelector(".container");

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const username = e.target.username.value;
  const password = e.target.password.value;

  const res = await fetch("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  const containerClasses = ["success", "error"];
  container.classList.remove(...containerClasses);

  const responseDiv = document.getElementById("response");

  if (res.ok) {
    const data = await res.json();
    responseDiv.textContent = data.message;
    container.classList.add("success");

    // Send login info to parent frame
    window.parent.postMessage({
      type: "LOGIN_SUCCESS",
      username: data.username,
      admin_status: data.admin_status
    }, "*"); // Replace * with specific origin if known
  } else {
    const errorText = await res.text();
    responseDiv.textContent = errorText;
    container.classList.add("error");
  }
});
