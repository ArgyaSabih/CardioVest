'use client';
// Panel simulasi untuk mode demo: menggantikan perintah `simulator.ctl` di versi Docker.
import { useEffect, useState } from 'react';
import { DEMO } from '../api.js';

const CHOICES = [
  ['normal', 'Normal'],
  ['waspada', 'Waspada'],
  ['darurat', 'Darurat'],
  ['jatuh', 'Darurat + jatuh'],
];

export default function DemoPanel() {
  const [cur, setCur] = useState(null);
  const [demo, setDemo] = useState(null);
  useEffect(() => {
    if (!DEMO) return undefined;
    let alive = true;
    import('../demo/backend.js').then((m) => {
      if (!alive) return;
      setDemo(m);
      setCur(m.currentScenario());
    });
    const t = setInterval(() => demo && setCur(demo.currentScenario()), 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [demo]);
  if (!DEMO || !demo || !cur) return null;
  const run = (name) => {
    demo.scenario(name);
    setCur(demo.currentScenario());
  };
  return (
    <section className="demo-panel" aria-label="Simulasi alat (mode demo)">
      <h2>Simulasi alat</h2>
      <div className="seg small" role="group" aria-label="Skenario">
        {CHOICES.map(([k, l]) => (
          <button key={k} aria-pressed={cur.scenario === k} onClick={() => run(k)}>{l}</button>
        ))}
      </div>
      <div className="row">
        <button className="btn small" onClick={() => run('reset')} disabled={cur.state === 'NORMAL'}>Tahan tombol reset</button>
        <button className="btn small" onClick={() => run(cur.online ? 'putus' : 'sambung')}>{cur.online ? 'Putuskan alat' : 'Sambungkan alat'}</button>
      </div>
    </section>
  );
}
