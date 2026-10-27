import numpy as np

from simulator.sensors import AccelSim, FallDetector


def _run(mode, fall=False, seconds=6):
    rng = np.random.default_rng(0)
    a, f = AccelSim(rng), FallDetector()
    a.mode = mode
    if fall:
        a.read(100)
        a.trigger_fall()
    hits = 0
    for _ in range(seconds * 10):
        hits += f.update(a.read(10))
    return hits


def test_fall_detected_once():
    assert _run("rest", fall=True) == 1


def test_walking_is_not_fall():
    assert _run("walk", seconds=30) == 0


def test_rest_is_not_fall():
    assert _run("rest", seconds=10) == 0
