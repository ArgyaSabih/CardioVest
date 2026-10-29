from __future__ import annotations

import logging
import os
import time
from pathlib import Path

import numpy as np

log = logging.getLogger("inferensi")

ARTIFACTS = Path(__file__).resolve().parents[1] / "model" / "artifacts"
DEFAULT_MODEL = ARTIFACTS / "cnn1d_ecg.onnx"


class _Onnx:
    def __init__(self, path: Path):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = int(os.getenv("INFER_THREADS", "2"))
        opts.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])
        inp = self.sess.get_inputs()[0]
        self.name = inp.name
        self.n_in = int(inp.shape[1])

    def __call__(self, x: np.ndarray) -> np.ndarray:
        return self.sess.run(None, {self.name: x})[0]


class _Keras:
    def __init__(self, path: Path):
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
        import tensorflow as tf

        tf.config.threading.set_intra_op_parallelism_threads(2)
        tf.config.threading.set_inter_op_parallelism_threads(1)
        model = tf.keras.models.load_model(path, compile=False)
        self._fn = tf.function(lambda x: model(x, training=False))
        self.n_in = int(model.input_shape[1])

    def __call__(self, x: np.ndarray) -> np.ndarray:
        return np.asarray(self._fn(x))


class CnnInference:
    def __init__(self, model_path: str | os.PathLike | None = None):
        path = Path(model_path or os.getenv("MODEL_PATH") or DEFAULT_MODEL)
        if not path.exists():
            raise FileNotFoundError(f"model tidak ditemukan: {path}")
        self.backend = _Onnx(path) if path.suffix == ".onnx" else _Keras(path)
        self.path = path
        self.predict(np.zeros(self.backend.n_in, dtype=np.float32))
        log.info("model dimuat: %s (%s)", path.name, type(self.backend).__name__.strip("_"))

    @staticmethod
    def zscore(x: np.ndarray) -> np.ndarray:
        x = x.astype(np.float32)
        return (x - x.mean()) / (x.std() + 1e-8)

    def predict(self, window: np.ndarray) -> tuple[int, float, list[float], float]:
        t0 = time.perf_counter()
        x = self.zscore(window)[None, :, None]
        probs = self.backend(x)[0]
        ms = (time.perf_counter() - t0) * 1000
        c = int(probs.argmax())
        return c, float(probs[c]), [round(float(p), 4) for p in probs], round(ms, 2)
