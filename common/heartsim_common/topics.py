import os

QOS = {
    "ecg": 0,
    "vital": 1,
    "state": 1,
    "alert": 2,
    "cmd": 1,
    "lwt": 1,
    "event": 1,
    "inference": 0,
    "remote": 1,
    "ecg_dataset": 0,
    "source": 1,
}
MAX_QOS = int(os.getenv("MQTT_MAX_QOS", "2"))
QOS = {k: min(v, MAX_QOS) for k, v in QOS.items()}


def t(device_id: str, kind: str) -> str:
    return f"device/{device_id}/{kind}"


def parse(topic: str) -> tuple[str, str] | None:
    parts = topic.split("/")
    if len(parts) == 3 and parts[0] == "device":
        return parts[1], parts[2]
    return None
