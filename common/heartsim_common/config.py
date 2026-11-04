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


FS_ECG = 250
WINDOW_SAMPLES = 1750
HOP_SAMPLES = 875
HOP_SECONDS = HOP_SAMPLES / FS_ECG
ECG_COUNTS_PER_MV = 500

FS_ACCEL = 100
VITAL_PERIOD_S = 1.0

CLASSES = ["Normal", "Pra-Serangan", "Serangan"]
CLS_NORMAL, CLS_PRE, CLS_ATTACK = 0, 1, 2

STATE_NORMAL = "NORMAL"
STATE_WARNING = "WARNING"
STATE_CRITICAL = "CRITICAL"
STATES = [STATE_NORMAL, STATE_WARNING, STATE_CRITICAL]

MODE_DEMO = "demo"
MODE_TEST = "test"
MODES = [MODE_DEMO, MODE_TEST]
MODE_RETRY_S = env_int("MODE_RETRY_S", 5)
MODE_GIVEUP_S = env_int("MODE_GIVEUP_S", 60)

TAU_CONF = env_float("TAU_CONF", 0.44)
TAU_CONF_MOTION = env_float("TAU_CONF_MOTION", 0.76)
TAU_WARN = env_float("TAU_WARN", 0.80)
MOTION_SD_G = env_float("MOTION_SD_G", 0.08)
MOTION_WINDOW_S = env_int("MOTION_WINDOW_S", 7)
REMOTE_RESET = env_int("REMOTE_RESET", 1)
REMOTE_CLEAR_RETRY_S = env_int("REMOTE_CLEAR_RETRY_S", 5)
REMOTE_CLEAR_GIVEUP_S = env_int("REMOTE_CLEAR_GIVEUP_S", 120)
PERSIST_N = env_int("PERSIST_N", 2)
PERSIST_N_PRE = env_int("PERSIST_N_PRE", 0)
PERSIST_N_DEGRADED = env_int("PERSIST_N_DEGRADED", 3)
HYSTERESIS_M = env_int("HYSTERESIS_M", 1)

HR_HIGH = env_float("HR_HIGH", 120.0)
HR_LOW = env_float("HR_LOW", 40.0)
GSR_ABS_HIGH = env_float("GSR_ABS_HIGH", 20.0)
GSR_K = env_float("GSR_K", 2.5)
GSR_MIN_MARGIN = env_float("GSR_MIN_MARGIN", 3.0)
CALIB_SECONDS = env_int("CALIB_SECONDS", 30)
TAU_SQI = env_float("TAU_SQI", 0.5)
SPO2_LOW = env_float("SPO2_LOW", 90.0)
GSR_CALIB_RETRY_S = env_int("GSR_CALIB_RETRY_S", 60)
GSR_CALIB_GAP_S = env_float("GSR_CALIB_GAP_S", 5.0)

REKAMAN_STATE = {
    "normal": STATE_NORMAL,
    "st_depression": STATE_WARNING,
    "af": STATE_WARNING,
    "pvc": STATE_WARNING,
    "cd": STATE_WARNING,
    "svt": STATE_WARNING,
    "stemi": STATE_CRITICAL,
    "vt": STATE_CRITICAL,
    "vf": STATE_CRITICAL,
}

LATE_PACKET_S = env_float("LATE_PACKET_S", 15.0)

FALL_FREEFALL_G = 0.5
FALL_FREEFALL_MIN_MS = 70
FALL_FREEFALL_MAX_MS = 300
FALL_IMPACT_G = 2.5
FALL_IMPACT_WINDOW_MS = 150
FALL_STILL_TOL_G = 0.3
FALL_STILL_MIN_S = 2.0
FALL_FLAG_HOLD_S = 60.0

OFFLINE_BUFFER_MINUTES = 10
SMS_FALLBACK_AFTER_S = 30

GPS_HOME_LAT = env_float("GPS_LAT", -7.765501)
GPS_HOME_LON = env_float("GPS_LON", 110.372210)
GPS_TTFF_MIN_S = 12
GPS_TTFF_MAX_S = 40

MQTT_HOST = env_str("MQTT_HOST", "localhost")
MQTT_PORT = env_int("MQTT_PORT", 1883)
DEVICE_ID = env_str("DEVICE_ID", "cv-001")
USER_ID = env_str("USER_ID", "user-001")

RETENSI_HARI = env_int("RETENSI_HARI", 0)
if 0 < RETENSI_HARI < 30:
    RETENSI_HARI = 30
