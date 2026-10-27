"""Hierarki topik MQTT sesuai Tabel 'Hierarki topik MQTT' (BAB 8.2).

| Topik                    | QoS | Arah            | Keterangan                                  |
|--------------------------|-----|-----------------|---------------------------------------------|
| device/{id}/ecg          | 0   | device -> cloud | 875 sampel baru tiap 3,5 s                   |
| device/{id}/vital        | 1   | device -> cloud | HR, GSR, SQI, akselerasi, GPS tiap 1 s        |
| device/{id}/state        | 1 R | cloud  -> semua | state FSM terakhir (retained)                |
| device/{id}/alert        | 2   | cloud  -> semua | peringatan Warning/Critical                  |
| device/{id}/cmd          | 1   | cloud  -> device| sinkronisasi state ke perangkat              |
| device/{id}/lwt          | 1 R | broker          | Last Will: online/offline                    |

Ekstensi (tidak ada di tabel dokumen, ditambahkan untuk simulasi):
| device/{id}/event        | 1   | device -> cloud | tombol hardware reset R(t)=1                 |
| device/{id}/inference    | 0   | cloud  -> semua | hasil CNN tiap window (untuk pemantauan/UI)  |
| device/{id}/remote       | 1   | web    -> cloud | reset alarm dari aplikasi (akun web)         |
| sim/{id}/control         | 1   | alat -> simulator | pilih skenario, reset, putus koneksi        |
| sim/{id}/status          | 1 R | simulator -> alat | skenario aktif                              |
"""

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
}


def t(device_id: str, kind: str) -> str:
    return f"device/{device_id}/{kind}"


def sim_control(device_id: str) -> str:
    return f"sim/{device_id}/control"


def sim_status(device_id: str) -> str:
    return f"sim/{device_id}/status"


def parse(topic: str) -> tuple[str, str] | None:
    """'device/cv-001/ecg' -> ('cv-001', 'ecg')."""
    parts = topic.split("/")
    if len(parts) == 3 and parts[0] == "device":
        return parts[1], parts[2]
    return None
