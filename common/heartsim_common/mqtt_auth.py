"""Kredensial dan TLS MQTT dari variabel lingkungan, dipakai semua klien Python.

    MQTT_USER / MQTT_PASS   akun di berkas passwd broker (kosong = anonim, hanya broker pengembangan)
    MQTT_TLS=1              aktifkan TLS (port biasanya 8883)
    MQTT_CA=/path/ca.crt    CA untuk memverifikasi broker; kosong = CA sistem (mis. Let's Encrypt)
"""
from __future__ import annotations

import os
import ssl


def apply(client, user: str | None = None, password: str | None = None) -> None:
    user = os.getenv("MQTT_USER", "") if user is None else user
    password = os.getenv("MQTT_PASS", "") if password is None else password
    if user:
        client.username_pw_set(user, password or None)
    if os.getenv("MQTT_TLS", "0").lower() in ("1", "true", "ya", "yes"):
        client.tls_set(ca_certs=os.getenv("MQTT_CA") or None, tls_version=ssl.PROTOCOL_TLS_CLIENT)
