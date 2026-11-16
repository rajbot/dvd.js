// Builders for minimal IFO images, so the tests need no disc.

export function cmd(hex) {
  return Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
}

// One PGC as raw bytes. cells: [{ time (BCD u32), first, last, still, vobId, cellId }]
export function buildPGC({ cells = [], pre = [], post = [], next = 0, time = 0 } = {}) {
  const cmdOff = 0xec;
  const cmdLen = 8 + (pre.length + post.length) * 8;
  const pgmOff = cmdOff + cmdLen;
  const cellOff = pgmOff + 2;
  const posOff = cellOff + cells.length * 24;
  const u8 = new Uint8Array(posOff + cells.length * 4);
  const dv = new DataView(u8.buffer);
  dv.setUint8(2, cells.length ? 1 : 0);
  dv.setUint8(3, cells.length);
  dv.setUint32(4, time);
  dv.setUint16(0x9c, next);
  dv.setUint16(0xe4, cmdOff);
  dv.setUint16(cmdOff, pre.length);
  dv.setUint16(cmdOff + 2, post.length);
  [...pre, ...post].forEach((c, i) => u8.set(cmd(c), cmdOff + 8 + i * 8));
  if (cells.length) {
    dv.setUint16(0xe6, pgmOff);
    dv.setUint16(0xe8, cellOff);
    dv.setUint16(0xea, posOff);
    dv.setUint8(pgmOff, 1);
  }
  cells.forEach((cell, i) => {
    const c = cellOff + i * 24;
    dv.setUint8(c, ((cell.blockMode || 0) << 6) | ((cell.blockMode ? 1 : 0) << 4)); // an angle block
    dv.setUint8(c + 2, cell.still || 0);
    dv.setUint32(c + 4, cell.time || 0);
    dv.setUint32(c + 8, cell.first || 0);
    dv.setUint32(c + 20, cell.last || 0);
    dv.setUint16(posOff + i * 4, cell.vobId || 1);
    dv.setUint8(posOff + i * 4 + 3, cell.cellId || i + 1);
  });
  return u8;
}

function buildPGCIT(pgcs) {
  const head = 8 + pgcs.length * 8;
  const size = head + pgcs.reduce((n, p) => n + p.bytes.length, 0);
  const u8 = new Uint8Array(size);
  const dv = new DataView(u8.buffer);
  dv.setUint16(0, pgcs.length);
  dv.setUint32(4, size - 1);
  let off = head;
  pgcs.forEach((p, i) => {
    dv.setUint8(8 + i * 8, p.entryId || 0);
    dv.setUint32(8 + i * 8 + 4, off);
    u8.set(p.bytes, off);
    off += p.bytes.length;
  });
  return u8;
}

function buildPGCIUT(pgcs) {
  const it = buildPGCIT(pgcs);
  const u8 = new Uint8Array(16 + it.length);
  const dv = new DataView(u8.buffer);
  dv.setUint16(0, 1);
  u8.set([0x65, 0x6e], 8); // "en"
  dv.setUint32(12, 16);
  u8.set(it, 16);
  return u8;
}

function assemble(magic, header, tables) {
  const sectors = 1 + tables.length;
  const u8 = new Uint8Array(sectors * 2048 + 2048);
  const dv = new DataView(u8.buffer);
  u8.set([...magic].map((c) => c.charCodeAt(0)));
  header(dv, u8);
  tables.forEach(([field, bytes], i) => {
    if (bytes.length > 2048) throw new Error('test table too large');
    dv.setUint32(field, i + 1);
    u8.set(bytes, (i + 1) * 2048);
  });
  return u8;
}

// titles: [{ vtsN, vtsTtn }]; menus: [{ entryId, bytes }]
export function buildVMG({ firstPlay, titles = [], menus = [], nrTitleSets = 1 }) {
  const tt = new Uint8Array(8 + titles.length * 12);
  const tdv = new DataView(tt.buffer);
  tdv.setUint16(0, titles.length);
  titles.forEach((t, i) => {
    tdv.setUint8(8 + i * 12 + 1, 1);
    tdv.setUint16(8 + i * 12 + 2, 1);
    tdv.setUint8(8 + i * 12 + 6, t.vtsN);
    tdv.setUint8(8 + i * 12 + 7, t.vtsTtn);
  });
  const tables = [[0xc4, tt]];
  if (menus.length) tables.push([0xc8, buildPGCIUT(menus)]);
  return assemble(
    'DVDVIDEO-VMG',
    (dv, u8) => {
      dv.setUint16(0x3e, nrTitleSets);
      if (firstPlay) {
        dv.setUint32(0x84, 0x400);
        u8.set(firstPlay, 0x400);
      }
    },
    tables
  );
}

// pgcs: title PGCs [{ bytes }]; one title (and one part) per PGC
export function buildVTS({ pgcs, menus = [] }) {
  const ptt = new Uint8Array(8 + pgcs.length * 8);
  const pdv = new DataView(ptt.buffer);
  pdv.setUint16(0, pgcs.length);
  pdv.setUint32(4, ptt.length - 1);
  pgcs.forEach((_, i) => {
    const off = 8 + pgcs.length * 4 + i * 4;
    pdv.setUint32(8 + i * 4, off);
    pdv.setUint16(off, i + 1);
    pdv.setUint16(off + 2, 1);
  });
  const tables = [
    [0xc8, ptt],
    [0xcc, buildPGCIT(pgcs.map((p, i) => ({ entryId: 0x81 + i, ...p })))],
  ];
  if (menus.length) tables.push([0xd0, buildPGCIUT(menus)]);
  return assemble('DVDVIDEO-VTS', () => {}, tables);
}
