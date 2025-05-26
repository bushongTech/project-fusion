import yaml from "js-yaml";
import amqplib from "amqplib";
import fs from "fs";
import { Synnax, DataType, TimeStamp } from "@synnaxlabs/client";

const configPath = "/config/config.yaml";
const brokerConfigPath = "/config/message_broker_config.yaml";
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

const timeChannelMap = {};
const sensorChannelMap = {};
const controlChannelMap = {};
const writersMap = {};
const feedbackChannelMap = {};

const client = new Synnax({
  host: "synnax",
  port: 9095,
  username: "synnax",
  password: "seldon",
  secure: false,
});

let hasWritten = false;
let streamerStarted = false;

function mapChannelIDsFromYAML(yamlPath) {
  const raw = fs.readFileSync(yamlPath, "utf8");
  const parsed = yaml.load(raw);
  const map = {};

  if (parsed.channels) {
    for (const group of Object.values(parsed.channels)) {
      if (group.channels) {
        for (const [id, channel] of Object.entries(group.channels)) {
          map[id] = channel.type;
        }
      }
    }
  }

  return map;
}

async function createChannels() {
  const channelMap = mapChannelIDsFromYAML(configPath);

  for (const [channel, type] of Object.entries(channelMap)) {
    try {
      const start = TimeStamp.now();

      if (type === "sensor") {
        const timeIndex = await client.channels.create({
          name: `${channel}-T`,
          dataType: "timestamp",
          isIndex: true,
        }, { retrieveIfNameExists: true });

        const sensor = await client.channels.create({
          name: channel,
          dataType: DataType.FLOAT32,
          index: timeIndex.key,
        }, { retrieveIfNameExists: true });

        if (!timeIndex.key || !sensor.key) {
          console.error(`Missing keys for sensor ${channel}`);
          continue;
        }

        timeChannelMap[`${channel}-T`] = timeIndex.key;
        sensorChannelMap[channel] = sensor.key;

        writersMap[channel] = await client.openWriter({
          start,
          channels: [timeIndex.key, sensor.key],
          authorities: [255, 255],
          enableAutoCommit: true,
        });
      }

      if (type === "control") {
        const timeIndex = await client.channels.create({
          name: `${channel}-T`,
          dataType: "timestamp",
          isIndex: true,
        }, { retrieveIfNameExists: true });

        const control = await client.channels.create({
          name: channel,
          dataType: DataType.FLOAT32,
          index: timeIndex.key,
        }, { retrieveIfNameExists: true });

        const feedback = await client.channels.create({
          name: `${channel}-F`,
          dataType: DataType.FLOAT32,
          virtual: true,
        }, { retrieveIfNameExists: true });

        if (!timeIndex.key || !control.key || !feedback.key) {
          console.error(`Missing keys for control ${channel}`);
          continue;
        }

        timeChannelMap[`${channel}-T`] = timeIndex.key;
        controlChannelMap[channel] = control.key;
        feedbackChannelMap[`${channel}-F`] = feedback.key;

        writersMap[channel] = await client.openWriter({
          start,
          channels: [timeIndex.key, control.key, feedback.key],
          authorities: [255, 255, 0],
          enableAutoCommit: true,
        });
      }
    } catch (err) {
      console.error(`Error creating channels for ${channel}:`, err.message);
    }
  }
}

async function writeToSynnaxChannels(receivedData) {
  const tlmData = receivedData.Data;
  const timestamp = new TimeStamp(receivedData["Time Stamp"]);

  for (const [channel, value] of Object.entries(tlmData)) {
    try {
      if (channel in sensorChannelMap && value !== null) {
        await writersMap[channel].write({
          [timeChannelMap[`${channel}-T`]]: timestamp,
          [sensorChannelMap[channel]]: value,
        });
        hasWritten = true;
      } else if (channel in controlChannelMap && value !== null) {
        await writersMap[channel].write({
          [timeChannelMap[`${channel}-T`]]: timestamp,
          [controlChannelMap[channel]]: value,
        });
        hasWritten = true;
      }

      if (hasWritten && !streamerStarted) {
        streamerStarted = true;
        startStreamer().catch(err =>
          console.error("Streamer failed to start:", err.message)
        );
      }
    } catch (err) {
      console.error(`Error writing TLM for ${channel}:`, err.message);
    }
  }
}

async function startStreamer() {
  const feedbackKeys = Object.keys(feedbackChannelMap);
  const streamer = await client.openStreamer(feedbackKeys);
  console.log("Streamer open");

  try {
    for await (const frame of streamer) {
      const currentFrame = frame.at(-1);
      const [feedbackKey] = Object.keys(currentFrame);
      const controlID = feedbackKey.endsWith("-F")
        ? feedbackKey.slice(0, -2)
        : feedbackKey;
      const value = currentFrame[feedbackKey];

      const commandPacket = {
        Source: "Synnax Console",
        "Time Stamp": Date.now(),
        Data: { [controlID]: value },
      };

      await amqpChannel.publish("CMD_BC", "", Buffer.from(JSON.stringify(commandPacket)));
      console.log("Published command packet:", commandPacket);
    }
  } catch (err) {
    console.error("Streamer error:", err.message);
  } finally {
    streamer.close();
    console.log("Streamer closed");
  }
}

let amqpConn;
let amqpChannel;

async function setupProducer() {
  amqpConn = await amqplib.connect(lavinConfig);
  amqpChannel = await amqpConn.createChannel();
  await amqpChannel.assertExchange("CMD_BC", "fanout", { durable: true });
  console.log("LavinMQ command producer ready.");
}

async function consumeTLM({ exchange, queue }) {
  const conn = await amqplib.connect(lavinConfig);
  const ch = await conn.createChannel();

  await ch.assertExchange(exchange, "fanout", { durable: true });
  await ch.assertQueue(queue, { durable: true });
  await ch.bindQueue(queue, exchange, "");

  console.log(`Listening to '${exchange}' → '${queue}'`);

  ch.consume(queue, async (msg) => {
    if (!msg) return;

    try {
      const payload = JSON.parse(msg.content.toString());
      if (!payload?.Data) {
        ch.ack(msg);
        return;
      }
      await writeToSynnaxChannels(payload);
    } catch (err) {
      console.error("Failed to process TLM message:", err.message);
    }

    ch.ack(msg);
  });
}

await createChannels();
await setupProducer();
await consumeTLM({ exchange: "TLM", queue: "slinky-tlm" });

async function gracefulShutdown() {
  console.log("Graceful shutdown started");

  for (const [channel, writer] of Object.entries(writersMap)) {
    try {
      await writer.close();
      console.log(`Closed writer for ${channel}`);
    } catch (err) {
      console.error(`Error closing writer for ${channel}:`, err.message);
    }
  }

  if (amqpChannel) await amqpChannel.close();
  if (amqpConn) await amqpConn.close();
  console.log("AMQP connection closed");

  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);