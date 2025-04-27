import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import yaml from "js-yaml";
import amqp from "amqplib";
import { Etcd3 } from "etcd3";

const etcd = new Etcd3({ hosts: "http://etcd0:2379" });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 8505;

const CONFIG_PATH = "/config/config.yaml";
const BROKER_CONFIG_PATH = "/config/message_broker_config.yaml";

let componentMap = {};
let latestValues = {};
let simIntervals = {};
const clients = [];
let lavinChannel;
let simRelayActive = false;
let simRelayConsumerTag;
let simulationInterval = 500;

// Load YAML configs
function loadComponentConfig() {
  try {
    const fileContents = fs.readFileSync(CONFIG_PATH, "utf8");
    const config = yaml.load(fileContents);
    componentMap = {};
    Object.entries(config.channels || {}).forEach(([source_name, group]) => {
      Object.entries(group.channels || {}).forEach(([id, props]) => {
        componentMap[id] = { id, source_name, ...props };
      });
    });
    console.log(`Loaded ${Object.keys(componentMap).length} components.`);
  } catch (err) {
    console.error("Failed to load config.yaml:", err);
  }
}

const brokerConfig = (() => {
  try {
    const fileContents = fs.readFileSync(BROKER_CONFIG_PATH, "utf8");
    return yaml.load(fileContents);
  } catch (err) {
    console.error("Failed to load message_broker_config.yaml:", err);
    process.exit(1);
  }
})();

loadComponentConfig();

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

function broadcastUpdate(id, value) {
  const data = JSON.stringify({ id, value });
  clients.forEach((client) => client.write(`data: ${data}\n\n`));
}

function publishToExchange(exchange, source, data) {
  if (!lavinChannel) {
    console.error(`No LavinMQ channel available to publish to ${exchange}`);
    return;
  }
  const payload = {
    Source: source,
    Timestamp: Math.floor(Date.now() / 1000),
    Data: data
  };
  lavinChannel.publish(exchange, "", Buffer.from(JSON.stringify(payload)));
}

async function setupLavin() {
  const lavinmq = brokerConfig.brokers.lavinmq;
  const conn = await amqp.connect({
    protocol: "amqp",
    hostname: lavinmq.host,
    port: lavinmq.port,
    username: lavinmq.username,
    password: lavinmq.password,
    vhost: lavinmq.virtual_host
  });
  lavinChannel = await conn.createChannel();

  for (const ex of lavinmq.exchanges) {
    await lavinChannel.assertExchange(ex.name, ex.type, { durable: true });
    for (const q of ex.queues) {
      await lavinChannel.assertQueue(q.name, { durable: true });
      await lavinChannel.bindQueue(q.name, ex.name, "");
    }
  }

  await startTLMConsumer();
}

app.get("/api/components", (req, res) => res.json(Object.values(componentMap)));

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

app.post("/api/simulate", async (req, res) => {
  const { id, min, max, value } = req.body;
  const component = componentMap[id];
  if (!component) return res.status(400).send("Invalid ID");

  try {
    if (component.type === "sensor") {
      if (simIntervals[id]) clearInterval(simIntervals[id]);

      simIntervals[id] = setInterval(() => {
        const rand = Math.random() * (max - min) + min;
        const rounded = parseFloat(rand.toFixed(2));
        publishToExchange("TLM", "Fusion", { [id]: rounded });
      }, simulationInterval);

      console.log(`Simulating sensor ${id}...`);
    }
    if (component.type === "control") {
      publishToExchange("CMD_BC", "Fusion", { [id]: value });
      console.log(`Control ${id} set to ${value}`);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Simulate error:", err);
    res.status(500).send("Simulation Error");
  }
});

app.post("/api/no-sim", async (req, res) => {
  const { id, value } = req.body;
  const component = componentMap[id];
  if (!component) return res.status(400).send("Invalid ID");

  try {
    publishToExchange("CMD_BC", "Fusion", { [id]: value });
    console.log(`(No Sim) Control ${id} set to ${value}`);
    res.sendStatus(200);
  } catch (err) {
    console.error("No-Sim error:", err);
    res.status(500).send("No-Sim Error");
  }
});

app.post("/api/simulate/stop", (req, res) => {
  const { id } = req.body;
  if (simIntervals[id]) {
    clearInterval(simIntervals[id]);
    delete simIntervals[id];
  }
  res.sendStatus(200);
});

app.post("/api/toggle-sim", async (req, res) => {
  const { enabled } = req.body;
  if (enabled) {
    await startSimRelayConsumer();
  } else {
    await stopSimRelayConsumer();
  }
  res.sendStatus(200);
});

app.post("/api/sim-interval", (req, res) => {
  const { interval } = req.body;
  if (typeof interval === "number" && interval >= 25 && interval <= 10000) {
    simulationInterval = interval;
    console.log(`Simulation interval set to ${simulationInterval} ms`);
    res.sendStatus(200);
  } else {
    res.status(400).send("Invalid interval");
  }
});

async function startSimRelayConsumer() {
  if (simRelayActive || !lavinChannel) return;
  await lavinChannel.assertQueue("CMD_BC", { durable: true });
  console.log("Relaying CMD_BC to TLM...");

  const { consumerTag } = await lavinChannel.consume("CMD_BC", (msg) => {
    if (msg !== null) {
      try {
        const data = JSON.parse(msg.content.toString());
        publishToExchange("TLM", "Fusion", data.Data);
      } catch (err) {
        console.error("Invalid message from CMD_BC:", err);
      }
      lavinChannel.ack(msg);
    }
  });

  simRelayConsumerTag = consumerTag;
  simRelayActive = true;
}

async function stopSimRelayConsumer() {
  if (!simRelayActive || !lavinChannel || !simRelayConsumerTag) return;
  await lavinChannel.cancel(simRelayConsumerTag);
  console.log("Stopped relaying CMD_BC");
  simRelayActive = false;
  simRelayConsumerTag = null;
}

async function startTLMConsumer() {
  await lavinChannel.assertQueue("TLM", { durable: true });
  console.log("Listening to TLM queue...");

  lavinChannel.consume("TLM", (msg) => {
    if (msg !== null) {
      try {
        const data = JSON.parse(msg.content.toString());
        if (data.Data) {
          Object.entries(data.Data).forEach(([id, value]) => {
            if (componentMap[id]) {
              latestValues[id] = value;
              broadcastUpdate(id, value);
            }
          });
        }
      } catch (err) {
        console.error("Invalid TLM message:", err);
      }
      lavinChannel.ack(msg);
    }
  });
}

setupLavin()
  .then(() => {
    app.listen(PORT, () => console.log(`Fusion running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to start Fusion:", err);
    process.exit(1);
  });