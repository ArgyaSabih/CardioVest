"""Dispatcher notifikasi tiruan (mock) mengikuti 'Algoritma Push Notification Dispatch' (BAB 8.6).

* WARNING  -> hanya User Utama, priority=high
* CRITICAL -> User Utama + seluruh kontak darurat (FCM multicast), payload berisi GPS & status jatuh
* Retry exponential backoff: wait(n) = base_delay * 2^n + jitter, base 1 s, maks 5 percobaan, maks 32 s

Belum mengirim ke Firebase sungguhan; hasilnya dicatat ke log dan tabel notifications.
Untuk integrasi nyata, ganti _send_fcm() dengan firebase_admin.messaging.send_each_for_multicast().
"""
from __future__ import annotations

import json
import logging
import os
import random
import threading
import time

log = logging.getLogger("notifikasi")

DEFAULT_CONTACTS = [
    {"name": "Kontak Darurat 1", "relation": "keluarga", "token": "fcm-token-kontak-1"},
    {"name": "Kontak Darurat 2", "relation": "keluarga", "token": "fcm-token-kontak-2"},
]


class MockNotifier:
    def __init__(self, repo, user_id: str, fail_rate: float | None = None,
                 simulate_delay: bool = False):
        self.repo = repo
        self.user = {"name": "Pengguna Utama", "user_id": user_id, "token": "fcm-token-user"}
        try:
            self.contacts = json.loads(os.getenv("CONTACTS_JSON", "")) or DEFAULT_CONTACTS
        except json.JSONDecodeError:
            self.contacts = DEFAULT_CONTACTS
        self.fail_rate = float(os.getenv("FCM_MOCK_FAIL_RATE", "0")) if fail_rate is None else fail_rate
        self.simulate_delay = simulate_delay

    @staticmethod
    def backoff(n: int, base: float = 1.0, max_wait: float = 32.0) -> float:
        return min(max_wait, base * (2 ** n) + random.uniform(0, 0.5))

    def _send_fcm(self, tokens: list[str], payload: dict) -> bool:
        return random.random() >= self.fail_rate

    def dispatch(self, event_type: str, device_id: str, payload: dict) -> None:
        threading.Thread(target=self._dispatch, args=(event_type, device_id, payload), daemon=True).start()

    def _dispatch(self, event_type: str, device_id: str, payload: dict) -> None:
        recipients = [self.user] if event_type == "warning" else [self.user, *self.contacts]
        tokens = [r["token"] for r in recipients]
        attempts, ok = 0, False
        while attempts < 5 and not ok:
            ok = self._send_fcm(tokens, payload)
            attempts += 1
            if not ok:
                wait = self.backoff(attempts - 1)
                log.warning("FCM gagal (percobaan %d); retry dalam %.1f s", attempts, wait)
                if self.simulate_delay:
                    time.sleep(wait)
        names = ", ".join(r["name"] for r in recipients)
        status = "terkirim" if ok else "gagal"
        lvl = logging.CRITICAL if event_type.startswith("critical") else logging.WARNING
        log.log(lvl, "[MOCK FCM %s] %s -> %s | %s", status.upper(), event_type, names,
                json.dumps(payload, ensure_ascii=False))
        self.repo.save_notification(device_id, int(time.time() * 1000), event_type,
                                    [r["name"] for r in recipients], payload, status, attempts)
