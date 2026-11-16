// MPEG program-stream helpers for DVD VOBs: NAV packs (PCI/DSI), subpicture
// (SPU) packet reassembly and RLE decoding. Only the menu VOBs are scanned in
// the browser; they carry the button tables and highlight overlays.

import { SECTOR } from './ifo.js';

const PCI = 0x2d; // PCI payload offset inside a NAV pack
const DSI = 0x407; // DSI payload offset inside a NAV pack
const SRI_NONE = 0x3fffffff;

function isStartCode(u8, off, id) {
  return u8[off] === 0 && u8[off + 1] === 0 && u8[off + 2] === 1 && u8[off + 3] === id;
}

export function isNavPack(u8, off = 0) {
  return (
    isStartCode(u8, off, 0xba) &&
    isStartCode(u8, off + 14, 0xbb) &&
    isStartCode(u8, off + 0x26, 0xbf) &&
    u8[off + 0x2c] === 0x00 &&
    isStartCode(u8, off + 0x400, 0xbf) &&
    u8[off + 0x406] === 0x01
  );
}

function parseButtons(dv, off, count) {
  const buttons = [];
  for (let i = 0; i < count; i++) {
    const b = off + i * 18;
    const x = dv.getUint32(b) >>> 8; // 24 bits: coln(2) x1(10) zero(2) x2(10)
    const y = dv.getUint32(b + 3) >>> 8; // 24 bits: auto(2) y1(10) zero(2) y2(10)
    buttons.push({
      colorN: (x >> 22) & 3,
      x1: (x >> 12) & 0x3ff,
      x2: x & 0x3ff,
      autoAction: (y >> 22) & 3,
      y1: (y >> 12) & 0x3ff,
      y2: y & 0x3ff,
      up: dv.getUint8(b + 6) & 0x3f,
      down: dv.getUint8(b + 7) & 0x3f,
      left: dv.getUint8(b + 8) & 0x3f,
      right: dv.getUint8(b + 9) & 0x3f,
      cmd: new Uint8Array(dv.buffer.slice(dv.byteOffset + b + 10, dv.byteOffset + b + 18)),
    });
  }
  return buttons;
}

// Parse one 2048-byte NAV pack. Returns null if `off` isn't a NAV pack.
export function parseNavPack(u8, off = 0) {
  if (!isNavPack(u8, off)) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset + off, SECTOR);
  const hl = PCI + 96;
  const groups = (dv.getUint8(hl + 14) >> 4) & 3;
  const btnNs = dv.getUint8(hl + 17);
  const colors = [];
  for (let i = 0; i < 3; i++) {
    colors.push({ select: dv.getUint32(hl + 22 + i * 8), action: dv.getUint32(hl + 26 + i * 8) });
  }
  const sri = (field) => {
    const v = dv.getUint32(DSI + field) & SRI_NONE;
    return v === SRI_NONE ? null : v;
  };
  return {
    pci: {
      lbn: dv.getUint32(PCI),
      uopCtl: dv.getUint32(PCI + 8),
      startPtm: dv.getUint32(PCI + 12),
      endPtm: dv.getUint32(PCI + 16),
      seqEndPtm: dv.getUint32(PCI + 20),
      hli: {
        status: dv.getUint16(hl) & 3,
        startPtm: dv.getUint32(hl + 2),
        endPtm: dv.getUint32(hl + 6),
        selEndPtm: dv.getUint32(hl + 10),
        groups,
        btnOffset: dv.getUint8(hl + 16),
        btnNs,
        numberedBtnNs: dv.getUint8(hl + 18),
        forcedSelect: dv.getUint8(hl + 20) & 0x3f,
        forcedAction: dv.getUint8(hl + 21) & 0x3f,
        colors,
        buttons: parseButtons(dv, hl + 46, Math.min(btnNs, 36)),
      },
    },
    dsi: {
      lbn: dv.getUint32(DSI + 4),
      vobuEnd: dv.getUint32(DSI + 8),
      vobId: dv.getUint16(DSI + 24),
      cellId: dv.getUint8(DSI + 27),
      nextVobu: sri(234 + 4 + 76),
    },
  };
}

