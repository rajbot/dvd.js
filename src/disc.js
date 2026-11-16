// The disc as the player sees it: the parsed IFOs plus, for every VOB set
// (VMG menu, each title set's menu, each title set's titles), where each cell
// sits on the timeline of that set's mp4s.
//
// mp4 time is the sum of the durations of everything before that point in the
// VOB set. For title VOBs it is worked out from the IFOs alone (cell playback
// times, in the order the cells are stored). Menu VOBs are small, so they are
// also read as a stream while the disc plays: their NAV packs give exact times
// and the button tables, and their subpictures give the button highlights.

import { Domain } from './vm.js';
import { audioStreamId, parseVMG, parseVTS } from './ifo.js';
import { VobScanner, decodeSpu } from './nav.js';

const AUDIO_FORMAT = { ac3: 'Dolby Digital', dts: 'DTS', lpcm: 'PCM', mpeg1: 'MPEG', mpeg2ext: 'MPEG' };
const AUDIO_KIND = { 2: 'for the visually impaired', 3: 'commentary', 4: 'commentary 2' };
const SUBTITLE_KIND = { 2: 'large', 3: 'for children', 5: 'captions', 6: 'large captions', 7: 'captions for children', 9: 'forced', 13: 'commentary', 14: 'large commentary', 15: 'commentary for children' };
const languages = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames(['en'], { type: 'language' }) : null;

function languageName(code) {
  if (!/^[a-z]{2}$/.test(code)) return '';
  try {
    return (languages && languages.of(code)) || code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

// "2.0", "5.1": how a track's channel count is usually written.
function channelLayout(channels) {
  if (channels <= 2) return `${channels}.0`;
  if (channels === 6 || channels === 8) return `${channels - 1}.1`;
  return `${channels} ch`;
}

const pad = (n) => String(n).padStart(2, '0');
const cellKey = ({ vobId, cellId }) => `${vobId}:${cellId}`;
const MIN_SEGMENT = 0.1;
const GUESSED_VOBU = 0.5; // seconds, for cells no PGC gives a time for

// NAV packs and subpictures of a menu VOB, filled in as the VOB streams in.
export class MenuScan {
  constructor() {
    this.scanner = new VobScanner();
    this.timed = 0; // VOBUs that have been given a time
    this.cells = new Map(); // "vobId:cellId" -> index of the cell's first VOBU
    this.complete = false;
    this.error = null;
    this.decoded = new WeakMap();
  }

  async run(stream, maxBytes) {
    const reader = stream.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        this.complete = true;
        return;
      }
      this.push(value);
      bytes += value.length;
      if (bytes >= maxBytes) {
        await reader.cancel();
        return;
      }
    }
  }

  push(chunk) {
    this.scanner.push(chunk);
    const vobus = this.scanner.vobus;
    for (; this.timed < vobus.length; this.timed++) {
      const vobu = vobus[this.timed];
      const prev = vobus[this.timed - 1];
      vobu.time = prev ? prev.time + prev.duration : 0;
      vobu.duration = Math.max(0, vobu.pci.endPtm - vobu.pci.startPtm) / 90000;
      const key = cellKey(vobu.dsi);
      if (!this.cells.has(key)) this.cells.set(key, this.timed);
    }
  }

  // { start, end } of a cell, as far as the scan knows; end is null until
  // the scan has got past the cell.
  cellSpan(key) {
    const vobus = this.scanner.vobus;
    const first = this.cells.get(key);
    if (first === undefined) return null;
    let i = first;
    while (i < this.timed && cellKey(vobus[i].dsi) === key) i++;
    const last = vobus[this.timed - 1];
    let end = null;
    if (i < this.timed) end = vobus[i].time;
    else if (this.complete) end = last.time + last.duration;
    return { start: vobus[first].time, end };
  }

  // Buttons and highlight subpicture in force at `time` within a cell.
  stateAt(key, time) {
    const vobus = this.scanner.vobus;
    const first = this.cells.get(key);
    if (first === undefined) return null;
    let i = first;
    while (i + 1 < this.timed && cellKey(vobus[i + 1].dsi) === key && vobus[i + 1].time <= time) i++;
    const at = i;
    // "use the previous VOBU's highlight information"
    while (i > first && vobus[i].pci.hli.status >= 2 && !vobus[i].pci.hli.buttons.length) i--;
    const hli = vobus[i].pci.hli;
    if (!hli.status || !hli.buttons.length) return null;
    return { hli, spu: this.spuAt(key, at) };
  }

  spuAt(key, vobuIndex) {
    const streams = [...this.scanner.spus.keys()].sort((a, b) => a - b);
    if (!streams.length) return null;
    const vobus = this.scanner.vobus;
    let found = null;
    for (const unit of this.scanner.spus.get(streams[0])) {
      if (unit.vobu > vobuIndex) break;
      if (unit.vobu >= 0 && cellKey(vobus[unit.vobu].dsi) === key) found = unit;
    }
    if (!found) return null;
    if (!this.decoded.has(found)) this.decoded.set(found, decodeSpu(found.data));
    const spu = this.decoded.get(found);
    return spu.pixels ? spu : null;
  }
}

