export const STATES = {
  NORMAL: { word: "Normal", tone: "ok" },
  WARNING: { word: "Waspada", tone: "warn" },
  CRITICAL: { word: "Darurat", tone: "crit" },
};

export const CLASSES = ["Normal", "Pra-serangan", "Serangan"];

export const LOG_TAGS = {
  transisi: ["Transisi", "warn"],
  alert: ["Peringatan", "crit"],
  koneksi: ["Koneksi", "info"],
  sinyal: ["Sinyal", "warn"],
  mode: ["Mode alat", "info"],
  jatuh: ["Jatuh", "crit"],
  sumber: ["Sumber EKG", "info"],
  simulator: ["Simulator", "info"],
  server: ["Server", "crit"],
  jam: ["Jam alat", "warn"],
};

export const MODES = { demo: "Demo", test: "Test" };
export const SOURCES = { hardware: "Hardware", dataset: "Dataset" };

export const rekamanLabels = () =>
  Object.fromEntries([...document.querySelectorAll("#rekaman option")].map((o) => [o.value, o.textContent]));

export const num = (x, digits = 0) =>
  x == null || Number.isNaN(+x)
    ? "–"
    : (+x).toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const clock = (ts) => new Date(ts).toLocaleTimeString("id-ID", { hour12: false });
