'use client';
// Pairing alat (F-APP-2): ketik ID + kode pairing dari label, atau pindai QR label dengan kamera.
// QR berisi "CARDIOVEST:<id>:<kode>" (dibuat oleh `npm run alat -- tambah <id>` di gateway).
import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useRouter } from 'next/navigation';
import { api } from '../api.js';
import { startSession } from '../session.js';
import Icon from '../components/icons.jsx';
import { ErrorNote, SignBar } from '../components/ui.jsx';

export const parsePairing = (text) => {
  const m = String(text).trim().match(/^CARDIOVEST:([A-Za-z0-9_-]{2,32}):(\d{6})$/i);
  return m ? { device_id: m[1], pairing_code: m[2] } : null;
};

function Scanner({ onResult, onClose }) {
  const video = useRef(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stream;
    let raf = 0;
    let stop = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        video.current.srcObject = stream;
        await video.current.play();
      } catch {
        setErr('Kamera tidak bisa dibuka. Izinkan akses kamera, atau ketik ID dan kode secara manual.');
        return;
      }
      const tick = () => {
        if (stop) return;
        const v = video.current;
        if (v?.videoWidth) {
          const w = 480;
          const h = Math.round((v.videoHeight / v.videoWidth) * w);
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(v, 0, 0, w, h);
          const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
          const p = code && parsePairing(code.data);
          if (p) {
            onResult(p);
            return;
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);
  return (
    <div className="scanner">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={video} playsInline muted aria-label="Pratinjau kamera untuk memindai QR" />
      <div className="scan-frame" aria-hidden="true" />
      <ErrorNote error={err} />
      <button className="btn wide" onClick={onClose}>Tutup kamera</button>
    </div>
  );
}

export default function Pair() {
  const device = useSelector((s) => s.auth.device);
  const [f, setF] = useState({ device_id: '', pairing_code: '' });
  const [scan, setScan] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dispatch = useDispatch();
  const router = useRouter();

  useEffect(() => {
    if (device) router.replace('/');
  }, [device, router]);

  const pair = async (body) => {
    setErr('');
    setBusy(true);
    try {
      await api('/devices/pair', { method: 'POST', body });
      await startSession(dispatch);
      router.replace('/');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SignBar icon="qr" title="Pasangkan alat" />
      <p className="muted">ID dan kode ada di label alat.</p>
      {scan ? (
        <Scanner
          onResult={(p) => {
            setScan(false);
            setF(p);
            pair(p);
          }}
          onClose={() => setScan(false)}
        />
      ) : (
        <button className="btn primary wide" onClick={() => setScan(true)} disabled={busy}><Icon name="qr" />Pindai QR di label alat</button>
      )}
      <form className="form block" onSubmit={(e) => { e.preventDefault(); pair(f); }}>
        <p className="divider"><span>atau ketik manual</span></p>
        <label>ID alat<input value={f.device_id} onChange={(e) => setF({ ...f, device_id: e.target.value.trim() })} placeholder="cv-001" autoCapitalize="none" required /></label>
        <label>Kode pairing<input inputMode="numeric" pattern="\d{6}" maxLength={6} value={f.pairing_code} onChange={(e) => setF({ ...f, pairing_code: e.target.value.replace(/\D/g, '') })} placeholder="6 digit" required /></label>
        <ErrorNote error={err} />
        <button className="btn primary" disabled={busy}>{busy ? 'Memasangkan…' : 'Pasangkan'}</button>
      </form>
    </>
  );
}
