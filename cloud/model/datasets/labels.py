"""Pemetaan label PTB-XL dan MIT-BIH ke tiga kelas operasional (BAB 10.4).

  0 Normal       : ritme sinus normal, tanpa temuan diagnostik lain
  1 Pra-Serangan : aritmia supraventrikular, kontraksi prematur, blok konduksi,
                   perubahan ST/T (iskemia, depresi ST, T terbalik)
  2 Serangan     : infark miokard (PTB-XL superclass MI, pola injury / elevasi ST),
                   takikardia ventrikular, fibrilasi/flutter ventrikular (MIT-BIH)

Selain kelas, setiap sampel diberi TAG morfologi yang sama dengan nama jenis rekaman dataset
('normal', 'st_depression', 'af', 'pvc', 'cd', 'svt', 'stemi', 'vt', 'vf') agar bank replay
pemutar dataset dapat memilih rekaman sesuai jenis yang diminta.

Keterbatasan yang wajib dicatat di laporan:
  * PTB-XL tidak membedakan infark akut dan infark lama (kode AMI = anterior MI, bukan "acute").
    Kelas Serangan dari PTB-XL karenanya berarti "pola infark", bukan onset serangan.
  * MIT-BIH direkam pada lead MLII, sedangkan perangkat memakai Lead I.
"""
from __future__ import annotations

import ast

CLASS_NAMES = ["Normal", "Pra-Serangan", "Serangan"]

# ------------------------------------------------------------------ PTB-XL
PTB_ATTACK_EXTRA = {"STE_", "INJAS", "INJAL", "INJIN", "INJLA", "INJIL"}
PTB_PRE_RHYTHM = {"AFIB": "af", "AFLT": "af", "SVTAC": "svt", "PSVT": "svt", "SVARR": "svt",
                  "BIGU": "pvc", "TRIGU": "pvc"}
PTB_PRE_FORM = {"PVC": "pvc", "STD_": "st_depression", "INVT": "st_depression",
                "NST_": "st_depression", "TAB_": "st_depression", "NDT": "st_depression"}
PTB_NORMAL_RHYTHM = {"SR", "SARRH", "SBRAD"}
PTB_EXCLUDE = {"PACE"}
MIN_LIKELIHOOD = 50   # untuk pernyataan diagnostik (nilai 0 dipakai pada kode ritme/bentuk)


def ptbxl_label(scp_codes: str | dict, diag_class: dict[str, str]) -> tuple[int, str] | None:
    """Kembalikan (kelas, tag) untuk satu rekaman PTB-XL atau None bila dikecualikan.

    diag_class: kode SCP -> diagnostic_class (NORM/MI/STTC/CD/HYP) dari scp_statements.csv
    """
    codes = ast.literal_eval(scp_codes) if isinstance(scp_codes, str) else scp_codes
    if PTB_EXCLUDE & codes.keys():
        return None
    diag = {c for c, lk in codes.items()
            if c in diag_class and (lk >= MIN_LIKELIHOOD or lk == 0)}   # 0 = tidak dinyatakan
    classes = {diag_class[c] for c in diag}

    if "MI" in classes or PTB_ATTACK_EXTRA & codes.keys():
        return 2, "stemi"
    for c, tag in PTB_PRE_RHYTHM.items():
        if c in codes:
            return 1, tag
    for c, tag in PTB_PRE_FORM.items():
        if c in codes:
            return 1, tag
    if "STTC" in classes:
        return 1, "st_depression"
    if "CD" in classes:
        return 1, "cd"
    rhythm = {c for c in codes if c.isupper() and c in PTB_NORMAL_RHYTHM}
    if classes == {"NORM"} and codes.get("NORM", 0) >= 80 and rhythm and \
            not (set(codes) - {"NORM"} - PTB_NORMAL_RHYTHM):
        return 0, "normal"
    return None


# ------------------------------------------------------------------ MIT-BIH
MIT_PACED = {"102", "104", "107", "217"}
MIT_SAME_SUBJECT = {"202": "201"}           # 201 dan 202 berasal dari subjek yang sama
MIT_RHYTHM_ATTACK = {"(VT": "vt", "(VFL": "vf"}
MIT_RHYTHM_PRE = {"(AFIB": "af", "(AFL": "af", "(SVTA": "svt", "(B": "pvc", "(T": "pvc",
                  "(NOD": "svt", "(AB": "svt", "(BII": "cd", "(IVR": "pvc", "(PREX": "cd"}
BEAT_VENTRICULAR = {"V", "F", "E", "!"}
BEAT_SUPRAVENTRICULAR = {"A", "a", "J", "S", "j", "e"}
BEAT_BBB = {"L", "R", "B"}


def mitdb_window_label(rhythm_cover: dict[str, float], beats: list[str]) -> tuple[int, str] | None:
    """Label satu window MIT-BIH dari proporsi ritme dan simbol beat di dalamnya."""
    for r, tag in MIT_RHYTHM_ATTACK.items():
        if rhythm_cover.get(r, 0) >= 0.5:
            return 2, tag
    for r, tag in MIT_RHYTHM_PRE.items():
        if rhythm_cover.get(r, 0) >= 0.5:
            return 1, tag
    if rhythm_cover.get("(N", 0) < 0.999 or not beats:
        return None
    if sum(b in BEAT_VENTRICULAR for b in beats) >= 2:
        return 1, "pvc"
    if sum(b in BEAT_SUPRAVENTRICULAR for b in beats) >= 2:
        return 1, "svt"
    if sum(b in BEAT_BBB for b in beats) > len(beats) / 2:
        return 1, "cd"
    if all(b == "N" for b in beats):
        return 0, "normal"
    return None
