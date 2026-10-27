"""Ekspor model ke format luaran L2 laporan (.h5 dan .onnx) dan pastikan keluarannya identik.

    pip install tf2onnx onnxruntime        # sekali; tidak dibutuhkan layanan cloud
    python cloud/model/ekspor_model.py

Hasil di cloud/model/artifacts/:
  cnn1d_ecg.h5     format HDF5 Keras (bisa dibuka TensorFlow/Keras versi lama)
  cnn1d_ecg.onnx   format ONNX (bisa dijalankan ONNX Runtime di server tanpa TensorFlow)
  ekspor_model.json  ringkasan arsitektur + selisih keluaran antarformat pada data uji

Layanan cloud tetap memakai cnn1d_ecg.keras; dua berkas ini untuk portabilitas dan dokumentasi.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
import tensorflow as tf  # noqa: E402

HERE = Path(__file__).resolve().parent
ART = HERE / "artifacts"
ROOT = HERE.parents[1]


def main() -> None:
    src = ART / "cnn1d_ecg.keras"
    model = tf.keras.models.load_model(src, compile=False)
    n_in = model.input_shape[1]

    # data pembanding: window bank replay (rekaman asli), Z-score seperti di layanan inferensi
    bank = np.load(ROOT / "simulator" / "simulator" / "replay_bank.npz")
    x = bank["X"][:256, :n_in].astype(np.float32)
    x = ((x - x.mean(1, keepdims=True)) / (x.std(1, keepdims=True) + 1e-8))[..., None]
    ref = model.predict(x, verbose=0)

    h5 = ART / "cnn1d_ecg.h5"
    model.save(h5)
    p_h5 = tf.keras.models.load_model(h5, compile=False).predict(x, verbose=0)

    out = {"sumber": src.name, "parameter": int(model.count_params()), "input": [None, n_in, 1],
           "lapisan": [{"nama": l.name, "jenis": l.__class__.__name__,
                        **({"filter": l.filters, "kernel": l.kernel_size[0]} if hasattr(l, "filters") else {}),
                        **({"unit": l.units} if hasattr(l, "units") else {}),
                        **({"rate": l.rate} if hasattr(l, "rate") else {})} for l in model.layers],
           "h5": {"berkas": h5.name, "selisih_maks": float(np.abs(p_h5 - ref).max())}}

    try:
        import onnxruntime as ort
        import tf2onnx
        onx = ART / "cnn1d_ecg.onnx"
        spec = (tf.TensorSpec((None, n_in, 1), tf.float32, name="ecg"),)
        fn = tf.function(lambda t: model(t, training=False), input_signature=spec)
        tf2onnx.convert.from_function(fn, input_signature=spec, opset=17, output_path=str(onx))
        sess = ort.InferenceSession(str(onx), providers=["CPUExecutionProvider"])
        p_onnx = sess.run(None, {sess.get_inputs()[0].name: x})[0]
        out["onnx"] = {"berkas": onx.name, "opset": 17, "selisih_maks": float(np.abs(p_onnx - ref).max()),
                       "kelas_sama": float(np.mean(p_onnx.argmax(1) == ref.argmax(1)))}
    except ImportError as e:
        out["onnx"] = {"dilewati": f"{e.name} belum terpasang (pip install tf2onnx onnxruntime)"}

    (ART / "ekspor_model.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(json.dumps({k: v for k, v in out.items() if k != "lapisan"}, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
