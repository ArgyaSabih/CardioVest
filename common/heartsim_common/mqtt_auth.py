from __future__ import annotations

import os
import ssl

import paho.mqtt.client as mqtt


def _on(name: str) -> bool:
    return os.getenv(name, "0").lower() in ("1", "true", "ya", "yes")


def apply(client, user: str | None = None, password: str | None = None) -> None:
    user = os.getenv("MQTT_USER", "") if user is None else user
    password = os.getenv("MQTT_PASS", "") if password is None else password
    if user:
        client.username_pw_set(user, password or None)
    if _on("MQTT_TLS"):
        client.tls_set(ca_certs=os.getenv("MQTT_CA") or None, tls_version=ssl.PROTOCOL_TLS_CLIENT)


def make_client(client_id: str, clean_session: bool = True, user: str | None = None) -> mqtt.Client:
    transport = "websockets" if os.getenv("MQTT_TRANSPORT", "tcp").lower() in ("ws", "websockets") else "tcp"
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id, clean_session=clean_session,
                    transport=transport)
    if transport == "websockets":
        c.ws_set_options(path=os.getenv("MQTT_WS_PATH", "/"))
    apply(c, user=user)
    return c
