import fs from "fs";
import yaml from "js-yaml";
import pkg from "pg";
import amqplib from "amqplib";

const { Pool } = pkg;

const configPath = "./config/config.yaml";
const brokerConfigPath = "./config/message_broker_config.yaml";
const baseColumns = [`"timestamp" TIMESTAMP`, `"source" TEXT`];
const tables = ["telemetry", "commands"];

console.log("Storage Service started");

const pool = new Pool({
  host: "local-db",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "demo",
});

function getChannelIDsFromYAML(yamlPath) {
  const raw = fs.readFileSync(yamlPath, "utf8");
  const parsed = yaml.load(raw);
  const ids = [];

  if (parsed.channels) {
    for (const group of Object.values(parsed.channels)) {
      if (group.channels) {
        ids.push(...Object.keys(group.channels));
      }
    }
  }

  return ids;
}

async function getExistingColumns(table) {
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return res.rows.map((r) => r.column_name);
}

async function ensureColumnsExist(table, ids) {
  const existing = await getExistingColumns(table);
  const missing = ids.filter((id) => !existing.includes(id));

  for (const id of missing) {
    const colDef = `"${id}" DOUBLE PRECISION`;
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
    console.log(`Added column '${id}' to ${table}`);
  }
}

async function ensureTablesExist(ids) {
  const dynamicColumns = ids.map((id) => `"${id}" DOUBLE PRECISION`);
  const allColumns = [...baseColumns, ...dynamicColumns].join(", ");

  for (const table of tables) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (${allColumns})`);
    await ensureColumnsExist(table, ids);
  }
}

async function consumeAndStore({ exchange, queue, table }) {
  const conn = await amqplib.connect(lavinConfig);
  const ch = await conn.createChannel();

  await ch.assertExchange(exchange, "fanout", { durable: true });
  await ch.assertQueue(queue, { durable: true });
  await ch.bindQueue(queue, exchange, "");

  console.log(`Listening to '${exchange}' → '${queue}' → writing to '${table}'`);

  ch.consume(
    queue,
    async (msg) => {
      if (!msg) return;

      try {
        const payload = JSON.parse(msg.content.toString());

        const source = payload.Source;
        const timestamp = new Date(payload["Time Stamp"]);
        const data = payload.Data || {};

        const ids = Object.keys(data);
        if (!source || !timestamp || ids.length === 0) {
          console.log(`[${exchange}] Skipped malformed message:`, payload);
          ch.ack(msg);
          return;
        }

        await ensureColumnsExist(table, ids);

        const fields = ["timestamp", "source", ...ids];
        const values = [timestamp, source, ...Object.values(data)];
        const placeholders = fields.map((_, i) => `$${i + 1}`).join(", ");
        const columns = fields.map((f) => `"${f}"`).join(", ");
        const query = `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`;

        await pool.query(query, values);
        ch.ack(msg);
      } catch (err) {
        console.error(`[${exchange}] Failed to insert into ${table}:`, err);
        ch.ack(msg); // Avoid message getting stuck
      }
    },
    { noAck: false }
  );
}

//
// MAIN EXECUTION
//
const channelIDs = getChannelIDsFromYAML(configPath);
console.log("Extracted channel IDs:", channelIDs);

await ensureTablesExist(channelIDs);

const rawBrokerYaml = fs.readFileSync(brokerConfigPath, "utf8");
const parsedBroker = yaml.load(rawBrokerYaml);
const lavin = parsedBroker.brokers.lavinmq;

const lavinConfig = {
  protocol: "amqp",
  hostname: lavin.host,
  port: lavin.port,
  username: lavin.username,
  password: lavin.password,
  vhost: lavin.virtual_host,
};

console.log("All exchanges found:", lavin.exchanges.map((e) => e.name));

await consumeAndStore({
  exchange: "TLM",
  queue: "storage-service-tlm",
  table: "telemetry",
});

await consumeAndStore({
  exchange: "CMD_BC",
  queue: "storage-service-cmd",
  table: "commands",
});

console.log("Storage Service fully initialized and consuming.");
