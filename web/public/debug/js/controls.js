import { MODES } from "./labels.js";

export function createControls({ labels, onChange }) {
  const $ = (id) => document.getElementById(id);
  const buttons = [...document.querySelectorAll(".segmented button")];
  const rekaman = $("rekaman");
  const runBtn = $("runBtn");
  const notice = $("notice");
  const applied = { mode: null, source: "hardware", rekaman: "normal" };
  const pending = {};
  let running = false;

  const value = (key) => pending[key] ?? applied[key] ?? (key === "mode" ? "demo" : null);

  function changes() {
    const out = [];
    if ("mode" in pending) out.push(`mode ${MODES[pending.mode]}`);
    const sourceChanged = "source" in pending || ("rekaman" in pending && value("source") === "dataset");
    if (sourceChanged) {
      out.push(value("source") === "dataset" ? `sumber EKG Dataset, ${labels[value("rekaman")]}` : "sumber EKG Hardware");
    }
    return out;
  }

  function render() {
    for (const b of buttons) {
      const key = b.dataset.group;
      const on = value(key) === b.dataset.value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      b.dataset.pending = String(on && key in pending);
    }
    $("rekamanField").hidden = value("source") !== "dataset";
    rekaman.value = value("rekaman");
    const list = changes();
    runBtn.textContent = running ? "Jeda" : "Jalankan";
    runBtn.dataset.running = String(running);
    runBtn.dataset.pending = String(list.length > 0);
    if (list.length) notice.innerHTML = `Belum diterapkan: <b>${list.join(" dan ")}</b>. Klik Jalankan untuk menerapkan.`;
    else notice.innerHTML = running ? "" : "Tampilan dijeda. Klik <b>Jalankan</b> untuk mulai menampilkan data.";
  }

  function choose(key, v) {
    if (v === applied[key]) delete pending[key];
    else pending[key] = v;
    if (key === "source" && v === "hardware") delete pending.rekaman;
    onChange();
    render();
  }

  for (const b of buttons) {
    b.addEventListener("click", () => choose(b.dataset.group, b.dataset.value));
    b.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const group = buttons.filter((x) => x.dataset.group === b.dataset.group);
      const next = group[(group.indexOf(b) + (e.key === "ArrowRight" ? 1 : group.length - 1)) % group.length];
      next.focus();
      next.click();
    });
  }
  rekaman.addEventListener("change", () => choose("rekaman", rekaman.value));

  render();

  return {
    get applied() {
      return { ...applied };
    },
    setApplied(key, v) {
      applied[key] = v;
      if (pending[key] === v) delete pending[key];
      render();
    },
    takePending() {
      const out = {};
      if ("mode" in pending && pending.mode !== applied.mode) out.mode = pending.mode;
      const source = value("source");
      const rek = source === "dataset" ? value("rekaman") : null;
      if (source !== applied.source || (source === "dataset" && rek !== applied.rekaman)) out.source = { source, rekaman: rek };
      for (const k of Object.keys(pending)) delete pending[k];
      if (out.mode) applied.mode = out.mode;
      if (out.source) {
        applied.source = out.source.source;
        if (rek) applied.rekaman = rek;
      }
      render();
      return out;
    },
    setRunning(v) {
      running = v;
      render();
    },
  };
}
