"""Layanan inferensi CNN 1D (BAB 8.6 'Algoritma Inferensi CNN 1D').

1. terima window W sampel  2. normalisasi Z-score per window  3. reshape [1, W, 1]
4. forward pass  5. softmax 3 kelas  6. c = argmax, p_conf = max
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

import numpy as np

log = logging.getLogger("inferensi")

DEFAULT_MODEL = Path(__file__).resolve().parents[1] / "model" / "artifacts" / "cnn1d_ecg.keras"


class CnnInference:
    def __init__(self, model_path: str | os.PathLike | None = None):
        path = Path(model_path or os.getenv("MODEL_PATH") or DEFAULT_MODEL)
        if not path.exists():
            raise FileNotFoundError(
                f"model tidak ditemukan: {path}. Latih dulu: python cloud/model/train_real.py (lihat README bagian 6)")
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
        import tensorflow as tf  # impor lambat agar modul lain tetap ringan

        tf.config.threading.set_intra_op_parallelism_threads(2)
        tf.config.threading.set_inter_op_parallelism_threads(1)
        self.model = tf.keras.models.load_model(path, compile=False)
        self._fn = tf.function(lambda x: self.model(x, training=False))
        self.path = path
        self.predict(np.zeros(self.model.input_shape[1], dtype=np.float32))  # warm-up
        log.info("model dimuat: %s (%d parameter)", path.name, self.model.count_params())

    @staticmethod
    def zscore(x: np.ndarray) -> np.ndarray:
        x = x.astype(np.float32)
        return (x - x.mean()) / (x.std() + 1e-8)

    def predict(self, window: np.ndarray) -> tuple[int, float, list[float], float]:
        """Kembalikan (kelas, p_conf, probabilitas, latensi_ms)."""
        t0 = time.perf_counter()
        x = self.zscore(window)[None, :, None]
        probs = np.asarray(self._fn(x))[0]
        ms = (time.perf_counter() - t0) * 1000
        c = int(probs.argmax())
        return c, float(probs[c]), [round(float(p), 4) for p in probs], round(ms, 2)
