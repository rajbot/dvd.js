import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VobScanner, decodeSpu, isNavPack, paletteToRgb } from '../src/nav.js';

const SECTOR = 2048;

function navPack({ startPtm, endPtm, vobId, cellId, buttons = [] }) {
  const u8 = new Uint8Array(SECTOR);
  const dv = new DataView(u8.buffer);
  u8.set([0, 0, 1, 0xba], 0);
  u8.set([0, 0, 1, 0xbb], 14);
  u8.set([0, 0, 1, 0xbf], 0x26);
  u8.set([0, 0, 1, 0xbf], 0x400);
  u8[0x406] = 1;
  const pci = 0x2d;
  dv.setUint32(pci + 12, startPtm);
  dv.setUint32(pci + 16, endPtm);
  const hl = pci + 96;
  dv.setUint16(hl, buttons.length ? 1 : 0);
  dv.setUint8(hl + 14, 1 << 4);
  dv.setUint8(hl + 17, buttons.length);
  dv.setUint32(hl + 22, 0x123400f0);
  buttons.forEach((b, i) => {
    const o = hl + 46 + i * 18;
    dv.setUint32(o, ((1 << 22) | (b.x1 << 12) | b.x2) << 8);
    const y = (b.y1 << 12) | b.y2;
    dv.setUint8(o + 3, y >> 16);
    dv.setUint16(o + 4, y & 0xffff);
    u8.set([b.up, b.down, b.left, b.right], o + 6);
    u8.set(b.cmd, o + 10);
  });
  const dsi = 0x407;
  dv.setUint16(dsi + 24, vobId);
  dv.setUint8(dsi + 27, cellId);
  return u8;
}

function pesPack(streamId, payload, substream = null) {
  const u8 = new Uint8Array(SECTOR);
  u8.set([0, 0, 1, 0xba], 0);
  const body = substream === null ? payload : [substream, ...payload];
  const len = 3 + body.length;
  u8.set([0, 0, 1, streamId, len >> 8, len & 0xff, 0x81, 0x00, 0x00, ...body], 14);
  return u8;
}

// A 4x2 subpicture: top line pixel value 1, bottom line pixel value 2.
function spuUnit() {
  const rle = [0x00, 0x01, 0x00, 0x02]; // "rest of line" in colour 1, then colour 2
  const ctrl = 4 + rle.length;
  const seq = [
    0x00, 0x00, ctrl >> 8, ctrl & 0xff, // delay 0, next = self (last sequence)
    0x00, // forced display
    0x03, 0x32, 0x10, // palette
    0x04, 0xff, 0xf0, // alpha
    0x05, 0x00, 0xa0, 0x0d, 0x01, 0x40, 0x15, // x 10..13, y 20..21
    0x06, 0x00, 0x04, 0x00, 0x06, // field offsets
    0xff,
  ];
  const size = ctrl + seq.length;
  return [size >> 8, size & 0xff, ctrl >> 8, ctrl & 0xff, ...rle, ...seq];
}

test('VobScanner finds VOBUs, buttons and subpictures across chunk boundaries', () => {
  const button = { x1: 100, x2: 200, y1: 50, y2: 90, up: 1, down: 2, left: 1, right: 1, cmd: [0x30, 2, 0, 0, 0, 1, 0, 0] };
  const packs = [
    navPack({ startPtm: 1000, endPtm: 46000, vobId: 1, cellId: 1, buttons: [button] }),
    pesPack(0xe0, [1, 2, 3]),
    pesPack(0xbd, spuUnit(), 0x20),
    navPack({ startPtm: 46000, endPtm: 91000, vobId: 1, cellId: 2 }),
    pesPack(0xbd, [0x0b, 0x77], 0x80),
  ];
  const all = new Uint8Array(packs.length * SECTOR);
  packs.forEach((p, i) => all.set(p, i * SECTOR));
  assert.equal(isNavPack(all, 0), true);
  assert.equal(isNavPack(all, SECTOR), false);

  const scanner = new VobScanner();
  for (let off = 0; off < all.length; off += 1000) scanner.push(all.subarray(off, off + 1000));
  assert.equal(scanner.sectors, 5);
  assert.deepEqual(scanner.vobus.map((v) => [v.sector, v.dsi.cellId, v.hasVideo, v.hasAudio]), [[0, 1, true, false], [3, 2, false, true]]);
  const { hli } = scanner.vobus[0].pci;
  assert.equal(hli.buttons.length, 1);
  const b = hli.buttons[0];
  assert.deepEqual([b.x1, b.x2, b.y1, b.y2, b.colorN, b.down], [100, 200, 50, 90, 1, 2]);
  assert.deepEqual([...b.cmd], button.cmd);
  assert.equal(hli.colors[0].select, 0x123400f0);

  const units = scanner.spus.get(0x20);
  assert.equal(units.length, 1);
  assert.equal(units[0].vobu, 0);
  const spu = decodeSpu(units[0].data);
  assert.deepEqual([spu.x1, spu.x2, spu.y1, spu.y2, spu.forced], [10, 13, 20, 21, true]);
  assert.deepEqual([...spu.pixels], [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual(spu.palette, [0, 1, 2, 3]);
  assert.deepEqual(spu.alpha, [0, 15, 15, 15]);
});

test('paletteToRgb converts video-range YCrCb', () => {
  assert.deepEqual(paletteToRgb({ y: 16, cr: 128, cb: 128 }), [0, 0, 0]);
  assert.deepEqual(paletteToRgb({ y: 235, cr: 128, cb: 128 }), [255, 255, 255]);
});
