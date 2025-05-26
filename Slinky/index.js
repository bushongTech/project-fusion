import yaml from "js-yaml";
import amqplib from "amqplib";
import fs from "fs";
import { Synnax, DataType, TimeStamp } from "@synnaxlabs/client";

const configPath = "/config/config.yaml";
const brokerConfigPath = "/config/message_broker_config.yaml";
const rawBrokerYaml = fs.readFileSync(brokerConfigPath, "utf8");
const parsedBroker = yaml.load(rawBrokerYaml);
const lavin = parsedBroker.brokers.lavinmq;
let amqpConn;
let amqpChannel;

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
        if (type === 'sensor') {
            try {
                const sensorTimeIndexChannel = await client.channels.create({
                    name: `${channel}-T`,
                    dataType: 'timestamp',
                    isIndex: true
                }, { retrieveIfNameExists: true });
                timeChannelMap[`${channel}-T`] = sensorTimeIndexChannel.key;

                const sensorChannel = await client.channels.create({
                    name: channel,
                    dataType: DataType.FLOAT32,
                    index: sensorTimeIndexChannel.key
                }, { retrieveIfNameExists: true });
                sensorChannelMap[channel] = sensorChannel.key;

                writersMap[channel] = await client.openWriter({
                    start: TimeStamp.now(),
                    channels: [sensorTimeIndexChannel, sensorChannel.key],
                    authorities: [255, 255],
                    enableAutoCommit: true
                });

            } catch (err) {
                console.error('Slinky - Create Channels - Sensor - error:', err.message);
            }
        } else if (type === 'control') {
            try {
                const controlTimeIndexChannel = await client.channels.create({
                    name: `${channel}-T`,
                    dataType: 'timestamp',
                    isIndex: true
                }, { retrieveIfNameExists: true });
                timeChannelMap[`${channel}-T`] = controlTimeIndexChannel.key;

                const controlChannel = await client.channels.create({
                    name: channel,
                    dataType: DataType.FLOAT32,
                    index: controlTimeIndexChannel.key
                }, { retrieveIfNameExists: true });
                controlChannelMap[channel] = controlChannel.key;

                const feedbackChannel = await client.channels.create({
                    name: `${channel}-F`,
                    dataType: DataType.FLOAT32,
                    virtual: true
                }, { retrieveIfNameExists: true });
                feedbackChannelMap[`${channel}-F`] = feedbackChannel.key;

                writersMap[channel] = await client.openWriter({
                    start: TimeStamp.now(),
                    channels: [controlTimeIndexChannel, controlChannel.key, feedbackChannel.key],
                    authorities: [255, 255, 0],
                    enableAutoCommit: true
                });

            } catch (err) {
                console.error('Slinky - Create Channels - Control - error:', err.message);
            }
        }
    }
}

async function writeToSynnaxChannels(recievedData) {
    const tlmData = recievedData.Data;
    const timestamp = new TimeStamp(recievedData["Time Stamp"]);

    for (const [channel, value] of Object.entries(tlmData)) {
        const isSensorTLM = channel in sensorChannelMap;
        const isControlTLM = channel in controlChannelMap;

        try {
            if (isSensorTLM && value !== null) {
                await writersMap[channel].write({
                    [timeChannelMap[`${channel}-T`]]: timestamp,
                    [sensorChannelMap[channel]]: value
                });
            } else if (isControlTLM && value !== null) {
                await writersMap[channel].write({
                    [timeChannelMap[`${channel}-T`]]: timestamp,
                    [controlChannelMap[channel]]: value
                });
            } else if (value === null) {
                console.log('null value for:', channel);
            } else {
                console.log(channel, '- Sending Telemetry is not Defined in config/config.yaml');
            }
        } catch (err) {
            console.error('Error Writing to Synnax Channels:', err.message);
        }
    }
}

async function setupProducer() {
    const conn = await amqplib.connect(lavinConfig);
    const ch = await conn.createChannel();
    await ch.assertExchange("CMD_BC", "fanout", { durable: true });
    amqpConn = conn;
    amqpChannel = ch;
    console.log("LavinMQ command producer ready.");
}

async function startStreamer() {
    const feedbackKeys = Object.keys(feedbackChannelMap);
    const streamer = await client.openStreamer(feedbackKeys);
    console.log('Streamer Open');

    try {
        for await (const frame of streamer) {
            const currentFrame = frame.at(-1);

            for (const [feedbackKey, value] of Object.entries(currentFrame)) {
                if (!feedbackKey.endsWith("-F")) continue;

                const controlID = feedbackKey.slice(0, -2);
                const commandPacket = {
                    Source: "Synnax Console",
                    "Time Stamp": TimeStamp.now().value,
                    Data: { [controlID]: value }
                };

                await amqpChannel.publish(
                    "CMD_BC",
                    "",
                    Buffer.from(JSON.stringify(commandPacket))
                );
                console.log("Published command packet:", commandPacket);
            }
        }
    } finally {
        streamer.close();
        console.log('Streamer Closed');
    }
}

async function consumeTLM({ exchange, queue }) {
    const conn = await amqplib.connect(lavinConfig);
    const ch = await conn.createChannel();

    await ch.assertExchange(exchange, "fanout", { durable: true });
    await ch.assertQueue(queue, { durable: true });
    await ch.bindQueue(queue, exchange, "");

    console.log(`Listening to '${exchange}' → '${queue}'`);

    ch.consume(
        queue,
        async (msg) => {
            if (!msg) return;

            try {
                const payload = JSON.parse(msg.content.toString());
                const source = payload.Source;
                const timestamp = new Date(payload["Time Stamp"]);
                const data = payload.Data || {};

                if (!source || !timestamp || Object.keys(data).length === 0) {
                    console.log(`[${exchange}] Skipped malformed message:`, payload);
                    ch.ack(msg);
                    return;
                }

                await writeToSynnaxChannels(payload);
                ch.ack(msg);
            } catch (err) {
                console.error(`[${exchange}] Failed to write to Synnax:`, err);
                ch.ack(msg);
            }
        },
        { noAck: false }
    );
}



await createChannels();
await setupProducer();
await consumeTLM({ exchange: "TLM", queue: "slinky-tlm" });
await startStreamer();

async function gracefulShutdown() {
    console.log('Starting graceful shutdown...');
    for (const [channel, writer] of Object.entries(writersMap)) {
        try {
            await writer.close();
            console.log('Writer closed for source:', channel);
        } catch (err) {
            console.error('Error Closing Writer for:', channel, err.message);
        }
    }

    if (amqpChannel) await amqpChannel.close();
    if (amqpConn) await amqpConn.close();
    console.log('AMQP connection closed');

    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);