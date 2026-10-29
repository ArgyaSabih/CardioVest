// EKG sintetis untuk mode demo (Lead I, mV, 250 sampel/detik). Setiap denyut adalah jumlah gelombang
// Gauss P-Q-R-S-T, dengan variasi kecil antardenyut, derau, dan goyangan garis dasar. Bentuknya
// mengikuti tiga kelas model: Normal, Pra-serangan (depresi ST + T datar), dan Serangan (elevasi ST).
export const FS = 250;

const WAVES = {
  normal: [[-0.2, 0.025, 0.13], [-0.035, 0.009, -0.09], [0, 0.011, 1.05], [0.035, 0.01, -0.22], [0.25, 0.045, 0.3]],
  pre: [[-0.2, 0.025, 0.12], [-0.035, 0.009, -0.08], [0, 0.011, 0.95], [0.035, 0.01, -0.2], [0.12, 0.05, -0.08], [0.27, 0.05, 0.06]],
  attack: [[-0.19, 0.025, 0.1], [-0.033, 0.01, -0.06], [0, 0.012, 0.9], [0.04, 0.012, -0.12], [0.13, 0.06, 0.32], [0.26, 0.05, 0.36]],
};

/** Pembangkit acak dengan benih, supaya rekaman kejadian lama selalu sama setiap dibuka. */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Aliran EKG yang terus berjalan. next(n) mengembalikan n sampel berikutnya; bentuk dan denyut bisa
 * diganti kapan saja lewat set(kind, hr).
 */
export function ecgStream(seed = 7) {
  const rand = rng(seed);
  let kind = 'normal';
  let hr = 72;
  let t = 0;            // detik sejak mulai
  let beatAt = 0.3;     // waktu puncak R berikutnya
  let lastBeat = -1;
  const gauss = () => (rand() + rand() + rand() - 1.5) * 0.8;
  const sample = () => {
    if (t >= beatAt + 0.4) {
      lastBeat = beatAt;
      beatAt += (60 / hr) * (1 + gauss() * 0.04);
    }
    let v = 0;
    for (const R of [lastBeat, beatAt]) {
      if (R < 0) continue;
      for (const [dt, w, a] of WAVES[kind]) {
        const x = t - (R + dt);
        v += a * Math.exp(-(x * x) / (2 * w * w));
      }
    }
    v += 0.04 * Math.sin(2 * Math.PI * 0.27 * t) + gauss() * 0.018;
    t += 1 / FS;
    return Math.round(v * 1000) / 1000;
  };
  return {
    set(k, h) {
      kind = k;
      hr = h;
    },
    next(n) {
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = sample();
      return out;
    },
  };
}

/** Rekaman 40 detik untuk detail kejadian: 20 detik sebelum dan 20 detik sesudah awal kejadian. */
export function eventStrip(seed, before, after) {
  const s = ecgStream(seed);
  s.set(before.kind, before.hr);
  const a = s.next(20 * FS);
  s.set(after.kind, after.hr);
  return a.concat(s.next(20 * FS));
}
