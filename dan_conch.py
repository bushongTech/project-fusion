import numpy as np
import asyncio
import aio_pika
import time
import json
from robodk.robolink import * 
from robodk.robomath import * 
from robodk.robodialogs import * 
from robodk.robofileio import * 
from common.message_broker import BrokerType, MessageBroker
from loguru import logger

MessageBroker(config_file_path="message_broker_config.yaml")


class Fanuc350:
    def __init__(self, exchange):
        self.RDK = Robolink()
        self.exchange = exchange
        self.paused = False

        self.state = {
            "position": [0.0, 0.0, 0.0],
            "pose": [0.0, 0.0, 0.0],
            "helix_progress": 0.0
        }

        self.license = self.RDK.License("Removed-for-sake-of-pseudo-code")
        self.RDK.AddFile("/home/user/FanucS01Workstation.rdk")

        self.robot = self.RDK.Item('', ITEM_TYPE_ROBOT)
        self.target = self.RDK.Item('', ITEM_TYPE_TARGET)
        self.frame = self.RDK.Item('', ITEM_TYPE_FRAME)

        self.get_pos()
        self.add_buttons()

    def add_buttons(self):
        # Add your actual buttons here
        # Remove pass when buttons are added
        self.RDK.AddButton("Move +X", "Move +50mm along X")
        self.RDK.AddButton("Move -X", "Move -50mm along X")
        self.RDK.AddButton("Move +Y", "Move +50mm along Y")
        self.RDK.AddButton("Move -Y", "Move -50mm along Y")
        self.RDK.AddButton("Move +Z", "Move +50mm along Z")
        self.RDK.AddButton("Move -Z", "Move -50mm along Z")
        self.RDK.AddButton("Pause", "Pause or resume movement")

    def get_pos(self):
        pose = Pose_2_Fanuc(self.robot.Pose())
        self.x, self.y, self.z, self.a, self.b, self.c = pose
        return pose

    async def send_telemetry(self):
        packet = {
            "Source": "conch",
            "Time Stamp": str(time.time_ns()),
            "Data": self.state.copy()
        }
        await self.exchange.publish(
            aio_pika.Message(body=json.dumps(packet).encode()),
            routing_key=""
        )
        self.RDK.ShowMessage("Telemetry sent.", False)

    async def move_and_update(self, move_pose):
        if self.paused:
            self.RDK.ShowMessage("Movement is currently paused.", False)
            return False
        try:
            self.robot.MoveJ(Fanuc_2_Pose(move_pose))
            self.state["position"] = move_pose[:3]
            self.state["pose"] = move_pose[3:]
            await self.send_telemetry()
            return True
        except Exception as e:
            self.RDK.ShowMessage(f"Move failed: {e}", False)
            return False

    # Shared movement handlers
    async def move_axis(self, axis, delta):
        self.get_pos()
        move = [self.x, self.y, self.z, self.a, self.b, self.c]
        axis_index = {"x": 0, "y": 1, "z": 2}
        if axis in axis_index:
            move[axis_index[axis]] += delta
            await self.move_and_update(move)

    def toggle_pause(self):
        self.paused = not self.paused
        msg = "PAUSED" if self.paused else "RESUMED"
        self.RDK.ShowMessage(f"Motion {msg}", False)


async def monitor_buttons(robot):
    """
    Reacts to RoboDK GUI button events.
    """
    while True:
        btn = robot.RDK.RunMessage()
        if btn == "Move +X":
            await robot.move_axis("x", 50)
        elif btn == "Move -X":
            await robot.move_axis("x", -50)
        elif btn == "Move +Y":
            await robot.move_axis("y", 50)
        elif btn == "Move -Y":
            await robot.move_axis("y", -50)
        elif btn == "Move +Z":
            await robot.move_axis("z", 50)
        elif btn == "Move -Z":
            await robot.move_axis("z", -50)
        elif btn == "Pause":
            robot.toggle_pause()
        await asyncio.sleep(0.1)


async def listen_for_commands(robot, channel):
    """
    Listens to CMD_BC for command packets of the form:
    { "action": "move_x", "value": 50 }
    """
    queue = await channel.declare_queue("conch", durable=True)
    await queue.bind(exchange="CMD_BC", routing_key="")

    async with queue.iterator() as queue_iter:
        async for message in queue_iter:
            async with message.process():
                try:
                    payload = json.loads(message.body.decode())
                    action = payload.get("action")
                    value = payload.get("value", 0)

                    if action == "move_x":
                        await robot.move_axis("x", value)
                    elif action == "move_y":
                        await robot.move_axis("y", value)
                    elif action == "move_z":
                        await robot.move_axis("z", value)
                    elif action == "pause":
                        robot.toggle_pause()

                except Exception as e:
                    robot.RDK.ShowMessage(f"Error processing CMD_BC message: {e}", False)


async def main():
    # Connect to LavinMQ and setup both telemetry and command listening
    connection = await aio_pika.connect_robust("amqp://guest:guest@lavinmq0/")
    channel = await connection.channel()

    telemetry_exchange = await channel.declare_exchange("TLM", aio_pika.ExchangeType.TOPIC)
    robot = Fanuc350(telemetry_exchange)

    # Run GUI button loop and CMD_BC listener concurrently
    await asyncio.gather(
        monitor_buttons(robot),
        listen_for_commands(robot, channel)
    )

    await connection.close()


if __name__ == "__main__":
    asyncio.run(main())