export function connect(backend, device, { onStatus, onMessage, onError }) {
  const sock = io(`${backend}/debug`, { path: "/data/realtime", transports: ["websocket", "polling"] });
  sock.on("connect", () => {
    onStatus("ok", "Server terhubung");
    sock.emit("watch", device);
  });
  sock.on("disconnect", () => onStatus("crit", "Server terputus, mencoba lagi"));
  sock.on("connect_error", () => onStatus("warn", "Membangunkan server, tunggu ±1 menit"));
  sock.on("galat", (m) => onError(m));
  sock.on("m", (topic, data) => onMessage(topic, new Uint8Array(data)));
  return { send: (cmd) => sock.emit("cmd", cmd) };
}
