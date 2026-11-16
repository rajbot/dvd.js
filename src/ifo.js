// Parsers for the DVD-Video IFO files (VIDEO_TS.IFO and VTS_xx_0.IFO).
// Layouts follow the DVD-Video spec as documented by libdvdread's ifo_types.h.

export const SECTOR = 2048;

function view(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

function ascii(u8, off, len) {
  return String.fromCharCode(...u8.subarray(off, off + len));
}

const bcd = (b) => (b >> 4) * 10 + (b & 0x0f);

// 4-byte BCD time (hh mm ss ff, top two bits of ff = frame rate) -> seconds.
// NTSC times count frames at a nominal 30 fps, so real time runs 0.1% longer.
export function parseDvdTime(u32) {
  const h = bcd((u32 >>> 24) & 0xff);
  const m = bcd((u32 >>> 16) & 0xff);
  const s = bcd((u32 >>> 8) & 0xff);
  const rate = (u32 >>> 6) & 0x03;
  const frames = bcd(u32 & 0x3f);
  const whole = h * 3600 + m * 60 + s;
  if (rate === 1) return whole + frames / 25;
  if (rate === 3) return (whole + frames / 30) * 1.001;
  return whole;
}

function parseVideoAttr(dv, off) {
  const b0 = dv.getUint8(off);
  const b1 = dv.getUint8(off + 1);
  const aspect = (b0 >> 2) & 3;
  return {
    mpegVersion: (b0 >> 6) & 3,
    format: (b0 >> 4) & 3 ? 'PAL' : 'NTSC',
    aspect: aspect === 3 ? '16:9' : '4:3',
    permittedDf: b0 & 3,
    pictureSize: (b1 >> 3) & 3,
    letterboxed: !!(b1 & 0x04),
    filmMode: !!(b1 & 0x01),
  };
}

function parseAudioAttr(dv, off) {
  const b0 = dv.getUint8(off);
  const b1 = dv.getUint8(off + 1);
  const hasLang = (b0 >> 2) & 3;
  const lang = hasLang ? String.fromCharCode(dv.getUint8(off + 2), dv.getUint8(off + 3)) : '';
  return {
    format: ['ac3', 'unknown', 'mpeg1', 'mpeg2ext', 'lpcm', 'unknown', 'dts', 'sdds'][(b0 >> 5) & 7],
    lang,
    channels: (b1 & 7) + 1,
    codeExtension: dv.getUint8(off + 5),
  };
}

function parseSubpAttr(dv, off) {
  const b0 = dv.getUint8(off);
  const lang = b0 & 3 ? String.fromCharCode(dv.getUint8(off + 2), dv.getUint8(off + 3)) : '';
  return { lang, codeExtension: dv.getUint8(off + 5) };
}

function parseCommands(dv, off, count) {
  const cmds = [];
  for (let i = 0; i < count; i++) {
    cmds.push(new Uint8Array(dv.buffer.slice(dv.byteOffset + off + i * 8, dv.byteOffset + off + i * 8 + 8)));
  }
  return cmds;
}

export function parsePGC(dv, off) {
  const nrPrograms = dv.getUint8(off + 2);
  const nrCells = dv.getUint8(off + 3);
  const pgc = {
    nrPrograms,
    nrCells,
    playbackTime: parseDvdTime(dv.getUint32(off + 4)),
    prohibitedOps: dv.getUint32(off + 8),
    audioControl: [],
    subpControl: [],
    nextPgcN: dv.getUint16(off + 0x9c),
    prevPgcN: dv.getUint16(off + 0x9e),
    goupPgcN: dv.getUint16(off + 0xa0),
    pgPlaybackMode: dv.getUint8(off + 0xa2),
    stillTime: dv.getUint8(off + 0xa3),
    palette: [],
    pre: [],
    post: [],
    cellCmds: [],
    programMap: [],
    cells: [],
    cellPositions: [],
  };
  for (let i = 0; i < 8; i++) pgc.audioControl.push(dv.getUint16(off + 0x0c + i * 2));
  for (let i = 0; i < 32; i++) pgc.subpControl.push(dv.getUint32(off + 0x1c + i * 4));
  for (let i = 0; i < 16; i++) {
    const p = off + 0xa4 + i * 4;
    pgc.palette.push({ y: dv.getUint8(p + 1), cr: dv.getUint8(p + 2), cb: dv.getUint8(p + 3) });
  }
  const cmdOff = dv.getUint16(off + 0xe4);
  const pgmOff = dv.getUint16(off + 0xe6);
  const cellOff = dv.getUint16(off + 0xe8);
  const posOff = dv.getUint16(off + 0xea);
  if (cmdOff) {
    const c = off + cmdOff;
    const nPre = dv.getUint16(c);
    const nPost = dv.getUint16(c + 2);
    const nCell = dv.getUint16(c + 4);
    pgc.pre = parseCommands(dv, c + 8, nPre);
    pgc.post = parseCommands(dv, c + 8 + nPre * 8, nPost);
    pgc.cellCmds = parseCommands(dv, c + 8 + (nPre + nPost) * 8, nCell);
  }
  if (pgmOff) {
    for (let i = 0; i < nrPrograms; i++) pgc.programMap.push(dv.getUint8(off + pgmOff + i));
  }
  if (cellOff) {
    for (let i = 0; i < nrCells; i++) {
      const c = off + cellOff + i * 24;
      const b0 = dv.getUint8(c);
      pgc.cells.push({
        blockMode: (b0 >> 6) & 3,
        blockType: (b0 >> 4) & 3,
        seamlessPlay: !!(b0 & 0x08),
        interleaved: !!(b0 & 0x04),
        stcDiscontinuity: !!(b0 & 0x02),
        seamlessAngle: !!(b0 & 0x01),
        stillTime: dv.getUint8(c + 2),
        cmdNr: dv.getUint8(c + 3),
        playbackTime: parseDvdTime(dv.getUint32(c + 4)),
        firstSector: dv.getUint32(c + 8),
        firstIlvuEndSector: dv.getUint32(c + 12),
        lastVobuStartSector: dv.getUint32(c + 16),
        lastSector: dv.getUint32(c + 20),
      });
    }
  }
  if (posOff) {
    for (let i = 0; i < nrCells; i++) {
      const c = off + posOff + i * 4;
      pgc.cellPositions.push({ vobId: dv.getUint16(c), cellId: dv.getUint8(c + 3) });
    }
  }
  return pgc;
}

function parsePGCIT(dv, off) {
  const n = dv.getUint16(off);
  const srps = [];
  for (let i = 0; i < n; i++) {
    const e = off + 8 + i * 8;
    const entryId = dv.getUint8(e);
    const b1 = dv.getUint8(e + 1);
    srps.push({
      entryId,
      blockMode: (b1 >> 6) & 3,
      blockType: (b1 >> 4) & 3,
      ptlIdMask: dv.getUint16(e + 2),
      pgc: parsePGC(dv, off + dv.getUint32(e + 4)),
    });
  }
  return srps;
}

function parsePGCIUT(dv, off) {
  const n = dv.getUint16(off);
  const lus = [];
  for (let i = 0; i < n; i++) {
    const e = off + 8 + i * 8;
    lus.push({
      lang: String.fromCharCode(dv.getUint8(e), dv.getUint8(e + 1)),
      exists: dv.getUint8(e + 3),
      pgcit: parsePGCIT(dv, off + dv.getUint32(e + 4)),
    });
  }
  return lus;
}

function parseCADT(dv, off) {
  const lastByte = dv.getUint32(off + 4);
  const n = Math.floor((lastByte + 1 - 8) / 12);
  const cells = [];
  for (let i = 0; i < n; i++) {
    const e = off + 8 + i * 12;
    cells.push({
      vobId: dv.getUint16(e),
      cellId: dv.getUint8(e + 2),
      startSector: dv.getUint32(e + 4),
      lastSector: dv.getUint32(e + 8),
    });
  }
  return cells;
}

function parseVobuAdmap(dv, off) {
  const lastByte = dv.getUint32(off);
  const n = Math.floor((lastByte + 1 - 4) / 4);
  const sectors = new Uint32Array(n);
  for (let i = 0; i < n; i++) sectors[i] = dv.getUint32(off + 4 + i * 4);
  return sectors;
}

function parseTTSRPT(dv, off) {
  const n = dv.getUint16(off);
  const titles = [];
  for (let i = 0; i < n; i++) {
    const e = off + 8 + i * 12;
    titles.push({
      playbackType: dv.getUint8(e),
      nrAngles: dv.getUint8(e + 1),
      nrPtts: dv.getUint16(e + 2),
      parentalId: dv.getUint16(e + 4),
      vtsN: dv.getUint8(e + 6),
      vtsTtn: dv.getUint8(e + 7),
      vtsSector: dv.getUint32(e + 8),
    });
  }
  return titles;
}

function parsePTTSRPT(dv, off) {
  const n = dv.getUint16(off);
  const lastByte = dv.getUint32(off + 4);
  const offsets = [];
  for (let i = 0; i < n; i++) offsets.push(dv.getUint32(off + 8 + i * 4));
  const titles = [];
  for (let i = 0; i < n; i++) {
    const end = i + 1 < n ? offsets[i + 1] : lastByte + 1;
    const ptts = [];
    for (let p = offsets[i]; p + 4 <= end; p += 4) {
      ptts.push({ pgcN: dv.getUint16(off + p), pgN: dv.getUint16(off + p + 2) });
    }
    titles.push(ptts);
  }
  return titles;
}

function parseMenuAttrs(dv, base) {
  const nAudio = dv.getUint8(base + 3);
  const nSubp = dv.getUint8(base + 0x55);
  return {
    video: parseVideoAttr(dv, base),
    audio: nAudio ? [parseAudioAttr(dv, base + 4)] : [],
    subp: nSubp ? [parseSubpAttr(dv, base + 0x56)] : [],
  };
}

// table(sectorField, parser): parse the table at the sector stored in the
// header, or return `empty` when the disc doesn't have that table.
function tableReader(dv) {
  return (field, parser, empty) => {
    const sector = dv.getUint32(field);
    if (!sector || sector * SECTOR >= dv.byteLength) return empty;
    return parser(dv, sector * SECTOR);
  };
}

export function parseVMG(u8) {
  if (ascii(u8, 0, 12) !== 'DVDVIDEO-VMG') throw new Error('Not a VIDEO_TS.IFO (bad magic)');
  const dv = view(u8);
  const table = tableReader(dv);
  const fpOff = dv.getUint32(0x84);
  return {
    type: 'VMG',
    nrTitleSets: dv.getUint16(0x3e),
    providerId: ascii(u8, 0x40, 32).replace(/\0+$/, ''),
    menuVobSector: dv.getUint32(0xc0),
    firstPlayPgc: fpOff ? parsePGC(dv, fpOff) : null,
    titles: table(0xc4, parseTTSRPT, []),
    menuUnits: table(0xc8, parsePGCIUT, []),
    menuCells: table(0xd8, parseCADT, []),
    menuVobus: table(0xdc, parseVobuAdmap, new Uint32Array(0)),
    menuAttrs: parseMenuAttrs(dv, 0x100),
  };
}

export function parseVTS(u8) {
  if (ascii(u8, 0, 12) !== 'DVDVIDEO-VTS') throw new Error('Not a VTS_xx_0.IFO (bad magic)');
  const dv = view(u8);
  const table = tableReader(dv);
  const nAudio = dv.getUint8(0x203);
  const nSubp = dv.getUint8(0x255);
  const audio = [];
  const subp = [];
  for (let i = 0; i < Math.min(nAudio, 8); i++) audio.push(parseAudioAttr(dv, 0x204 + i * 8));
  for (let i = 0; i < Math.min(nSubp, 32); i++) subp.push(parseSubpAttr(dv, 0x256 + i * 6));
  return {
    type: 'VTS',
    menuVobSector: dv.getUint32(0xc0),
    titleVobSector: dv.getUint32(0xc4),
    ptts: table(0xc8, parsePTTSRPT, []),
    pgcit: table(0xcc, parsePGCIT, []),
    menuUnits: table(0xd0, parsePGCIUT, []),
    menuCells: table(0xd8, parseCADT, []),
    menuVobus: table(0xdc, parseVobuAdmap, new Uint32Array(0)),
    titleCells: table(0xe0, parseCADT, []),
    titleVobus: table(0xe4, parseVobuAdmap, new Uint32Array(0)),
    menuAttrs: parseMenuAttrs(dv, 0x100),
    attrs: { video: parseVideoAttr(dv, 0x200), audio, subp },
  };
}
