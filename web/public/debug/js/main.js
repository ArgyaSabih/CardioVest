import { connect } from "./connection.js";
import { createControls } from "./controls.js";
import { createEcgStrip, decodeEcg } from "./ecg.js";
import { CLASSES, clock, EVENTS, MODES, num, rekamanLabels, STATES } from "./labels.js";
import { createLog } from "./log.js";
import { createMap } from "./map.js";
import { createPresence } from "./presence.js";

const qs = new URLSearchParams(location.search);
const DEVICE = qs.get("device") || "cv-001";
const BACKEND = (qs.get("backend") || window.CV_BACKEND || "https://cardiovest.onrender.com").replace(/\/$/, "");
const REKAMAN = rekamanLabels();
const $ = (id) => document.getElementById(id);

$("deviceId").textContent = DEVICE;

const SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const isDark = () =>
  document.documentElement.dataset.theme === "dark" ||
  (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
function renderTheme() {
  $("themeBtn").innerHTML = isDark() ? SUN : MOON;
  $("themeBtn").setAttribute("aria-label", isDark() ? "Pakai tema terang" : "Pakai tema gelap");
}

const log = createLog($("log"));
const map = createMap($("map"), $("mapEmpty"), $("gpsMeta"));
const strip = createEcgStrip($("ecg"), {
  onScale: (g) => {
    $("ecgScale").textContent = `25 mm/s, ${num(g, g % 1 ? 1 : 0)} mm/mV`;
  },
});
const controls = createControls({ labels: REKAMAN, onChange: () => running && pause() });

$("themeBtn").addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("cv-debug-theme", next);
  } catch (e) {}
  renderTheme();
  strip.refreshColors();
});
renderTheme();

let running = false;
let stateObj = null;
let prevState = null;
let deviceMode = null;
let lastSignalOk = null;
let clockWarned = false;
let lastFallTs = null;
let modeRequest = null;
let audio = null;
let fallTimer = null;
const traffic = [];

const set = (id, text) => {
  $(id).textContent = text;
};
const html = (id, markup) => {
  $(id).innerHTML = markup;
};
const chip = (text, attrs = "") => `<span class="chip" ${attrs}>${text}</span>`;

function duration(secs) {
  if (secs < 60) return `${secs} detik`;
  if (secs < 3600) return `${Math.floor(secs / 60)} menit`;
  return `${Math.floor(secs / 3600)} jam ${Math.floor((secs % 3600) / 60)} menit`;
}

function sourceLabel() {
  const a = controls.applied;
  return a.source === "dataset" ? `Dataset, ${REKAMAN[a.rekaman] ?? a.rekaman}` : "Hardware (ESP32)";
}

function renderSource() {
  const el = $("ecgSource");
  el.textContent = sourceLabel();
  el.dataset.dataset = String(controls.applied.source === "dataset");
}

function renderState() {
  if (!stateObj) return;
  const s = STATES[stateObj.state] ?? { word: stateObj.state, tone: "none" };
  $("status").dataset.tone = s.tone;
  set("stateWord", s.word);
  set("stateCode", `State FSM ${stateObj.state}`);
  const why = stateObj.reason || "tanpa keterangan.";
  set("stateReason", why[0].toUpperCase() + why.slice(1));
  const secs = Math.max(0, Math.round((Date.now() - stateObj.since) / 1000));
  set("stateSince", `Sejak ${clock(stateObj.since)}, ${duration(secs)} lalu`);
  const c = stateObj.calibration;
  if (c) {
    set("calibration", c.calibrated
      ? `Selesai, ambang ${num(c.threshold, 1)} µS`
      : `Berjalan ${c.progress_s ?? 0} dari ${c.target_s ?? "?"} detik, ambang sementara ${num(c.threshold, 1)} µS`);
    set("gsrNote", `Ambang ${num(c.threshold, 1)} µS`);
  }
}
setInterval(renderState, 1000);

function renderMode() {
  const target = controls.applied.mode;
  if (!deviceMode) return set("deviceMode", "–");
  set("deviceMode", target && target !== deviceMode
    ? `${MODES[deviceMode]}, menunggu alat pindah ke ${MODES[target]}`
    : MODES[deviceMode] ?? deviceMode);
  map.idle(target ?? deviceMode);
}

function clearView() {
  strip.clear();
  set("ecgPacket", "");
  for (const id of ["hr", "gsr", "sqi"]) set(id, "");
  for (const id of ["hrNote", "accel", "fall", "localState", "sensors", "decision", "validators", "persistence", "quality"]) {
    set(id, id === "hrNote" ? "" : "–");
  }
  set("vitalTime", "Belum ada data vital");
  set("infMeta", "Tiap window 7 detik, bergeser 3,5 detik");
  for (const row of document.querySelectorAll(".prob")) {
    row.querySelector("i").style.width = "0";
    row.querySelector(".prob-v").textContent = "–";
    row.dataset.top = "false";
  }
}

