export function connect(backend, device, { onServer, onPresence, onMessage, onError }) {
  const sock = io(`${backend}/debug`, { path: "/data/realtime", transports: ["websocket", "polling"] });
  let everConnected = false;
  sock.on("connect", () => {
    everConnected = true;
    onServer("ok");
    sock.emit("watch", device);
  });
  sock.on("disconnect", () => onServer("lost"));
  sock.on("connect_error", () => onServer(everConnected ? "lost" : "waking"));
  sock.on("presence", (p) => onPresence(p));
  sock.on("galat", (m) => onError(m));
  sock.on("m", (topic, data) => onMessage(topic, new Uint8Array(data)));
  return { send: (cmd) => sock.emit("cmd", cmd) };
}