function parsePts(u8, off) {
  return (
    ((u8[off] >> 1) & 7) * 0x40000000 +
    ((u8[off + 1] << 22) | ((u8[off + 2] >> 1) << 15) | (u8[off + 3] << 7) | (u8[off + 4] >> 1))
  );
}

// Incremental VOB scanner: push() bytes as they arrive (any chunk size). It
// keeps only what the player needs: the VOBUs (NAV packs) in file order and
// the reassembled subpicture units of each SPU stream.
export class VobScanner {
  constructor() {
    this.vobus = [];
    this.spus = new Map(); // stream -> [{ pts, data, vobu }]
    this.sectors = 0; // sectors consumed so far
    this.partial = new Map(); // stream -> { pts, chunks, have, size, vobu }
    this.carry = null; // bytes of an incomplete sector
  }

  push(chunk) {
    let u8 = chunk;
    if (this.carry) {
      u8 = new Uint8Array(this.carry.length + chunk.length);
      u8.set(this.carry);
      u8.set(chunk, this.carry.length);
      this.carry = null;
    }
    let off = 0;
    for (; off + SECTOR <= u8.length; off += SECTOR) this.pack(u8, off);
    if (off < u8.length) this.carry = u8.slice(off);
  }

  pack(u8, off) {
    const sector = this.sectors++;
    if (!isStartCode(u8, off, 0xba)) return;
    const nav = parseNavPack(u8, off);
    if (nav) {
      this.vobus.push({ sector, hasVideo: false, hasAudio: false, ...nav });
      return;
    }
    const vobu = this.vobus[this.vobus.length - 1];
    let p = off + 14 + (u8[off + 13] & 7);
    if (u8[p] !== 0 || u8[p + 1] !== 0 || u8[p + 2] !== 1) return;
    const id = u8[p + 3];
    if (vobu && id >= 0xe0 && id <= 0xef) vobu.hasVideo = true;
    if (vobu && id >= 0xc0 && id <= 0xdf) vobu.hasAudio = true;
    if (id !== 0xbd) return;
    const end = Math.min(p + 6 + ((u8[p + 4] << 8) | u8[p + 5]), off + SECTOR);
    const pts = u8[p + 7] & 0x80 ? parsePts(u8, p + 9) : null;
    p += 9 + u8[p + 8];
    const stream = u8[p++];
    if (vobu && stream >= 0x80 && stream <= 0xa7) vobu.hasAudio = true; // AC-3, DTS, LPCM
    if (stream < 0x20 || stream > 0x3f) return;
    let cur = this.partial.get(stream);
    if (!cur) {
      if (end - p < 2) return;
      cur = { pts, chunks: [], have: 0, size: (u8[p] << 8) | u8[p + 1], vobu: this.vobus.length - 1 };
      this.partial.set(stream, cur);
    }
    cur.chunks.push(u8.slice(p, end));
    cur.have += end - p;
    if (cur.have < cur.size) return;
    const data = new Uint8Array(cur.have);
    let o = 0;
    for (const c of cur.chunks) {
      data.set(c, o);
      o += c.length;
    }
    if (!this.spus.has(stream)) this.spus.set(stream, []);
    this.spus.get(stream).push({ pts: cur.pts, data: data.subarray(0, cur.size), vobu: cur.vobu });
    this.partial.delete(stream);
  }
}

export function scanVob(u8) {
  const scanner = new VobScanner();
  scanner.push(u8);
  return scanner;
}

