from cloud.decision_engine import DecisionEngine, ValidatorState
from heartsim_common import config as C

N, P, A = C.CLS_NORMAL, C.CLS_PRE, C.CLS_ATTACK


def run(engine, seq, gsr=False, hr=False, degraded=False, conf=0.95):
    return [engine.step(c, conf, gsr, hr, degraded) for c in seq]


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
    assert e.state == C.STATE_WARNING          # N+M = 3 belum terpenuhi
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
    run(e, [A, A], gsr=True, hr=True)
    assert e.state == C.STATE_CRITICAL
    run(e, [N] * 10)
    assert e.state == C.STATE_CRITICAL         # latching
    d = e.hardware_reset()
    assert d.changed and e.state == C.STATE_NORMAL


def test_attack_without_validators_only_warning():
    e = DecisionEngine()
    run(e, [A, A], gsr=True, hr=False)
    assert e.state == C.STATE_WARNING
    run(e, [A], gsr=True, hr=True)
    assert e.state == C.STATE_CRITICAL


def test_low_confidence_is_undecided():
    e = DecisionEngine()
    d = run(e, [A, A, A], gsr=True, hr=True, conf=e.tau_conf - 0.01)
    assert all(not x.accepted for x in d) and e.state == C.STATE_NORMAL


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


# ------------------------------------------------------------------ tau adaptif gerak
def test_motion_raises_tau():
    """p_conf di antara tau_conf dan tau_gerak: diputuskan saat diam, tidak diputuskan saat bergerak."""
    p = (C.TAU_CONF + C.TAU_CONF_MOTION) / 2
    rest = DecisionEngine()
    for _ in range(3):
        rest.step(A, p, False, True, True, motion=False)
    assert rest.state == C.STATE_WARNING
    moving = DecisionEngine()
    d = [moving.step(A, p, False, True, True, motion=True) for _ in range(3)]
    assert moving.state == C.STATE_NORMAL and not any(x.accepted for x in d)
    assert "tau_gerak" in d[-1].reason


def test_motion_high_confidence_still_escalates():
    e = DecisionEngine()
    for _ in range(3):
        e.step(A, 0.95, True, True, True, motion=True)
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
    assert not v.evaluate().motion          # median: lonjakan jatuh sesaat tidak menaikkan tau


# ---------------------------------------------------------------- persistence per kelas (opsional)
def test_n_pre_default_keeps_original_behaviour():
    e = DecisionEngine(n=2)
    for _ in range(2):
        d = e.step(C.CLS_PRE, 0.9, False, False)
    assert d.state == C.STATE_WARNING


def test_n_pre_delays_only_pre_attack_class():
    e = DecisionEngine(n=2, n_pre=4)
    states = [e.step(C.CLS_PRE, 0.9, False, False).state for _ in range(4)]
    assert states == [C.STATE_NORMAL] * 3 + [C.STATE_WARNING]
    e2 = DecisionEngine(n=2, n_pre=4)                 # Serangan tetap cepat
    for _ in range(2):
        d = e2.step(C.CLS_ATTACK, 0.9, True, True)
    assert d.state == C.STATE_CRITICAL
