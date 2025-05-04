CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(100) NOT NULL,
  admin_status BOOLEAN DEFAULT FALSE
);

-- Optional: add default users
INSERT INTO users (username, password, admin_status)
VALUES 
  ('ADC', 'admin', true),
  ('operator', 'operator', false)
ON CONFLICT (username) DO NOTHING;