// Decode one subpicture unit into a 2-bit pixel map plus its display controls.
export function decodeSpu(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const size = dv.getUint16(0);
  let seq = dv.getUint16(2);
  const spu = {
    x1: 0, x2: 0, y1: 0, y2: 0,
    palette: [0, 0, 0, 0], // palette index for pixel values 0..3
    alpha: [0, 0, 0, 0], // 0..15 for pixel values 0..3
    forced: false,
    startDelay: 0, // 90kHz ticks after the unit's PTS
    stopDelay: null,
    pixels: null,
    width: 0,
    height: 0,
  };
  let top = 0;
  let bottom = 0;
  let first = true;
  for (let guard = 0; guard < 64 && seq + 4 <= size; guard++) {
    const delay = dv.getUint16(seq) * 1024;
    const next = dv.getUint16(seq + 2);
    let p = seq + 4;
    let done = false;
    while (!done && p < size) {
      const cmd = data[p++];
      switch (cmd) {
        case 0x00:
          if (first) spu.forced = true;
          break;
        case 0x01:
          if (first) spu.startDelay = delay;
          break;
        case 0x02:
          spu.stopDelay = delay;
          break;
        case 0x03:
          if (first) {
            const v = dv.getUint16(p);
            for (let i = 0; i < 4; i++) spu.palette[i] = (v >> (4 * i)) & 0xf;
          }
          p += 2;
          break;
        case 0x04:
          if (first) {
            const v = dv.getUint16(p);
            for (let i = 0; i < 4; i++) spu.alpha[i] = (v >> (4 * i)) & 0xf;
          }
          p += 2;
          break;
        case 0x05:
          spu.x1 = (data[p] << 4) | (data[p + 1] >> 4);
          spu.x2 = ((data[p + 1] & 0xf) << 8) | data[p + 2];
          spu.y1 = (data[p + 3] << 4) | (data[p + 4] >> 4);
          spu.y2 = ((data[p + 4] & 0xf) << 8) | data[p + 5];
          p += 6;
          break;
        case 0x06:
          top = dv.getUint16(p);
          bottom = dv.getUint16(p + 2);
          p += 4;
          break;
        case 0x07:
          p += dv.getUint16(p);
          break;
        default: // 0xff or unknown: end of this sequence
          done = true;
      }
    }
    first = false;
    if (next === seq) break;
    seq = next;
  }
  spu.width = spu.x2 - spu.x1 + 1;
  spu.height = spu.y2 - spu.y1 + 1;
  if (spu.width <= 0 || spu.height <= 0 || spu.width > 720 || spu.height > 576 || !top) return spu;

  const pixels = new Uint8Array(spu.width * spu.height);
  const end = dv.getUint16(2);
  const decodeField = (offset, startLine) => {
    let nib = offset * 2;
    const read = () => {
      const byte = data[nib >> 1];
      const v = nib & 1 ? byte & 0xf : byte >> 4;
      nib++;
      return v;
    };
    for (let y = startLine; y < spu.height && nib >> 1 < end; y += 2) {
      let x = 0;
      while (x < spu.width && nib >> 1 < end) {
        let code = read();
        if (code < 0x4) {
          code = (code << 4) | read();
          if (code < 0x10) {
            code = (code << 4) | read();
            if (code < 0x40) code = (code << 4) | read();
          }
        }
        let run = code >> 2;
        if (run === 0 || x + run > spu.width) run = spu.width - x;
        pixels.fill(code & 3, y * spu.width + x, y * spu.width + x + run);
        x += run;
      }
      if (nib & 1) nib++;
    }
  };
  decodeField(top, 0);
  decodeField(bottom, 1);
  spu.pixels = pixels;
  return spu;
}

// PGC palette entry (Y, Cr, Cb) -> [r, g, b]
export function paletteToRgb({ y, cr, cb }) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const yy = 1.164 * (y - 16);
  return [
    clamp(yy + 1.596 * (cr - 128)),
    clamp(yy - 0.813 * (cr - 128) - 0.391 * (cb - 128)),
    clamp(yy + 2.018 * (cb - 128)),
  ];
}