// Where each cell of a VOB set starts on the set's timeline, from the IFOs:
// the cell address table gives the order, the PGCs give the durations.
function layoutCells(cellTable, vobuSectors, pgcs) {
  const durations = new Map();
  for (const pgc of pgcs) {
    pgc.cells.forEach((cell, i) => {
      const pos = pgc.cellPositions[i];
      if (pos && cell.playbackTime > 0) durations.set(cellKey(pos), cell.playbackTime);
    });
  }
  const cells = new Map();
  let time = 0;
  for (const entry of [...cellTable].sort((a, b) => a.startSector - b.startSector)) {
    const key = cellKey(entry);
    if (cells.has(key)) continue;
    let duration = durations.get(key);
    if (duration === undefined) {
      const vobus = vobuSectors.filter((s) => s >= entry.startSector && s <= entry.lastSector).length;
      duration = vobus * GUESSED_VOBU;
    }
    cells.set(key, { start: time, end: time + duration });
    time += duration;
  }
  return cells;
}

function probeDuration(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => resolve(video.duration);
    video.onerror = () => reject(new Error(`Could not load ${url}`));
    video.src = url;
  });
}

export class Disc {
  static async open(source, { maxMenuBytes = 512 * 1024 * 1024 } = {}) {
    const vmg = parseVMG(await source.readFile('VIDEO_TS.IFO'));
    const numbers = Array.from({ length: vmg.nrTitleSets }, (_, i) => i + 1);
    const ifos = await Promise.all(numbers.map((n) => source.readFile(`VTS_${pad(n)}_0.IFO`)));
    const vts = {};
    numbers.forEach((n, i) => {
      vts[n] = parseVTS(ifos[i]);
    });
    const disc = new Disc(source, vmg, vts);

    const menuPgcs = (units) => units.flatMap((lu) => lu.pgcit.map((srp) => srp.pgc));
    const jobs = [disc.addSet(Domain.VMGM, 0, ['VIDEO_TS'], vmg.menuVobSector ? 'VIDEO_TS.VOB' : null, vmg.menuCells, vmg.menuVobus, menuPgcs(vmg.menuUnits), vmg.menuAttrs.video)];
    for (const n of numbers) {
      const t = vts[n];
      const id = `VTS_${pad(n)}`;
      jobs.push(disc.addSet(Domain.VTSM, n, [`${id}_0`], t.menuVobSector ? `${id}_0.VOB` : null, t.menuCells, t.menuVobus, menuPgcs(t.menuUnits), t.menuAttrs.video));
      const titleFiles = Array.from({ length: 9 }, (_, i) => `${id}_${i + 1}`);
      jobs.push(disc.addSet(Domain.VTS, n, titleFiles, null, t.titleCells, t.titleVobus, t.pgcit.map((srp) => srp.pgc), t.attrs.video));
    }
    await Promise.all(jobs);
    disc.scanMenus(maxMenuBytes);
    return disc;
  }

  constructor(source, vmg, vts) {
    this.source = source;
    this.vmg = vmg;
    this.vts = vts;
    this.sets = new Map();
  }

  async addSet(domain, vtsN, bases, menuVob, cellTable, vobuSectors, pgcs, video) {
    const set = {
      key: `${domain}:${vtsN}`,
      menuVob,
      video,
      cells: layoutCells(cellTable, Array.from(vobuSectors), pgcs),
      files: [],
      scan: null,
    };
    this.sets.set(set.key, set);
    // Title sets are split into VTS_xx_1.VOB, _2.VOB, ...: one mp4 each.
    for (const base of bases) {
      const mp4 = await this.source.mp4(base);
      if (!mp4) break;
      const extras = domain === Domain.VTS && this.source.extras ? await this.source.extras(base) : null;
      set.files.push({ ...mp4, base, start: 0, extras });
    }
    for (let i = 1; i < set.files.length; i++) {
      const prev = set.files[i - 1];
      prev.duration ??= await probeDuration(prev.url);
      set.files[i].start = prev.start + prev.duration;
    }
  }