function setRunning(v) {
  running = v;
  $("stripIdle").hidden = v;
  controls.setRunning(v);
}

function pause() {
  setRunning(false);
  clearView();
}

function beep() {
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "square";
    o.frequency.value = 880;
    g.gain.value = 0.15;
    o.connect(g);
    g.connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.6);
  } catch (e) {}
}

function fallAlarm(d) {
  const a = d.accel || {};
  log.add("jatuh", `Terdeteksi, percepatan total ${num(a.mag, 2)} g, status alat ${STATES[d.local_state]?.word ?? d.local_state}`);
  set("fallAlert", `Jatuh terdeteksi pukul ${clock(d.fall_ts)}`);
  $("fallAlert").hidden = false;
  beep();
  setTimeout(beep, 800);
  clearTimeout(fallTimer);
  fallTimer = setTimeout(() => {
    $("fallAlert").hidden = true;
  }, 6000);
}

const handlers = {
  ecg(buf) {
    const p = decodeEcg(buf);
    if (!p.buffered) strip.push(p.samples);
    set("ecgPacket", `Paket ${p.format}, ${num(buf.length)} byte`);
  },

  state(d) {
    if (prevState && prevState !== d.state) {
      log.add("transisi", `${STATES[prevState]?.word ?? prevState} ke ${STATES[d.state]?.word ?? d.state}: ${d.reason}`);
    }
    prevState = d.state;
    stateObj = d;
    renderState();
    if (!d.mode) return;
    if (modeRequest) {
      if (d.mode === modeRequest.mode) {
        log.add("mode", `Alat sudah di mode ${MODES[d.mode]}`);
        modeRequest = null;
      } else if (Date.now() < modeRequest.until) {
        return;
      } else {
        log.add("mode", `Alat tidak pindah ke mode ${MODES[modeRequest.mode]}, tetap ${MODES[d.mode]}`);
        modeRequest = null;
        controls.setApplied("mode", d.mode);
        renderMode();
        return;
      }
    }
    if (d.mode !== controls.applied.mode) {
      if (controls.applied.mode && running) {
        log.add("mode", `Alat pindah ke mode ${MODES[d.mode]} dari tombol di alat, tampilan dijeda`);
        pause();
      }
      controls.setApplied("mode", d.mode);
      renderMode();
    }
  },

  vital(d) {
    if (d.buffered) return;
    set("vitalTime", `Diperbarui ${clock(d.ts)}`);
    set("hr", d.hr == null ? "" : num(d.hr));
    set("hrNote", `Dari ${d.hr_source ?? "?"}. PPG ${num(d.hr_ppg)}, EKG ${num(d.hr_ecg)} bpm`);
    set("gsr", d.gsr == null ? "" : num(d.gsr, 2));
    set("sqi", d.sqi == null ? "" : num(d.sqi, 2));
    const a = d.accel || {};
    html("accel", `x ${num(a.x, 2)}, y ${num(a.y, 2)}, z ${num(a.z, 2)} g<small>Total ${num(a.mag, 2)} g, simpangan ${num(a.sd, 3)} g</small>`);
    html("fall", d.fall_detected ? chip("Terdeteksi", 'data-tone="crit"') : "Tidak");
    html("localState", `${STATES[d.local_state]?.word ?? d.local_state ?? "–"} ${d.lead_off ? chip("Elektroda lepas", 'data-tone="crit"') : ""}`);
    const s = d.sensors || {};
    const sensors = [["EKG", s.ecg], ["PPG", s.ppg], ["GSR", s.gsr], ["IMU", s.imu], ["GPS", !!d.gps]];
    html("sensors", `<span class="chips">${sensors.map(([k, on]) => chip(k, `data-on="${!!on}"`)).join("")}</span>${d.i2c ? `<small>I2C: ${d.i2c}</small>` : ""}`);
    if (d.mode) {
      deviceMode = d.mode;
      renderMode();
    }
    if (d.gps) map.show(d.gps);
    if (d.fall_detected && d.fall_ts && d.fall_ts !== lastFallTs) {
      lastFallTs = d.fall_ts;
      fallAlarm(d);
    }
  },

  inference(d) {
    if (d.late) return;
    for (const row of document.querySelectorAll(".prob")) {
      const i = +row.dataset.i;
      const p = d.probs?.[i] ?? 0;
      row.querySelector("i").style.width = `${(p * 100).toFixed(1)}%`;
      row.querySelector(".prob-v").textContent = num(p, 2);
      row.dataset.top = String(i === d.class_idx);
    }
    set("infMeta", `Window ${d.seq}, inferensi ${num(d.infer_ms, 1)} ms, latensi ${num(d.process_latency_ms)} ms`);
    const why = d.reason ? d.reason[0].toUpperCase() + d.reason.slice(1) : d.accepted ? "Diterima FSM" : "Tidak diputuskan";
    html("decision", `${CLASSES[d.class_idx] ?? d.class}, keyakinan ${num(d.p_conf, 2)}<small>${why}</small>`);
    const v = d.validators;
    html("validators", v
      ? `GSR ${v.ind_gsr ? "mendukung" : "tidak mendukung"}, HR ${v.ind_hr ? "mendukung" : "tidak mendukung"}<small>${v.degraded ? "Mode terdegradasi" : "Mode independen"}${v.motion ? ", pemakai sedang bergerak" : ""}</small>`
      : "–");
    const dec = d.decision;
    html("persistence", dec
      ? `${dec.consec_non_normal ?? 0} dari ${dec.n_required ?? "?"} window tidak normal<small>${dec.consec_normal ?? 0} window normal berturut-turut</small>`
      : "–");
    const q = d.quality || {};
    const ok = d.signal_ok !== false;
    html("quality", ok
      ? `Baik, ${num(q.ptp_mv, 2)} mV puncak ke puncak<small>kSQI ${num(q.ksqi, 2)}, pSQI ${num(q.psqi, 2)}, basSQI ${num(q.bassqi, 2)}</small>`
      : `${chip("Diabaikan", 'data-tone="crit"')}<small>${q.reason ?? ""}</small>`);
    if (lastSignalOk !== null && ok !== lastSignalOk) {
      log.add("sinyal", ok ? "Kualitas EKG pulih, window kembali dinilai" : `Kualitas EKG buruk: ${q.reason ?? "tanpa keterangan"}`);
    }
    lastSignalOk = ok;
    if (d.clock_unsynced && !clockWarned) {
      clockWarned = true;
      log.add("jam", "Jam alat belum tersinkron, cloud memakai waktu terima paket");
    }
  },

  alert(d) {
    const parts = [EVENTS[d.event_type] ?? d.event_type];
    if (d.confidence != null) parts.push(`keyakinan ${num(d.confidence, 2)}`);
    if (d.fall_detected) parts.push("disertai jatuh");
    if (d.gps) parts.push(`lokasi ${d.gps.lat}, ${d.gps.lng}`);
    log.add("alert", parts.join(", ") + (d.message ? `. ${d.message}` : ""));
  },


  source(d) {
    const source = d.source === "dataset" ? "dataset" : "hardware";
    const rek = source === "dataset" ? d.rekaman || "normal" : null;
    const before = controls.applied;
    if (source !== before.source || (rek && rek !== before.rekaman)) {
      log.add("sumber", source === "dataset" ? `EKG dari dataset: ${REKAMAN[rek] ?? rek}` : "EKG dari hardware (ESP32)");
    }
    controls.setApplied("source", source);
    if (rek) controls.setApplied("rekaman", rek);
    renderSource();
  },

};

