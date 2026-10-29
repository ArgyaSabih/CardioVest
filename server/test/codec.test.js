import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { decodeEcg, toMv } from '../lib/codec.js';

const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const exp = JSON.parse(fx('ecg_expected.json'));

for (const [name, flags] of [['biner_normal.bin', 0], ['biner_flag.bin', 7], ['json_flag.bin', 6], ['biner_lama_hw.bin', 0]]) {
  test(`decode ${name}`, () => {
    const p = decodeEcg(fx(name));
    assert.equal(p.seq, exp.seq);
    assert.equal(p.t0, exp.t0);
    assert.equal(p.fs, exp.fs);
    assert.deepEqual(Array.from(p.samples), exp.samples);
    assert.equal(p.buffered, !!(flags & 1));
    assert.equal(p.leadOff, !!(flags & 2));
    assert.equal(p.clockUnsynced, !!(flags & 4));
  });
}

test('toMv mengubah count ke mV', () => {
  assert.deepEqual(toMv(Int16Array.from([500, -250, 1])), [1, -0.5, 0.002]);
});
