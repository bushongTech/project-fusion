import numpy as np
import asyncio
import aio_pika
import time
import json

# RoboDK-specific modules
from robodk.robolink import *         # Main API to interact with RoboDK
from robodk.robomath import *         # Math functions and pose conversions
from robodk.robodialogs import *      # UI elements in RoboDK (not used yet)
from robodk.robofileio import *       # File IO from RoboDK (not used yet)

# Custom logging and message broker support
from common.message_broker import BrokerType, MessageBroker
from loguru import logger

# Load and apply global message broker configuration
# This may include LavinMQ settings, topic bindings, etc.
MessageBroker(config_file_path="message_broker_config.yaml")


class Fanuc350:
    """
    This class represents the control interface for a Fanuc robot within RoboDK,
    extended to publish telemetry to LavinMQ and support command reception from CMD_BC.
    """
    def __init__(self, exchange):
        self.RDK = Robolink()       # Establish connection with the running RoboDK instance
        self.exchange = exchange    # LavinMQ exchange object used for publishing telemetry
        self.paused = False         # If True, robot will ignore movement commands

        # Internal state dictionary — this will be sent as telemetry
        self.state = {
            "position": [0.0, 0.0, 0.0],     # XYZ coordinates in mm
            "pose": [0.0, 0.0, 0.0],         # ABC Euler angles in degrees
            "helix_progress": 0.0           # Optional use-case (placeholder)
        }

        # Licensing and station setup
        self.license = self.RDK.License("L-5700-5458-0316-4185-4B59-57E5-0C")
        self.RDK.AddFile("/home/user/FanucS01Workstation.rdk")  # Load .rdk file

        # Identify the core objects in the station (robot, frame, target)
        self.robot = self.RDK.Item('', ITEM_TYPE_ROBOT)
        self.target = self.RDK.Item('', ITEM_TYPE_TARGET)
        self.frame = self.RDK.Item('', ITEM_TYPE_FRAME)

        # Get initial robot position and add GUI buttons
        self.get_pos()
        self.add_buttons()

    def add_buttons(self):
        """
        Adds interactive buttons to the RoboDK GUI.
        These buttons trigger movement commands and control pause/resume.
        """
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
        """
        Reads the robot’s current pose in Fanuc convention (XYZABC)
        and stores each value as an instance attribute.
        """
        pose = Pose_2_Fanuc(self.robot.Pose())
        self.x, self.y, self.z, self.a, self.b, self.c = pose
        return pose

    async def send_telemetry(self):
        """
        Publishes the robot's current state to the LavinMQ exchange 'TLM'.
        The packet follows the standard format:
        {
            "Source": "conch",
            "Time Stamp": <nanoseconds as str>,
            "Data": { position, pose, helix_progress }
        }
        """
        packet = {
            "Source": "conch",
            "Time Stamp": str(time.time_ns()),  # Current time in nanoseconds
            "Data": self.state.copy()
        }
        await self.exchange.publish(
            aio_pika.Message(body=json.dumps(packet).encode()),
            routing_key=""  # Empty routing key for broadcast
        )
        self.RDK.ShowMessage("Telemetry sent.", False)

    async def move_and_update(self, move_pose):
        """
        Executes a robot movement and publishes telemetry afterward.
        Skips execution if motion is currently paused.
        """
        if self.paused:
            self.RDK.ShowMessage("Movement is currently paused.", False)
            return False
        try:
            self.robot.MoveJ(Fanuc_2_Pose(move_pose))  # Send motion command to RoboDK
            self.state["position"] = move_pose[:3]
            self.state["pose"] = move_pose[3:]
            await self.send_telemetry()
            return True
        except Exception as e:
            self.RDK.ShowMessage(f"Move failed: {e}", False)
            return False

    async def move_axis(self, axis, delta):
        """
        Utility method to move the robot along a given axis ('x', 'y', 'z') by a delta (in mm).
        """
        self.get_pos()
        move = [self.x, self.y, self.z, self.a, self.b, self.c]
        axis_index = {"x": 0, "y": 1, "z": 2}
        if axis in axis_index:
            move[axis_index[axis]] += delta
            await self.move_and_update(move)

    def toggle_pause(self):
        """
        Toggles motion enable/disable. When paused, all move commands are ignored.
        """
        self.paused = not self.paused
        msg = "PAUSED" if self.paused else "RESUMED"
        self.RDK.ShowMessage(f"Motion {msg}", False)


async def monitor_buttons(robot):
    """
    Polls RoboDK GUI for button presses and delegates to robot actions.
    This loop runs continuously.
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
    Subscribes to the CMD_BC queue and listens for external command packets.
    Expected message format:
    {
        "action": "move_x" | "move_y" | "move_z" | "pause",
        "value": <numeric delta>
    }
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
    """
    Entry point: connects to LavinMQ, initializes the robot interface,
    and starts both the GUI button handler and command listener concurrently.
    """
    connection = await aio_pika.connect_robust("amqp://guest:guest@lavinmq0/")
    channel = await connection.channel()

    telemetry_exchange = await channel.declare_exchange("TLM", aio_pika.ExchangeType.TOPIC)
    robot = Fanuc350(telemetry_exchange)

    await asyncio.gather(
        monitor_buttons(robot),       # Listen for GUI button presses
        listen_for_commands(robot, channel)  # Listen for CMD_BC messages
    )

    await connection.close()


if __name__ == "__main__":
    # Ensures this runs only when executed directly
    asyncio.run(main())