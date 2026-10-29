import { MODES } from "./labels.js";

export function createControls({ labels, onChange }) {
  const $ = (id) => document.getElementById(id);
  const form = $("setup");
  const inputs = [...form.querySelectorAll('input[type="radio"]')];
  const step = $("rekamanStep");
  const lock = $("rekamanLock");
  const runBtn = $("runBtn");
  const runText = $("runText");
  const note = $("runNote");
  const applied = { mode: "demo", source: "hardware", rekaman: "normal" };
  const pending = {};
  let running = false;

  const value = (key) => pending[key] ?? applied[key];

  function changes() {
    const out = [];
    if ("mode" in pending) out.push(`mode ${MODES[pending.mode]}`);
    const sourceChanged = "source" in pending || ("rekaman" in pending && value("source") === "dataset");
    if (sourceChanged) out.push(value("source") === "dataset" ? `EKG Dataset ${labels[value("rekaman")]}` : "EKG Hardware");
    return out;
  }

  function render() {
    for (const i of inputs) {
      const on = value(i.name) === i.value;
      i.checked = on;
      i.closest("label").dataset.pending = String(on && i.name in pending);
    }
    const dataset = value("source") === "dataset";
    step.dataset.locked = String(!dataset);
    for (const i of inputs) if (i.name === "rekaman") i.tabIndex = dataset ? 0 : -1;
    if (dataset) lock.innerHTML = `Diputar: <b>${labels[value("rekaman")]}</b>`;
    else lock.textContent = "Aktif bila sumber EKG Dataset.";
    const list = changes();
    runBtn.dataset.running = String(running && !list.length);
    runText.textContent = list.length ? "Terapkan dan jalankan" : running ? "Jeda" : "Jalankan";
    if (list.length) {
      note.dataset.tone = "pending";
      note.innerHTML = `Belum diterapkan: <b>${list.join(", ")}</b>.`;
    } else if (running) {
      note.dataset.tone = "live";
      note.textContent = applied.source === "dataset" ? "Menampilkan EKG dataset dan vital dari alat." : "Menampilkan data langsung dari alat.";
    } else {
      note.dataset.tone = "";
      note.textContent = "Tampilan dijeda. Pilihan di atas berlaku saat Jalankan ditekan.";
    }
  }

  function choose(key, v) {
    if (v === applied[key]) delete pending[key];
    else pending[key] = v;
    if (key === "source" && v === "hardware") delete pending.rekaman;
    onChange();
    render();
  }

  for (const i of inputs) i.addEventListener("change", () => choose(i.name, i.value));

  render();

  return {
    form,
    get applied() {
      return { ...applied };
    },
    get hasPending() {
      return changes().length > 0;
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
