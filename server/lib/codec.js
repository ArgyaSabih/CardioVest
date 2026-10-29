export const COUNTS_PER_MV = 500;

export function decodeEcg(buf) {
  const magic = buf.length >= 20 && ((buf[0] === 0x43 && buf[1] === 0x56) || (buf[0] === 0x48 && buf[1] === 0x57));
  if (magic) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint8(2) !== 1) throw new Error('versi payload ECG tidak dikenal');
    const flags = dv.getUint8(3);
    const n = dv.getUint16(18);
    const s = new Int16Array(n);
    let pos = 20;
    if (n) {
      s[0] = dv.getInt16(pos);
      pos += 2;
    }
    for (let i = 1; i < n; i++) {
      const b = dv.getUint8(pos);
      let d;
      if (b === 0x80) {
        d = dv.getInt16(pos + 1);
        pos += 3;
      } else {
        d = dv.getInt8(pos);
        pos += 1;
      }
      s[i] = s[i - 1] + d;
    }
    return {
      seq: dv.getUint32(4),
      t0: Number(dv.getBigUint64(8)),
      fs: dv.getUint16(16),
      samples: s,
      buffered: !!(flags & 1),
      leadOff: !!(flags & 2),
      clockUnsynced: !!(flags & 4),
    };
  }
  const o = JSON.parse(buf.toString());
  return {
    seq: o.seq,
    t0: o.t0,
    fs: o.fs,
    samples: Int16Array.from(o.samples),
    buffered: !!o.buffered,
    leadOff: !!o.lead_off,
    clockUnsynced: o.time_valid === false,
  };
}

export const toMv = (samples) => Array.from(samples, (c) => Math.round((c / COUNTS_PER_MV) * 1000) / 1000);
