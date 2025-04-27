import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import * as jsyaml from "js-yaml";
import amqplib from "amqplib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 8505;

const CONFIG_PATH = "/config/config.yaml";
const BROKER_CONFIG_PATH = "/config/message_broker_config.yaml";

let componentMap = {};
const clients = [];
const simIntervals = {}; // { id: intervalObject }
let simulationIntervalMs = 500; // Default simulation interval
let globalSimEnabled = false;

const lavinConfig = {
  protocol: "amqp",
  hostname: "lavinmq0",
  port: 5672,
  username: "guest",
  password: "guest",
  locale: "en_US",
  frameMax: 0,
  heartbeat: 0,
  vhost: "/",
};

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// --- Helper Functions --- //
function isValidJSON(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

async function createConnection(config) {
  const conn = await amqplib.connect(config);
  conn.on("error", (err) => console.error("[AMQP] Connection error:", err.message));
  conn.on("close", () => console.error("[AMQP] Connection closed"));
  return conn;
}

function broadcastPacket(type, payload) {
  const packet = { type, payload };
  clients.forEach((client) => client.write(`data: ${JSON.stringify(packet)}\n\n`));
}

// --- Load Configs --- //
function loadComponentConfig() {
  try {
    const contents = fs.readFileSync(CONFIG_PATH, "utf8");
    const config = jsyaml.load(contents);
    componentMap = {};
    Object.entries(config.channels || {}).forEach(([source, group]) => {
      Object.entries(group.channels || {}).forEach(([id, props]) => {
        componentMap[id] = { id, source, ...props };
      });
    });
    console.log(`[CONFIG] Loaded ${Object.keys(componentMap).length} components.`);
    broadcastPacket("map", componentMap);
  } catch (err) {
    console.error("[CONFIG] Failed to load config.yaml:", err);
  }
}

async function setupExchangesAndQueues() {
  const brokerConfig = jsyaml.load(fs.readFileSync(BROKER_CONFIG_PATH, "utf8"));
  const conn = await createConnection(lavinConfig);
  const channel = await conn.createChannel();

  if (brokerConfig?.brokers?.lavinmq?.exchanges) {
    for (const exchange of brokerConfig.brokers.lavinmq.exchanges) {
      console.log(`[LAVIN] Configuring exchange: ${exchange.name}`);
      await channel.assertExchange(exchange.name, "fanout", { durable: true });
      for (const queue of exchange.queues || []) {
        console.log(`[LAVIN] Binding queue: ${queue.name}`);
        await channel.assertQueue(queue.name, { durable: true });
        await channel.bindQueue(queue.name, exchange.name, "");
      }
    }
  }

  setTimeout(() => {
    channel.close();
    conn.close();
  }, 500);
}

// --- AMQP Consumers --- //
async function startConsumers() {
  const conn = await createConnection(lavinConfig);
  const channel = await conn.createChannel();
  await channel.assertQueue("fusion", { durable: true });

  channel.consume("fusion", (msg) => {
    if (!msg) return;
    const text = msg.content.toString();
    if (!isValidJSON(text)) return channel.ack(msg);

    const data = JSON.parse(text);

    if (data.Source === "Fusion") {
      console.log("[CMD] Received Fusion-originated command.");
    } else if (data.Data) {
      Object.entries(data.Data).forEach(([id, value]) => {
        if (componentMap[id]) {
          const packet = {
            Source: data.Source || "Unknown",
            "Time Stamp": data["Time Stamp"],
            Data: { [id]: value }
          };
          broadcastPacket("telemetry", packet);
        }
      });
    }

    channel.ack(msg);
  });

  console.log("[LAVIN] Started consumers.");
}

// --- Express API Routes --- //
app.get("/api/components", (req, res) => {
  res.json(Object.values(componentMap));
});

app.post("/api/simulate", (req, res) => {
  const { id, min, max } = req.body;
  if (!componentMap[id]) return res.status(400).send("Invalid component ID");

  if (simIntervals[id]) clearInterval(simIntervals[id]);

  simIntervals[id] = setInterval(() => {
    const value = parseFloat((Math.random() * (max - min) + min).toFixed(2));
    const packet = {
      Source: "Fusion",
      "Time Stamp": Math.floor(Date.now() / 1000),
      Data: { [id]: value }
    };
    broadcastPacket("telemetry", packet);
  }, simulationIntervalMs);

  console.log(`[SIMULATE] Started simulating ${id} every ${simulationIntervalMs}ms.`);
  res.sendStatus(200);
});

app.post("/api/simulate/stop", (req, res) => {
  const { id } = req.body;
  if (simIntervals[id]) {
    clearInterval(simIntervals[id]);
    delete simIntervals[id];
    console.log(`[SIMULATE] Stopped simulation for ${id}.`);
  }
  res.sendStatus(200);
});

app.post("/api/no-sim", (req, res) => {
  const { id, value } = req.body;
  if (!componentMap[id]) return res.status(400).send("Invalid component ID");

  const packet = {
    Source: "Fusion",
    "Time Stamp": Math.floor(Date.now() / 1000),
    Data: { [id]: value }
  };
  broadcastPacket("telemetry", packet);

  res.sendStatus(200);
});

app.post("/api/toggle-sim", (req, res) => {
  const { enabled } = req.body;
  globalSimEnabled = enabled;
  console.log(`[TOGGLE-SIM] Global simulation mode is now: ${enabled ? "ENABLED" : "DISABLED"}`);
  res.sendStatus(200);
});

app.post("/api/set-interval", (req, res) => {
  const { interval } = req.body;
  if (interval < 25 || interval > 10000) {
    return res.status(400).send("Interval must be between 25ms and 10000ms.");
  }
  simulationIntervalMs = interval;
  console.log(`[INTERVAL] Simulation interval set to ${simulationIntervalMs}ms.`);
  res.sendStatus(200);
});

// --- SSE Events --- //
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.push(res);

  req.on("close", () => {
    const index = clients.indexOf(res);
    if (index !== -1) clients.splice(index, 1);
  });
});

// --- Startup --- //
async function start() {
  await setupExchangesAndQueues();
  await startConsumers();
  loadComponentConfig();

  app.listen(PORT, () => {
    console.log(`Fusion running at http://localhost:${PORT}`);
  });
}

start();