const LIVE_ONLY = new Set(["ecg", "vital", "inference"]);

function onMessage(topic, buf) {
  const kind = topic.split("/").pop();
  traffic.push([Date.now(), buf.length]);
  if (!handlers[kind] || (!running && LIVE_ONLY.has(kind))) return;
  try {
    if (kind === "ecg") return handlers.ecg(buf);
    handlers[kind](JSON.parse(new TextDecoder().decode(buf)));
  } catch (e) {}
}

setInterval(() => {
  const now = Date.now();
  while (traffic.length && now - traffic[0][0] > 30000) traffic.shift();
  const total = traffic.reduce((s, [, n]) => s + n, 0);
  set("rate", total ? `Data masuk ${num(total / 30)} B/s` : "");
}, 2000);

const presence = createPresence({
  device: DEVICE,
  onChange(ready) {
    log.add("koneksi", ready ? `Alat ${DEVICE} terhubung` : `Alat ${DEVICE} terputus`);
  },
});

const conn = connect(BACKEND, DEVICE, {
  onServer: (v) => presence.server(v),
  onPresence: (p) => presence.presence(p),
  onMessage,
  onError: (m) => log.add("server", m),
});

controls.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (running && !controls.hasPending) return pause();
  const todo = controls.takePending();
  if (todo.mode) {
    log.add("mode", `Meminta alat pindah ke mode ${MODES[todo.mode]}`);
    conn.send({ type: "mode", mode: todo.mode });
    modeRequest = { mode: todo.mode, until: Date.now() + 90_000 };
  }
  if (todo.source) {
    const s = todo.source;
    log.add("sumber", s.source === "dataset" ? `EKG dari dataset: ${REKAMAN[s.rekaman] ?? s.rekaman}` : "EKG dari hardware (ESP32)");
    conn.send({ type: "source", ...s });
  }
  renderSource();
  renderMode();
  clearView();
  setRunning(true);
  try {
    audio = audio || new AudioContext();
    audio.resume();
  } catch (e) {}
});

renderSource();
map.idle("demo");
