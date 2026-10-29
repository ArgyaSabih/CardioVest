import { api, getToken } from './api.js';
import { connectRealtime, disconnectRealtime } from './realtime.js';
import { authActions, liveActions } from './store.js';

export async function startSession(dispatch) {
  const me = await api('/users/me');
  dispatch(authActions.me(me));
  if (me.device) {
    dispatch(liveActions.status(await api('/status')));
    connectRealtime(dispatch, getToken());
  } else {
    disconnectRealtime();
    dispatch(liveActions.reset());
  }
  return me;
}
