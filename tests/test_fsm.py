from cloud.decision_engine import DecisionEngine, ValidatorState
from heartsim_common import config as C

N, P, A = C.CLS_NORMAL, C.CLS_PRE, C.CLS_ATTACK


def run(engine, seq, gsr=False, hr=False, degraded=False, conf=0.95, spo2=False):
    return [engine.step(c, conf, gsr, hr, degraded, ind_spo2=spo2) for c in seq]


def test_tc01_normal_stays_normal():
    e = DecisionEngine()
    run(e, [N] * 20)
    assert e.state == C.STATE_NORMAL


def test_tc02_hr_artifact_only_stays_normal():
    e = DecisionEngine()
    run(e, [N] * 10, gsr=False, hr=True)
    assert e.state == C.STATE_NORMAL


def test_single_anomaly_filtered_by_persistence():
    e = DecisionEngine()
    run(e, [N, P, N, A, N])
    assert e.state == C.STATE_NORMAL


def test_warning_after_n_then_hysteresis():
    e = DecisionEngine()
    d = run(e, [P, P])
    assert d[-1].changed and e.state == C.STATE_WARNING
    run(e, [N, N])
    assert e.state == C.STATE_WARNING
    run(e, [N])
    assert e.state == C.STATE_NORMAL


def test_degraded_needs_three_windows():
    e = DecisionEngine()
    run(e, [P, P], degraded=True)
    assert e.state == C.STATE_NORMAL
    run(e, [P], degraded=True)
    assert e.state == C.STATE_WARNING


def test_tc03_attack_with_validators_goes_critical_and_latches():
    e = DecisionEngine()
    run(e, [A, A], gsr=True, hr=True, spo2=True)
    assert e.state == C.STATE_CRITICAL
    run(e, [N] * 10)
    assert e.state == C.STATE_CRITICAL
    d = e.hardware_reset()
    assert d.changed and e.state == C.STATE_NORMAL


def test_attack_without_validators_only_warning():
    e = DecisionEngine()
    run(e, [A, A], gsr=True, hr=False, spo2=True)
    assert e.state == C.STATE_WARNING
    run(e, [A], gsr=True, hr=True, spo2=True)
    assert e.state == C.STATE_CRITICAL


def test_low_confidence_is_undecided():
    e = DecisionEngine()
    d = run(e, [A, A, A], gsr=True, hr=True, conf=e.tau_conf - 0.01)
    assert all(not x.accepted for x in d) and e.state == C.STATE_NORMAL


def test_low_confidence_abnormal_does_not_warn():
    e = DecisionEngine()
    d = run(e, [P, P, P, A, A], conf=e.tau_warn - 0.01)
    assert all(not x.accepted for x in d) and e.state == C.STATE_NORMAL
    run(e, [P, P], conf=e.tau_warn)
    assert e.state == C.STATE_WARNING


def test_reset_clears_warning():
    e = DecisionEngine()
    run(e, [P, P])
    assert e.state == C.STATE_WARNING
    d = e.hardware_reset()
    assert d.changed and e.state == C.STATE_NORMAL


def test_reset_in_normal_only_clears_counters():
    e = DecisionEngine()
    run(e, [P])
    d = e.hardware_reset()
    assert not d.changed and e.state == C.STATE_NORMAL and e.consec_non_normal == 0


def test_gsr_calibration_threshold():
    v = ValidatorState(calib_seconds=10, k=2.5)
    for i in range(12):
        v.add({"ts": i * 1000, "gsr": 5.0 + (0.1 if i % 2 else -0.1), "hr": 70, "hr_source": "PPG"},
              C.STATE_NORMAL)
    assert v.calibrated
    assert abs(v.gsr_threshold - (5.0 + C.GSR_MIN_MARGIN)) < 0.05
    v.add({"ts": 13000, "gsr": 21, "hr": 130, "hr_source": "PPG"}, C.STATE_NORMAL)
    v.add({"ts": 14000, "gsr": 22, "hr": 131, "hr_source": "PPG"}, C.STATE_NORMAL)
    s = v.evaluate()
    assert s.ind_gsr and s.ind_hr and not s.degraded


def test_motion_raises_tau():
    p = (C.TAU_CONF + C.TAU_CONF_MOTION) / 2
    rest = DecisionEngine(tau_warn=C.TAU_CONF)
    for _ in range(3):
        rest.step(A, p, False, True, True, motion=False)
    assert rest.state == C.STATE_WARNING
    moving = DecisionEngine(tau_warn=C.TAU_CONF)
    d = [moving.step(A, p, False, True, True, motion=True) for _ in range(3)]
    assert moving.state == C.STATE_NORMAL and not any(x.accepted for x in d)
    assert "tau_gerak" in d[-1].reason