  // Start reading the menu VOBs. Nothing waits for this: the menus play as
  // soon as their mp4 does, and the buttons appear once the scan reaches them.
  scanMenus(maxBytes) {
    for (const set of this.sets.values()) {
      // A menu VOB can be hundreds of megabytes; its buttons are a few of
      // them, and may have been put in a file of their own.
      const base = set.menuVob ? set.menuVob.replace(/\.VOB$/, '') : set.files[0]?.base;
      const nav = base && this.source.openNav ? this.source.openNav(base).catch(() => null) : Promise.resolve(null);
      if (set.menuVob) {
        set.scan = new MenuScan();
        nav
          .then((stream) => stream || this.source.openStream(set.menuVob))
          .then((stream) => set.scan.run(stream, maxBytes))
          .catch((err) => {
            set.scan.error = err;
          });
      } else {
        // Title VOBs are too big to read, so a title's buttons over the
        // video only work when there is such a file.
        nav.then((stream) => {
          if (!stream) return;
          const scan = new MenuScan();
          scan.run(stream, maxBytes).then(() => {
            set.scan = scan;
          }, () => {});
        });
      }
    }
  }

  setFor(step) {
    const key = step.domain === Domain.VMGM ? `${Domain.VMGM}:0` : `${step.domain}:${step.vtsN}`;
    return this.sets.get(key);
  }

  // { start, end } of a cell on its set's timeline, or null if unknown.
  cellSpan(set, position) {
    const key = cellKey(position);
    const fromIfo = set.cells.get(key);
    const scanned = set.scan && set.scan.cellSpan(key);
    if (!scanned) return fromIfo || null;
    const length = fromIfo ? fromIfo.end - fromIfo.start : 0;
    return { start: scanned.start, end: scanned.end ?? scanned.start + length };
  }

  // The pieces of mp4 that make up a cell: [{ file, from, to }], times
  // relative to the file. Empty if the set has no mp4s.
  segments(set, position) {
    const span = this.cellSpan(set, position);
    if (!span) return [];
    const segments = [];
    set.files.forEach((file, i) => {
      const next = set.files[i + 1];
      const from = Math.max(span.start, file.start);
      const to = Math.min(span.end, next ? next.start : Infinity);
      if (to - from >= MIN_SEGMENT || (to > from && span.end - span.start < MIN_SEGMENT)) {
        segments.push({ file, from: from - file.start, to: to - file.start });
      }
    });
    return segments;
  }

  // The audio and subtitle tracks of the title being played, and which of
  // them `file` (one of the title set's mp4s) can actually provide.
  tracks(step, file) {
    const attrs = this.vts[step.vtsN].attrs;
    const extras = file.extras;
    const audio = [];
    step.pgc.audioControl.forEach((control, n) => {
      const attr = attrs.audio[n];
      if (!(control & 0x8000) || !attr) return;
      const id = audioStreamId(attr, control).toString(16).padStart(2, '0');
      const url = (extras && extras.audio.get(id)) || null;
      // Without extras.json all we know is that the mp4 has one of them.
      const inMp4 = extras ? extras.main === id : audio.length === 0;
      const what = [languageName(attr.lang) || `Track ${n + 1}`, AUDIO_KIND[attr.codeExtension]].filter(Boolean).join(' ');
      audio.push({ n, id, url, available: inMp4 || !!url, short: what, label: `${what} (${AUDIO_FORMAT[attr.format] || attr.format} ${channelLayout(attr.channels)})` });
    });
    const wide = attrs.video.aspect === '16:9';
    const subs = [];
    step.pgc.subpControl.forEach((control, n) => {
      const attr = attrs.subp[n];
      if (!(control >>> 31) || !attr) return;
      const id = 0x20 + ((control >>> (wide ? 16 : 24)) & 0x1f);
      const what = [languageName(attr.lang) || `Track ${n + 1}`, SUBTITLE_KIND[attr.codeExtension]].filter(Boolean).join(' ');
      subs.push({ n, id, available: !!(extras && extras.subsUrl), label: what });
    });
    // Tell apart tracks that would otherwise read the same ("English", "English").
    const number = (list, field) => {
      const names = list.map((track) => track[field]);
      list.forEach((track, i) => {
        if (names.filter((name) => name === names[i]).length > 1) track[field] = `${names[i]} ${names.slice(0, i + 1).filter((name) => name === names[i]).length}`;
      });
    };
    number(audio, 'label');
    number(audio, 'short');
    number(subs, 'label');
    return { audio, subs };
  }

  menuState(set, position, time) {
    return set.scan ? set.scan.stateAt(cellKey(position), time) : null;
  }
}
