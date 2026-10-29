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
  server: ["Server", "crit"],
  jam: ["Jam alat", "warn"],
};

export const EVENTS = {
  warning: "Waspada",
  critical: "Darurat",
  critical_fall: "Darurat, pemakai terjatuh",
  critical_location: "Lokasi darurat tersedia",
  resolved: "Keadaan darurat selesai",
};

export const MODES = { demo: "Demo", test: "Test" };
export const SOURCES = { hardware: "Hardware", dataset: "Dataset" };

export const rekamanLabels = () =>
  Object.fromEntries(
    [...document.querySelectorAll('input[name="rekaman"]')].map((i) => [i.value, i.dataset.name]),
  );

export const num = (x, digits = 0) =>
  x == null || Number.isNaN(+x)
    ? "–"
    : (+x).toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const clock = (ts) => new Date(ts).toLocaleTimeString("id-ID", { hour12: false });

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} detik lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  return `${Math.floor(s / 3600)} jam ${Math.floor((s % 3600) / 60)} menit lalu`;
}
