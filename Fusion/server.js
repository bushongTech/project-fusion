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

let publisherConnection;
let publisherChannel;

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

  // Always stream to SSE clients
  clients.forEach((client) => client.write(`data: ${JSON.stringify(packet)}\n\n`));

  // Only publish commands to LavinMQ
  if (type !== "command") return;

  if (publisherChannel) {
    try {
      const exchangeName = "CMD_BC";
      publisherChannel.assertExchange(exchangeName, "fanout", { durable: true });
      publisherChannel.publish(exchangeName, "", Buffer.from(JSON.stringify(payload)));
      console.log(`[AMQP] Published packet to exchange '${exchangeName}'`);
    } catch (err) {
      console.error("[AMQP] Failed to publish packet:", err);
    }
  }
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
      return channel.ack(msg);
    }

    if (data.Data) {
      Object.entries(data.Data).forEach(([id, value]) => {
        if (componentMap[id] && value !== null && value !== undefined) {
          const packet = {
            type: "telemetry",
            payload: {
              Source: data.Source || "Unknown",
              "Time Stamp": data["Time Stamp"],
              Data: { [id]: value },
            },
          };

          
          clients.forEach((client) => {
            client.write(`data: ${JSON.stringify(packet)}\n\n`);
          });
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

app.post("/api/command", (req, res) => {
  const { id, value } = req.body;
  if (!componentMap[id] || componentMap[id].type !== "control") {
    return res.status(400).send("Invalid or non-control component ID");
  }

  const packet = {
    Source: "Fusion",
    "Time Stamp": Date.now(),
    Data: { [id]: value },
  };

  broadcastPacket("command", packet);
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
  publisherConnection = await createConnection(lavinConfig);
  publisherChannel = await publisherConnection.createChannel();

  app.listen(PORT, () => {
    console.log(`Fusion running at http://localhost:${PORT}`);
  });
}

start();