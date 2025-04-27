import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import * as jsyaml from "js-yaml";
import amqplib from "amqplib";
import { Etcd3 } from "etcd3";
//Unused for now
const etcd = new Etcd3({ hosts: "http://etcd0:2379" });
//Set up file stuff
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 8505;
// file paths
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

// Middleware
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Utility Functions -----------------------------------------------------
//Check Valid JSON
function isValidJSON(text){
  try{
    JSON.parse(text);
  } catch {
    console.error('Invalid JSON:', text);
    return false;
  }
}

// Determine If The Source Is Fusion
function determineSource(commandData){
  if(!commandData.Source || (commandData.Source != 'Fusion')){
    return false;
  } else {
    return true;
  }
}

// Create the Connection
async function createConnection(config){
  const conn = await amqplib.connect(config);
  conn.on("error", function(err){
    console.error("Connection Error:", err.message)
  })
  conn.on("close", function(){
    console.error("Connection Closed")
  })
  return conn;
}

// Component Config & Map Based Code ----------------------------------
function broadcastMapToTheFrontend(map){
  //Send the map to the frontend
  console.log(map);
}

// Load config.yaml
function loadComponentConfig(filePath){
  try {
    const fileContents = fs.readFileSync(filePath, "utf8");
    const config = jsyaml.load(fileContents);
    componentMap = {};
    Object.entries(config.channels || {}).forEach(([source_name, group]) => {
      Object.entries(group.channels || {}).forEach(([id, props]) => {
        componentMap[id] = { id, source_name, ...props };
      });
    });
    broadcastMapToTheFrontend(componentMap);
  
  } catch (err) {
    console.error("Failed to load config.yaml:", err);
  }
}

loadComponentConfig(CONFIG_PATH)

// LavinMQ Connection & Broker Based Code-------------------------------------------------------------------------------------
function readBrokerConfig(filePath){
  try{
    const fileContents = fs.readFileSync(filePath, 'utf8');
    const yamlObj = jsyaml.load(fileContents);
    return yamlObj;
  } catch(error){
    console.error("Error Reading/Parsing The Broker Config YAML File:", error)
  }
}

//Fine for now, but will want to change this eventually to have fusion-commands, and fusion-telemetry
const queue = 'fusion';

//Load message_broker_config.yaml
async function loadLavinMQQuesConfig(filePath){
  const config = readBrokerConfig(filePath);
  if(config){
    try{
        let connection = await createConnection(lavinConfig);
        let channel = await connection.createChannel();
        if(lavinConfig.brokers.lavinmq.exchanges && config.brokers.lavinmq.exchanges.length > 0){
          config.brokers.lavinmq.exchanges.forEach((exchange) =>{
            console.log('Configuring Exchange', exchange.name);
            channel.assertExchange(exchange.name, 'fanout', {durable: true});
            if(exchange.queues && exchange.queues.length > 0){
              exchange.queues.forEach(queue => {
                console.log('Binding Queue', queue.name);
                channel.assertQueue(queue.name, {durable: true});
                channel.bindQueue(queue.name, exchange.name, "");
              })
            }
          })
        }

        setTimeout(()=>{
          channel.close();
          connection.close();
        }, 500)
    } catch(error){
      console.error("Error Configuring LavinMQ Exchanges/Queues: ", error);
    }
  }
}

loadLavinMQQuesConfig(BROKER_CONFIG_PATH);


// Command Based Code-------------------------------------------------------------------------------------------------------------------------
function broadcastCommand(commandPacket){
  // If the container sim toggle is active and the id is in Object.Keys(commandPacket.Data) then we want to send this TLM
  // If the global sim in not active, or the container sim toggle is not active for the id that is in Object.Keys(commandPacket.Data)
  // then we want to send the commandPacket to CMD_BC
  console.log(commandPacket);
  

}

function onNewCommand(msg){
  console.log('Received New Command Message: ', msg.content.toString());
  const messageValue = msg.content.toString();
  if(isValidJSON(messageValue)){
    const receivedCommand = JSON.parse(messageValue);
    console.log('Parsed Command: ', receivedCommand);
    const selfSourced = determineSource(receivedCommand);
    if(selfSourced){
      const commandPacket = {
        Source: 'Fusion',
        "Time Stamp": Math.floor(Date.now() / 1000),
        Data: receivedCommand
      }
      broadcastCommand(commandPacket);
    }
    
  }
}

// Command Logging
function startLoggingCommands(ch){
  ch.consume(queue, (msg)=>{
    onNewCommand(msg);
    ch.ack(msg);
  })
}



// Telemetry Based Code ------------------------------------------------------------------------
function broadcastTelemetryToFrontEnd(individualTelemetryPacket){
  clients.forEach((client) => client.write(`data: ${JSON.stringify(individualTelemetryPacket)}\n\n`));
}

// Process The Telemetry We Get From Polling.
function processTelemetry(msg){
  console.log('Incomming Telemetry:', msg.content.toString());
  const messageValue = msg.content.toString();
  if(isValidJSON(messageValue)){
    const parsedTelemetry = JSON.parse(messageValue);

    if (parsedTelemetry.Source && parsedTelemetry["Time Stamp"] &&  parsedTelemetry.Data) {
      let individualTelemetryPacket = {
        Source: parsedTelemetry.Source,
        "Time Stamp": parsedTelemetry["Time Stamp"],
        Data: {}
      }
      Object.entries(parsedTelemetry.Data).forEach(([id, value]) => {
        if (componentMap[id]) {
          individualTelemetryPacket.Data = {id: value};
          broadcastTelemetryToFrontEnd(individualTelemetryPacket);
        } else {
          console.log('Telemetry Received For ID not found in the config.yaml:',{id, value})
        }
      });
    } else {
      console.log('Unexpected Telemetry Packet Shape: ', parsedTelemetry);
    }
  } else {
    console.log('Impropperly Formatted Telemetry Received:', messageValue)
  }
  
}

// Start The Producer Exchange
async function startProducerExchange(){
  try{
    const conn = await createConnection(lavinConfig);
    let channel = await conn.createChannel();

    await channel.assertExchange('CMD_BC', 'fanout', {durable: true});
    await channel.assertQueue(queue, {durable: true});
    await channel.bindQueue(queue, 'CMD_BC', '');
    startLoggingCommands(channel)
  }catch(error){
    console.error('Error Starting Produces Exchange: ', error.message)
  }
}

//Start Polling for Telemetry Messages
function startPollingForMessages(ch){
  ch.consume(queue, (msg)=>{
    processTelemetry(msg);
    ch.ack(msg)
  })
};

// Start The Connection
async function startConnection() {
  try {
    const conn = await createConnection(lavinConfig);
    console.log('Connected To The AMQP Server');
    let channel = await conn.createChannel();
    await channel.assertQueue(queue, {durable: true});
    startPollingForMessages(channel);
  } catch (err) {
    console.error("Failed to connect to LavinMQ:", err);
  }
}

// This Is Probably The Wrong Way To Do This
startConnection().then(() => {
  startProducerExchange();
  app.listen(PORT, () => {
    console.log(`Fusion running at http://localhost:${PORT}`);
  });
});
