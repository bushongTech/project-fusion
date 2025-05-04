import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";
const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 8501;

// Middleware
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  host: "local-db",         
  port: 5432,              
  user: "postgres",
  password: "postgres",
  database: "demo"
});

// Login endpoint
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE username = $1 AND password = $2",
      [username, password]
    );

    if (result.rows.length > 0) {
      const { admin_status } = result.rows[0];
      console.log(`User "${username}" logged in. Admin status: ${admin_status}`);

      res.status(200).json({
        message: "Login successful",
        username,
        admin_status
      });
    } else {
      console.log(`Invalid login attempt for "${username}"`);
      res.status(401).send("Invalid credentials");
    }
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Login failed");
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Login service running on port ${PORT}`);
});