def test_motion_high_confidence_still_escalates():
    e = DecisionEngine()
    for _ in range(3):
        e.step(A, 0.95, True, True, True, motion=True, ind_spo2=True)
    assert e.state == C.STATE_CRITICAL


def _vital(ts, sd=None, mag=1.0):
    acc = {"x": 0.0, "y": 0.0, "z": mag, "mag": mag}
    if sd is not None:
        acc["sd"] = sd
    return {"ts": ts, "hr": 75, "hr_source": "PPG", "sqi": 0.9, "gsr": 5.0, "accel": acc}


def test_activity_from_accel_sd():
    v = ValidatorState()
    for i in range(7):
        v.add(_vital(i * 1000, sd=0.012), C.STATE_NORMAL)
    assert not v.evaluate().motion
    for i in range(7, 14):
        v.add(_vital(i * 1000, sd=0.21), C.STATE_NORMAL)
    s = v.evaluate()
    assert s.motion and s.activity_g > C.MOTION_SD_G


def test_activity_fallback_without_sd():
    v = ValidatorState()
    for i, mag in enumerate([1.0, 1.3, 0.7, 1.25, 0.75, 1.3, 0.7]):
        v.add(_vital(i * 1000, mag=mag), C.STATE_NORMAL)
    assert v.evaluate().motion


def test_single_fall_spike_is_not_motion():
    v = ValidatorState()
    for i, sd in enumerate([0.01, 0.01, 0.01, 0.9, 0.01, 0.01, 0.01]):
        v.add(_vital(i * 1000, sd=sd), C.STATE_NORMAL)
    assert not v.evaluate().motion


def test_n_pre_default_keeps_original_behaviour():
    e = DecisionEngine(n=2)
    for _ in range(2):
        d = e.step(C.CLS_PRE, 0.9, False, False)
    assert d.state == C.STATE_WARNING


def test_n_pre_delays_only_pre_attack_class():
    e = DecisionEngine(n=2, n_pre=4)
    states = [e.step(C.CLS_PRE, 0.9, False, False).state for _ in range(4)]
    assert states == [C.STATE_NORMAL] * 3 + [C.STATE_WARNING]
    e2 = DecisionEngine(n=2, n_pre=4)
    for _ in range(2):
        d = e2.step(C.CLS_ATTACK, 0.9, True, True, ind_spo2=True)
    assert d.state == C.STATE_CRITICAL


def test_gate_needs_hr_gsr_and_spo2():
    e = DecisionEngine()
    for _ in range(3):
        e.step(A, 0.95, False, True, ind_spo2=True)
    assert e.state == C.STATE_WARNING
    e.step(A, 0.95, True, True, ind_spo2=False)
    assert e.state == C.STATE_WARNING
    d = e.step(A, 0.95, True, True, ind_spo2=True)
    assert d.state == C.STATE_CRITICAL


def test_spo2_low_without_hr_stays_warning():
    e = DecisionEngine()
    for _ in range(3):
        e.step(A, 0.95, True, False, ind_spo2=True)
    assert e.state == C.STATE_WARNING


def test_spo2_indicator_from_vitals():
    v = ValidatorState()
    for i, s in enumerate([97.0, 88.0, 87.5, 88.5]):
        v.add({"ts": i * 1000, "hr": 80, "hr_source": "PPG", "spo2": s, "ppg_on": True}, C.STATE_WARNING)
    snap = v.evaluate()
    assert snap.spo2 == 88.0 and snap.ind_spo2


def test_ppg_switched_off_is_not_degraded():
    v = ValidatorState()
    v.add({"ts": 0, "hr": 80, "hr_source": "ECG", "ppg_on": False}, C.STATE_NORMAL)
    assert not v.evaluate().degraded
    v.add({"ts": 1000, "hr": 80, "hr_source": "ECG", "ppg_on": True}, C.STATE_NORMAL)
    assert v.evaluate().degraded


def test_gsr_calibration_restarts_after_gap():
    v = ValidatorState(calib_seconds=10)
    for i in range(5):
        v.add({"ts": i * 1000, "gsr": 5.0}, C.STATE_NORMAL)
    for i in range(30, 39):
        v.add({"ts": i * 1000, "gsr": 6.0}, C.STATE_NORMAL)
    assert not v.calibrated
    v.add({"ts": 40_000, "gsr": 6.0}, C.STATE_NORMAL)
    assert v.calibrated and abs(v.mu - 6.0) < 1e-9


def test_boot_reset_clears_warning():
    e = DecisionEngine()
    run(e, [P, P])
    d = e.hardware_reset(boot=True)
    assert d.changed and e.state == C.STATE_NORMAL and "dinyalakan ulang" in d.reason
