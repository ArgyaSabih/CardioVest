import { ago } from "./labels.js";

const SERVER = {
  connecting: ["wait", "Menghubungkan"],
  waking: ["wait", "Bangun, ±1 menit"],
  lost: ["fail", "Terputus"],
  ok: ["ok", "Tersambung"],
};

const GATE = {
  connecting: ["Menghubungkan", ""],
  waking: ["Server Bangun", "±1 menit"],
  lost: ["Server Terputus", ""],
  broker: ["Broker Terputus", "Cek MQTT_HOST, MQTT_USER, MQTT_PASS, atau kuota EMQX."],
  checking: ["Memeriksa Alat", ""],
  device: ["Alat Terputus", ""],
};

export function createPresence({ device, onChange }) {
  const $ = (id) => document.getElementById(id);
  const s = { server: "connecting", broker: null, device: null, seen: null };
  let wasReady = null;
  let toastTimer = null;

  for (const el of document.querySelectorAll(".gate-dev")) el.textContent = device;

  function steps() {
    const out = { server: SERVER[s.server] };
    if (s.server !== "ok") out.broker = ["idle", "–"];
    else if (s.broker == null) out.broker = ["wait", "Memeriksa"];
    else out.broker = s.broker ? ["ok", "Tersambung"] : ["fail", "Terputus"];
    if (out.broker[0] !== "ok") out.device = ["idle", "–"];
    else if (s.device == null) out.device = ["wait", "Memeriksa"];
    else if (s.device) out.device = ["ok", "Online"];
    else out.device = ["fail", s.seen ? `Terputus ${ago(s.seen)}` : "Belum terlihat"];
    return out;
  }

  function gateCopy() {
    if (s.server !== "ok") return GATE[s.server];
    if (s.broker === false) return GATE.broker;
    if (s.broker == null || s.device == null) return GATE.checking;
    return GATE.device;
  }

  function seenText(tone) {
    if (tone === "ok") return "Online";
    if (tone === "fail") return s.seen ? `Terakhir ${ago(s.seen)}` : "Belum terlihat";
    return "Menunggu";
  }

  function render() {
    const st = steps();
    const ready = st.device[0] === "ok";
    for (const [k, [tone, text]] of Object.entries(st)) {
      const row = document.querySelector(`#linkList [data-step="${k}"]`);
      row.dataset.tone = tone;
      row.querySelector(".link-text").textContent = text;
      document.querySelector(`#gateSteps [data-step="${k}"]`).dataset.tone = tone;
    }
    $("gateSeen").textContent = seenText(st.device[0]);
    const [title, text] = gateCopy();
    $("gateTitle").textContent = title;
    $("gateText").textContent = text;
    $("gateIcon").dataset.tone = Object.values(st).some(([t]) => t === "fail") ? "fail" : "wait";
    $("gate").dataset.open = String(!ready);
    $("app").inert = !ready;
    const pill = $("linkPill");
    pill.dataset.tone = ready ? "ok" : st.device[0] === "fail" || st.server[0] === "fail" ? "crit" : "wait";
    pill.textContent = ready ? "Online" : st.device[0] === "fail" ? "Terputus" : "Menghubungkan";
    if (ready !== wasReady) {
      if (ready && wasReady === false) toast(`${device} terhubung`);
      if (wasReady !== null || ready) onChange(ready);
      wasReady = ready;
    }
  }

  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.hidden = true;
    }, 3200);
  }

  setInterval(render, 1000);
  render();

  return {
    server(v) {
      s.server = v;
      if (v !== "ok") {
        s.broker = null;
        s.device = null;
      }
      render();
    },
    presence(p) {
      s.broker = !!p.broker;
      s.device = !!p.device;
      if (p.seen) s.seen = p.seen;
      render();
    },
    get ready() {
      return wasReady === true;
    },
  };
}
