import { configureStore, createSlice } from '@reduxjs/toolkit';

const auth = createSlice({
  name: 'auth',
  initialState: { user: null, device: null, emailConfigured: false, loaded: false },
  reducers: {
    me: (s, a) => {
      s.user = a.payload.user;
      s.device = a.payload.device;
      s.emailConfigured = !!a.payload.email_configured;
      s.loaded = true;
    },
    user: (s, a) => {
      s.user = a.payload;
    },
    device: (s, a) => {
      s.device = a.payload;
    },
    clear: () => ({ user: null, device: null, emailConfigured: false, loaded: true }),
  },
});

const liveInit = {
  loaded: false,
  connected: false,
  deviceId: '',
  state: 'NORMAL',
  mode: 'demo',
  remoteReset: true,
  since: null,
  reason: null,
  online: null,
  connection: 'unknown',
  vital: null,
  inference: null,
  signal: null,
  calibration: null,
  gps: null,
  trail: [],
  fall: false,
  leadOff: false,
  event: null,
  contacts: [],
  source: null,
};

const live = createSlice({
  name: 'live',
  initialState: liveInit,
  reducers: {
    socket: (s, a) => {
      s.connected = a.payload;
    },
    status: (s, p) => {
      const d = p.payload;
      Object.assign(s, {
        loaded: true,
        deviceId: d.device_id,
        state: d.state,
        mode: d.mode === 'test' ? 'test' : 'demo',
        since: d.since,
        reason: d.reason,
        online: d.online,
        connection: d.connection,
        vital: d.vital,
        inference: d.inference,
        signal: d.signal,
        calibration: d.calibration,
        gps: d.gps,
        trail: d.trail || [],
        fall: !!d.event?.fall_detected,
        leadOff: !!d.vital?.lead_off,
        event: d.event,
        contacts: d.contacts || [],
        remoteReset: d.remote_reset !== false,
        source: d.source ?? null,
      });
    },
    source: (s, a) => {
      s.source = a.payload;
    },
    state: (s, a) => {
      const d = a.payload;
      if (d.state !== s.state && d.state === 'NORMAL') {
        s.event = null;
        s.fall = false;
        s.trail = [];
        s.gps = null;
      }
      s.state = d.state;
      if (d.mode) s.mode = d.mode;
      s.since = d.since;
      s.reason = d.reason;
      s.signal = d.signal;
      s.calibration = d.calibration;
      if (d.gps) s.gps = d.gps;
    },
    vital: (s, a) => {
      s.vital = a.payload;
      s.leadOff = !!a.payload.lead_off;
      s.online = true;
      if (s.connection !== 'buffering') s.connection = 'online';
      if (a.payload.fall) s.fall = true;
    },
    inference: (s, a) => {
      s.inference = a.payload;
    },
    location: (s, a) => {
      s.gps = a.payload;
      s.trail = [...s.trail.slice(-359), a.payload];
    },
    fall: (s) => {
      s.fall = true;
    },
    online: (s, a) => {
      s.online = a.payload.online;
      s.connection = a.payload.connection ?? (a.payload.online ? 'online' : 'offline');
    },
    alert: (s, a) => {
      if (a.payload.event_id && a.payload.event_type !== 'resolved') {
        s.event = { acks: [], ...(s.event || {}), id: a.payload.event_id, type: a.payload.state === 'CRITICAL' ? 'critical' : 'warning' };
      }
    },
    acks: (s, a) => {
      if (s.event) s.event.acks = a.payload;
    },
    reset: () => liveInit,
  },
});

export const authActions = auth.actions;
export const liveActions = live.actions;
export const store = configureStore({ reducer: { auth: auth.reducer, live: live.reducer } });
