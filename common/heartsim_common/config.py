"""Konstanta sistem yang diturunkan langsung dari dokumen Capstone C-251.

Setiap nilai diberi rujukan bab agar mudah ditelusuri saat sidang.
Sebagian besar dapat ditimpa melalui environment variable (lihat fungsi env_*).
"""
from __future__ import annotations

import os


def env_str(name: str, default: str) -> str:
    return os.getenv(name, default)


def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Akuisisi dan windowing (BAB 4.3, 4.7; BAB 8.2)
# ---------------------------------------------------------------------------
FS_ECG = 250                 # Hz, laju cuplik ADC ESP32
WINDOW_SAMPLES = 1750        # L = 7 detik
HOP_SAMPLES = 875            # H = 3,5 detik (overlap 50 %)
HOP_SECONDS = HOP_SAMPLES / FS_ECG
ECG_COUNTS_PER_MV = 500      # skala int16 sinyal bersih (1 mV = 500 count)

FS_ACCEL = 100               # Hz, MPU6050 (BAB 8.6)
VITAL_PERIOD_S = 1.0         # topik vital tiap 1 detik (Tabel topik MQTT BAB 8)

# ---------------------------------------------------------------------------
# Kelas keluaran CNN 1D (BAB 4.4, BAB 10.4)
# ---------------------------------------------------------------------------
CLASSES = ["Normal", "Pra-Serangan", "Serangan"]
CLS_NORMAL, CLS_PRE, CLS_ATTACK = 0, 1, 2

# ---------------------------------------------------------------------------
# Decision engine / FSM (BAB 4.5, BAB 5.5)
# ---------------------------------------------------------------------------
STATE_NORMAL = "NORMAL"      # S1
STATE_WARNING = "WARNING"    # S2
STATE_CRITICAL = "CRITICAL"  # S3 (latching)
STATES = [STATE_NORMAL, STATE_WARNING, STATE_CRITICAL]

TAU_CONF = env_float("TAU_CONF", 0.44)          # hasil kalibrasi validasi (cloud/model/kalibrasi_tau.py); BAB 4.4.4 target awal 0,70–0,85
# tau adaptif gerak: saat IMU mendeteksi aktivitas, artefak gerak mudah terbaca sebagai pola abnormal,
# sehingga ambang dinaikkan (hasil kalibrasi artefak, cloud/model/kalibrasi_tau.py tahap 3)
TAU_CONF_MOTION = env_float("TAU_CONF_MOTION", 0.76)
TAU_WARN = env_float("TAU_WARN", 0.80)
MOTION_SD_G = env_float("MOTION_SD_G", 0.08)    # simpangan baku |a| per detik (g) yang dianggap "bergerak"
MOTION_WINDOW_S = env_int("MOTION_WINDOW_S", 7) # rentang vital yang diperiksa = panjang window ECG
# Reset alarm CRITICAL dari aplikasi web. 1 = tombol web boleh membersihkan latch CRITICAL (selain tombol fisik);
# 0 = perilaku proposal murni: hanya tombol fisik di alat yang bisa menghentikan CRITICAL.
REMOTE_RESET = env_int("REMOTE_RESET", 1)
REMOTE_CLEAR_RETRY_S = env_int("REMOTE_CLEAR_RETRY_S", 5)
REMOTE_CLEAR_GIVEUP_S = env_int("REMOTE_CLEAR_GIVEUP_S", 120)
PERSIST_N = env_int("PERSIST_N", 2)             # N window non-Normal -> Warning
# Opsional: persistence khusus bila window terakhir berkelas Pra-Serangan (iskemia/AF tidak berubah fatal
# dalam hitungan detik, sedangkan pemicu alarm palsu terbanyak di data wearable berasal dari kelas ini).
# 0 = sama dengan PERSIST_N (perilaku asli). Pilih nilainya dengan tools/kalibrasi_lapangan.py.
PERSIST_N_PRE = env_int("PERSIST_N_PRE", 0)
PERSIST_N_DEGRADED = env_int("PERSIST_N_DEGRADED", 3)  # mode validator terdegradasi
HYSTERESIS_M = env_int("HYSTERESIS_M", 1)       # N+M window Normal -> kembali S1

HR_HIGH = env_float("HR_HIGH", 120.0)           # tau_HR^high (bpm)
HR_LOW = env_float("HR_LOW", 40.0)              # tau_HR^low (bpm)
GSR_ABS_HIGH = env_float("GSR_ABS_HIGH", 20.0)  # tau_GSR^high (uS) = batas aman
GSR_K = env_float("GSR_K", 2.5)                 # koefisien k pada mu + k*sigma
GSR_MIN_MARGIN = env_float("GSR_MIN_MARGIN", 3.0)  # jarak minimum ambang dari mu (uS)
CALIB_SECONDS = env_int("CALIB_SECONDS", 30)    # sesi kalibrasi baseline (dipersingkat utk demo)
TAU_SQI = env_float("TAU_SQI", 0.5)             # ambang indeks kualitas PPG

# Paket yang datang terlambat (hasil retransmisi buffer) tidak menggerakkan FSM
LATE_PACKET_S = env_float("LATE_PACKET_S", 15.0)

# ---------------------------------------------------------------------------
# Fall detection tiga fase (BAB 4.6, BAB 8.6)
# ---------------------------------------------------------------------------
FALL_FREEFALL_G = 0.5
FALL_FREEFALL_MIN_MS = 70
FALL_FREEFALL_MAX_MS = 300
FALL_IMPACT_G = 2.5
FALL_IMPACT_WINDOW_MS = 150
FALL_STILL_TOL_G = 0.3
FALL_STILL_MIN_S = 2.0
FALL_FLAG_HOLD_S = 60.0      # lama flag jatuh dipertahankan di payload

# ---------------------------------------------------------------------------
# Komunikasi & fail-safe (BAB 5.4, BAB 6.2, BAB 8.2)
# ---------------------------------------------------------------------------
OFFLINE_BUFFER_MINUTES = 10  # >= 10 menit buffering lokal
SMS_FALLBACK_AFTER_S = 30    # SMS darurat bila Critical & offline > 30 s

# ---------------------------------------------------------------------------
# GPS (BAB 6.2): sekitar DTETI FT UGM, Jl. Grafika No. 2, Yogyakarta
# ---------------------------------------------------------------------------
GPS_HOME_LAT = env_float("GPS_LAT", -7.765500)
GPS_HOME_LON = env_float("GPS_LON", 110.371900)
GPS_TTFF_MIN_S = 12
GPS_TTFF_MAX_S = 40          # spesifikasi cold start <= 60 s

# ---------------------------------------------------------------------------
# Koneksi
# ---------------------------------------------------------------------------
MQTT_HOST = env_str("MQTT_HOST", "localhost")
MQTT_PORT = env_int("MQTT_PORT", 1883)
DEVICE_ID = env_str("DEVICE_ID", "cv-001")
USER_ID = env_str("USER_ID", "user-001")

# F-BE-4: retensi data mentah (ECG, vital, inferensi). 0 = simpan selamanya. Nilai di bawah 30 dinaikkan
# ke 30 karena laporan mensyaratkan retensi minimal 30 hari. Event, transisi, dan log notifikasi tidak
# pernah dihapus, begitu juga ECG di sekitar setiap event.
RETENSI_HARI = env_int("RETENSI_HARI", 0)
if 0 < RETENSI_HARI < 30:
    RETENSI_HARI = 30
