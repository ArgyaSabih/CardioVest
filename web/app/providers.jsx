'use client';
// Lapisan klien seluruh aplikasi: Redux, sesi login, dan service worker.
// Token login ada di localStorage, yang baru terbaca di browser; karena itu isi halaman baru dirender
// setelah komponen terpasang, supaya tampilan pertama tidak berbeda antara server dan browser.
import { useEffect, useState } from 'react';
import { Provider, useDispatch } from 'react-redux';
import { useRouter } from 'next/navigation';
import { getToken, setToken } from '@/src/api.js';
import { registerServiceWorker } from '@/src/push.js';
import { disconnectRealtime } from '@/src/realtime.js';
import { startSession } from '@/src/session.js';
import { authActions, liveActions, store } from '@/src/store.js';

function Session() {
  const dispatch = useDispatch();
  const router = useRouter();
  useEffect(() => {
    if (getToken()) startSession(dispatch).catch(() => dispatch(authActions.clear()));
    else dispatch(authActions.clear());
    const out = () => {
      disconnectRealtime();
      setToken(null);
      dispatch(authActions.clear());
      dispatch(liveActions.reset());
      // halaman privat sendiri yang mengarahkan ke /masuk
    };
    const unpaired = () => {
      dispatch(authActions.device(null));
      router.replace('/pasangkan');
    };
    window.addEventListener('cv:logout', out);
    window.addEventListener('cv:belum-pairing', unpaired);
    return () => {
      window.removeEventListener('cv:logout', out);
      window.removeEventListener('cv:belum-pairing', unpaired);
    };
  }, [dispatch, router]);
  return null;
}

export default function Providers({ children }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    registerServiceWorker();
  }, []);
  return (
    <Provider store={store}>
      {mounted ? (
        <>
          <Session />
          {children}
        </>
      ) : (
        <div className="page center muted">Memuat…</div>
      )}
    </Provider>
  );
}
