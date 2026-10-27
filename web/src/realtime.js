// Socket.IO ke server CardioVest di /data/realtime (Subbab 8.5.5). EKG (250 sampel/detik) tidak lewat Redux,
// tetapi langsung ke kanvas lewat listener agar render tetap ringan.
import { io } from 'socket.io-client';
import { REALTIME_URL } from './api.js';
import { liveActions } from './store.js';

let socket = null;
const ecgListeners = new Set();

export function onEcg(fn) {
  ecgListeners.add(fn);
  return () => ecgListeners.delete(fn);
}

export function connectRealtime(dispatch, token) {
  disconnectRealtime();
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
  socket?.disconnect();
  socket = null;
}
