// Socket.IO ke server CardioVest di /data/realtime (Subbab 8.5.5). EKG (250 sampel/detik) tidak lewat Redux,
// tetapi langsung ke kanvas lewat listener agar render tetap ringan.
import { io } from 'socket.io-client';
import { DEMO, REALTIME_URL } from './api.js';
import { liveActions } from './store.js';

let socket = null;
const ecgListeners = new Set();

export function onEcg(fn) {
  ecgListeners.add(fn);
  return () => ecgListeners.delete(fn);
}

let demoOff = null;

/** Mode demo: event yang sama, tetapi dari simulator di browser (src/demo/backend.js). */
async function connectDemo(dispatch) {
  const demo = await import('./demo/backend.js');
  const map = { state: liveActions.state, vital: liveActions.vital, inference: liveActions.inference, location: liveActions.location,
    fall: liveActions.fall, online: liveActions.online, alert: liveActions.alert };
  demoOff = demo.subscribe((name, p) => {
    if (name === 'ecg') ecgListeners.forEach((fn) => fn(p));
    else if (name === 'ack') dispatch(liveActions.acks(p.acks));
    else if (map[name]) dispatch(map[name](p));
  });
  dispatch(liveActions.socket(true));
}

export function connectRealtime(dispatch, token) {
  disconnectRealtime();
  if (DEMO) {
    connectDemo(dispatch);
    return null;
  }
  socket = io(REALTIME_URL, { path: '/data/realtime', auth: { token }, transports: ['websocket', 'polling'] });
  socket.on('connect', () => dispatch(liveActions.socket(true)));
  socket.on('disconnect', () => dispatch(liveActions.socket(false)));
  socket.on('connect_error', () => dispatch(liveActions.socket(false)));
  socket.on('status', (p) => dispatch(liveActions.status(p)));
  socket.on('state', (p) => dispatch(liveActions.state(p)));
  socket.on('vital', (p) => dispatch(liveActions.vital(p)));
  socket.on('inference', (p) => dispatch(liveActions.inference(p)));
  socket.on('location', (p) => dispatch(liveActions.location(p)));
  socket.on('fall', () => dispatch(liveActions.fall()));
  socket.on('online', (p) => dispatch(liveActions.online(p)));
  socket.on('alert', (p) => dispatch(liveActions.alert(p)));
  socket.on('ack', (p) => dispatch(liveActions.acks(p.acks)));
  socket.on('ecg', (p) => ecgListeners.forEach((fn) => fn(p)));
  return socket;
}

export function disconnectRealtime() {
  demoOff?.();
  demoOff = null;
  socket?.disconnect();
  socket = null;
}
