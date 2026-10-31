const FS = 250;
const MM_PER_S = 25;
const PX_PER_MM = 5;
const MIN_SECONDS = 3;
const MAX_SECONDS = 10;
const COUNTS_PER_MV = 500;
const GAINS = [10, 5, 2.5];
const MAX_BACKLOG = FS * 8;
const KEEP_BACKLOG = FS * 4;

export function decodeEcg(buf) {
  if ((buf[0] === 0x43 && buf[1] === 0x56) || (buf[0] === 0x48 && buf[1] === 0x57)) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const flags = dv.getUint8(3);
    const n = dv.getUint16(18);
    const out = new Int16Array(n);
    let pos = 20;
    if (n) {
      out[0] = dv.getInt16(pos);
      pos += 2;
    }
    for (let i = 1; i < n; i++) {
      const b = dv.getUint8(pos);
      let d;
      if (b === 0x80) {
        d = dv.getInt16(pos + 1);
        pos += 3;
      } else {
        d = dv.getInt8(pos);
        pos += 1;
      }
      out[i] = out[i - 1] + d;
    }
    return { samples: out, buffered: !!(flags & 1), format: "biner" };
  }
  const o = JSON.parse(new TextDecoder().decode(buf));
  return { samples: Int16Array.from(o.samples), buffered: !!o.buffered, format: "JSON" };
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createEcgStrip(canvas, { onScale } = {}) {
  const ctx = canvas.getContext("2d");
  let seconds = 0;
  let size = 0;
  let trace = new Float32Array(0);
  let head = 0;
  let queue = [];
  let last = performance.now();
  let baseline = NaN;
  let gain = 10;
  let grow = 0;
  let colors = {};

  const readColors = () => {
    colors = { minor: cssVar("--grid-minor"), major: cssVar("--grid-major"), trace: cssVar("--trace") };
  };
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const d = devicePixelRatio || 1;
    canvas.width = Math.round(r.width * d);
    canvas.height = Math.round(r.height * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const next = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(r.width / (MM_PER_S * PX_PER_MM)) || MIN_SECONDS));
    if (next !== seconds) {
      seconds = next;
      size = FS * seconds;
      trace = new Float32Array(size).fill(NaN);
      head = 0;
    }
  };
  new ResizeObserver(resize).observe(canvas);
  readColors();
  resize();

  function drawGrid(w, h, pxPerMm) {
    const cols = seconds * MM_PER_S;
    const rows = Math.ceil(h / pxPerMm / 2);
    const mid = h / 2;
    const line = (x0, y0, x1, y1) => {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    };
    for (const major of [false, true]) {
      if (!major && pxPerMm < 3) continue;
      ctx.beginPath();
      ctx.strokeStyle = major ? colors.major : colors.minor;
      ctx.lineWidth = major ? 1 : 0.6;
      for (let c = 0; c <= cols; c++) {
        if ((c % 5 === 0) !== major) continue;
        const x = Math.round(c * pxPerMm) + 0.5;
        line(x, 0, x, h);
      }
      for (let r = -rows; r <= rows; r++) {
        if ((Math.abs(r) % 5 === 0) !== major) continue;
        const y = Math.round(mid + r * pxPerMm) + 0.5;
        line(0, y, w, y);
      }
      ctx.stroke();
    }
  }

  function frame(now) {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (queue.length > MAX_BACKLOG) queue.splice(0, queue.length - KEEP_BACKLOG);
    let take = Math.round(dt * FS);
    while (take-- > 0 && queue.length) {
      trace[head] = queue.shift();
      head = (head + 1) % size;
    }
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const pxPerMm = w / (seconds * MM_PER_S);
    ctx.clearRect(0, 0, w, h);
    drawGrid(w, h, pxPerMm);
    const base = Number.isNaN(baseline) ? 0 : baseline;
    const y = (mv) => h / 2 - (mv - base) * gain * pxPerMm;
    const gap = Math.round(FS * 0.06);
    ctx.beginPath();
    ctx.strokeStyle = colors.trace;
    ctx.lineWidth = 1.7;
    ctx.lineJoin = "round";
    let pen = false;
    let tip = null;
    for (let i = 0; i < size; i++) {
      const v = trace[i];
      const ahead = (i - head + size) % size;
      if (Number.isNaN(v) || ahead < gap) {
        pen = false;
        continue;
      }
      const px = (i / size) * w;
      const py = y(v);
      if (pen) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      pen = true;
      if (i === (head - 1 + size) % size) tip = [px, py];
    }
    ctx.stroke();
    if (tip) {
      ctx.beginPath();
      ctx.fillStyle = colors.trace;
      ctx.arc(tip[0], tip[1], 3, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function fitGain(mv) {
    const sorted = Array.from(mv).sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.01)];
    const hi = sorted[Math.floor(sorted.length * 0.995)];
    const median = sorted[Math.floor(sorted.length / 2)];
    baseline = Number.isNaN(baseline) ? median : 0.8 * baseline + 0.2 * median;
    const pxPerMm = canvas.clientWidth / (seconds * MM_PER_S) || PX_PER_MM;
    const room = (canvas.clientHeight / pxPerMm) * 0.8;
    const span = 2 * Math.max(hi - baseline, baseline - lo, 0.05);
    const best = GAINS.find((g) => span * g <= room) ?? GAINS.at(-1);
    if (best < gain) {
      gain = best;
      grow = 0;
      onScale?.(gain);
    } else if (best > gain && ++grow >= 3) {
      gain = GAINS[GAINS.indexOf(gain) - 1] ?? gain;
      grow = 0;
      onScale?.(gain);
    } else if (best === gain) {
      grow = 0;
    }
  }

  return {
    push(samples) {
      const mv = Float32Array.from(samples, (c) => c / COUNTS_PER_MV);
      fitGain(mv);
      for (const v of mv) queue.push(v);
    },
    clear() {
      trace.fill(NaN);
      queue = [];
      head = 0;
      baseline = NaN;
    },
    refreshColors: readColors,
  };
}
