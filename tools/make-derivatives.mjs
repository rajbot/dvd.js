#!/usr/bin/env node
// Build the streaming files dvd.js needs from a DVD image: one mp4 per VOB
// file (VIDEO_TS.mp4, VTS_01_0.mp4, VTS_01_1.mp4, ...).
//
//   node tools/make-derivatives.mjs [--extras-only] <disc image | VIDEO_TS dir> <out dir>
//
// For title VOBs it also writes the things an mp4 can't carry in a way
// browsers can switch between:
//   VTS_01_1.audio-a1.m4a   each further audio stream (named by stream id)
//   VTS_01_1.spu.bin        the subtitle (subpicture) streams
//   extras.json             which of those exist, and which audio stream each mp4 has
// and for menu VOBs, and title sets with buttons over the video, the part of
// the VOBs the player reads for the buttons:
//   VTS_01_0.nav.bin        the NAV packs and subpicture packs (of a title
//                           set's VOBs together, named after the first)
// --extras-only makes just these, next to mp4s made earlier. Each mp4 is
// tagged with the audio stream it holds; next to an mp4 without the tag
// (made by an older version) every audio stream is written as an m4a, since
// there is no telling which one that mp4 has.
//
// The mp4 of a title VOB gets the disc's first audio track, picked by stream
// id from the IFO. (ffmpeg's own "first audio stream" is whichever stream
// happens to come first in that file, which differs from VOB to VOB.)
//
// The mp4 timeline is the VOB's presentation timeline with every timestamp
// discontinuity closed up: mp4 time = the sum of the durations
// (vobu_e_ptm - vobu_s_ptm) of all VOBUs before that point in the file. Each
// run of VOBUs with continuous timestamps is transcoded on its own and the
// runs are concatenated, so stills and VOBs whose clocks restart keep their
// place. The player computes the same timeline from the IFO files.
//
// Requires ffmpeg, and 7z or bsdtar when given a disc image.

import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SECTOR, audioStreamId, parseVMG, parseVTS } from '../src/ifo.js';
import { SUBTITLE_MAGIC, VobScanner, isNavPack, isSubpicturePack } from '../src/nav.js';

const CHUNK = 8 * 1024 * 1024;

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...opts });
  if (res.error) throw new Error(`${cmd}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')}\n${res.stderr.toString().slice(-4000)}`);
  return res.stdout.toString();
}

function extractVideoTs(image, tmp) {
  const has = (cmd) => spawnSync('which', [cmd]).status === 0;
  if (has('7z')) run('7z', ['x', '-y', `-o${tmp}`, image, 'VIDEO_TS']);
  else run('bsdtar', ['-xf', image, '-C', tmp, 'VIDEO_TS']);
  return join(tmp, 'VIDEO_TS');
}

// The files of one VOB set, read as a single run of sectors.
class VobSet {
  constructor(dir, names) {
    this.files = [];
    let start = 0;
    for (const name of names) {
      const path = join(dir, name);
      const sectors = Math.floor(statSync(path).size / SECTOR);
      this.files.push({ name, path, start, sectors });
      start += sectors;
    }
    this.sectors = start;
  }

  scan() {
    const scanner = new VobScanner();
    const buf = Buffer.alloc(CHUNK);
    for (const file of this.files) {
      const fd = openSync(file.path, 'r');
      for (let pos = 0, n; (n = readSync(fd, buf, 0, CHUNK, pos)) > 0; pos += n) {
        scanner.push(new Uint8Array(buf.buffer, buf.byteOffset, n));
      }
      closeSync(fd);
    }
    return scanner;
  }

  // Copy sectors [from, to) of the set into `dest`.
  copy(from, to, dest) {
    const out = openSync(dest, 'w');
    const buf = Buffer.alloc(CHUNK);
    for (const file of this.files) {
      const a = Math.max(from, file.start);
      const b = Math.min(to, file.start + file.sectors);
      if (a >= b) continue;
      const fd = openSync(file.path, 'r');
      let pos = (a - file.start) * SECTOR;
      const end = (b - file.start) * SECTOR;
      while (pos < end) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, end - pos), pos);
        if (n <= 0) break;
        writeSync(out, buf, 0, n);
        pos += n;
      }
      closeSync(fd);
    }
    closeSync(out);
  }
}

// Split the VOBUs into runs with continuous timestamps. A run also ends at a
// VOB file boundary, so every run belongs to exactly one mp4.
function findRuns(vobus, set) {
  const fileOf = (sector) => set.files.findIndex((f) => sector >= f.start && sector < f.start + f.sectors);
  const runs = [];
  let time = 0;
  vobus.forEach((vobu, i) => {
    const file = fileOf(vobu.sector);
    const prev = vobus[i - 1];
    let run = runs[runs.length - 1];
    if (!run || run.file !== file || prev.pci.endPtm !== vobu.pci.startPtm) {
      run = { file, firstSector: vobu.sector, endSector: 0, startPtm: vobu.pci.startPtm, start: time, duration: 0, hasVideo: false, hasAudio: false, audio: new Set(), cells: [] };
      runs.push(run);
    }
    const next = vobus[i + 1];
    run.endSector = next ? next.sector : set.sectors;
    vobu.run = run;
    if (!prev || prev.dsi.vobId !== vobu.dsi.vobId || prev.dsi.cellId !== vobu.dsi.cellId) {
      run.cells.push({ vobId: vobu.dsi.vobId, cellId: vobu.dsi.cellId, sector: vobu.sector, start: time });
    }
    const dur = Math.max(0, vobu.pci.endPtm - vobu.pci.startPtm) / 90000;
    run.duration += dur;
    run.hasVideo ||= vobu.hasVideo;
    run.hasAudio ||= vobu.hasAudio;
    for (const id of vobu.audio) run.audio.add(id);
    vobu.time = time;
    time += dur;
  });
  // Runs with no video are left out of the mp4, so later runs start earlier
  // there than on the VOB's own timeline.
  const offsets = new Map();
  for (const run of runs) {
    run.mp4Start = inMp4(run) ? offsets.get(run.file) ?? 0 : null;
    if (inMp4(run)) offsets.set(run.file, run.mp4Start + run.duration);
  }
  return runs;
}

const inMp4 = (run) => run.hasVideo && run.duration > 0;

// Seconds into its file's mp4 of a time on the VOB set's timeline that falls
// in `run`, or null if the run isn't in the mp4.
const mp4Time = (run, time) => (run.mp4Start === null ? null : run.mp4Start + (time - run.start));

// Stream id of a title set's first audio track, or null if it has none.
function firstAudioTrack(vts) {
  for (const { pgc } of vts.pgcit) {
    for (let n = 0; n < 8; n++) {
      const attr = vts.attrs.audio[n];
      if (pgc.audioControl[n] & 0x8000 && attr) return audioStreamId(attr, pgc.audioControl[n]);
    }
  }
  return null;
}

// ffmpeg stream specifier for an audio stream id (MPEG audio ids are 0x1c0+).
const streamSpec = (id) => `#0x${(id >= 0xc0 ? 0x100 + id : id).toString(16)}`;
const hexOf = (id) => id.toString(16).padStart(2, '0');

// The mp4's comment says which audio stream it holds.
const AUDIO_TAG = /^dvd\.js audio=([0-9a-f]{2}|none)$/;

// The audio stream an existing mp4 holds: a stream id, null for none, or
// undefined when the mp4 doesn't say (or doesn't exist).
function taggedAudio(mp4Path) {
  const res = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=comment', '-of', 'default=nw=1:nk=1', mp4Path]);
  const tag = AUDIO_TAG.exec(res.status === 0 ? res.stdout.toString().trim() : '');
  if (!tag) return undefined;
  return tag[1] === 'none' ? null : parseInt(tag[1], 16);
}

// The sectors of each run as a file ffmpeg can read: the VOB itself when the
// run is all of it, else a copy, made once and shared by every encode.
class RunSources {
  constructor(set, file, tmp) {
    this.set = set;
    this.file = file;
    this.tmp = tmp;
    this.copies = new Map();
  }

  path(run) {
    const { file } = this;
    if (run.firstSector === file.start && run.endSector === file.start + file.sectors) return file.path;
    if (!this.copies.has(run)) {
      const copy = join(this.tmp, `${file.name}.${this.copies.size}.vob`);
      this.set.copy(run.firstSector, run.endSector, copy);
      this.copies.set(run, copy);
    }
    return this.copies.get(run);
  }

  clear() {
    for (const copy of this.copies.values()) rmSync(copy, { force: true });
    this.copies.clear();
  }
}

const INPUT = ['-analyzeduration', '100M', '-probesize', '100M', '-i'];

// Filter for one run's audio stream `spec` of input `input`, shifted to start
// at 0 and exactly as long as the run.
const audioFilter = (input, spec, run, label) => {
  const s = (run.startPtm / 90000).toFixed(6);
  const d = run.duration.toFixed(6);
  return `[${input}:${spec}]asetpts=PTS-${s}/TB,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${d},atrim=duration=${d}[${label}]`;
};
const silence = (run, label) => `anullsrc=r=48000:cl=stereo,atrim=duration=${run.duration.toFixed(6)}[${label}]`;

// mainAudio: the stream id the mp4 should carry, null for none, or undefined
// to take whatever audio there is (menus).
function encode(file, runs, sources, video, mainAudio, outPath) {
  const fps = video.format === 'PAL' ? '25' : '30000/1001';
  const fpsValue = video.format === 'PAL' ? 25 : 30000 / 1001;
  const height = video.format === 'PAL' ? 576 : 480;
  const dar = video.aspect === '16:9' ? '16/9' : '4/3';
  const audible = (r) => (mainAudio === undefined ? r.hasAudio : mainAudio !== null && r.audio.has(mainAudio));
  const audioSpec = mainAudio === undefined || mainAudio === null ? 'a:0' : streamSpec(mainAudio);
  const anyAudio = runs.some((r) => inMp4(r) && audible(r));
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-copyts'];
  const filters = [];
  const keyframes = [];
  let labels = '';
  let n = 0;
  for (const run of runs) {
    if (!inMp4(run)) continue;
    args.push(...INPUT, sources.path(run));
    const s = (run.startPtm / 90000).toFixed(6);
    const d = run.duration.toFixed(6);
    const frames = Math.round(run.duration * fpsValue);
    filters.push(
      `[${n}:v:0]bwdif=mode=send_frame:deint=interlaced,fps=${fps}:start_time=${s},setpts=PTS-${s}/TB,` +
        `scale=720:${height},setdar=${dar},format=yuv420p,tpad=stop_mode=clone:stop_duration=${d},trim=end_frame=${frames}[v${n}]`
    );
    if (anyAudio) filters.push(audible(run) ? audioFilter(n, audioSpec, run, `a${n}`) : silence(run, `a${n}`));
    labels += anyAudio ? `[v${n}][a${n}]` : `[v${n}]`;
    for (const cell of run.cells) keyframes.push(mp4Time(run, cell.start).toFixed(3));
    n++;
  }
  if (!n) return false;
  filters.push(`${labels}concat=n=${n}:v=1:a=${anyAudio ? 1 : 0}[v]${anyAudio ? '[a]' : ''}`);
  args.push('-filter_complex', filters.join(';'), '-map', '[v]');
  if (anyAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
  if (mainAudio !== undefined) args.push('-metadata', `comment=dvd.js audio=${anyAudio ? hexOf(mainAudio) : 'none'}`);
  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', fps, '-g', '60',
    '-force_key_frames', keyframes.join(','),
    '-movflags', '+faststart', outPath
  );
  run('ffmpeg', args);
  return true;
}

// The audio streams `ids` of a VOB file, each as an m4a on the same timeline
// as the file's mp4, in one pass. outPath(id) names each one.
function encodeAudio(runs, sources, ids, outPath) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-copyts'];
  const filters = [];
  const labels = new Map(ids.map((id) => [id, '']));
  let inputs = 0;
  let n = 0;
  for (const run of runs) {
    if (!inMp4(run)) continue;
    const present = ids.filter((id) => run.audio.has(id));
    if (present.length) args.push(...INPUT, sources.path(run));
    for (const id of ids) {
      const label = `a${hexOf(id)}_${n}`;
      filters.push(present.includes(id) ? audioFilter(inputs, streamSpec(id), run, label) : silence(run, label));
      labels.set(id, `${labels.get(id)}[${label}]`);
    }
    if (present.length) inputs++;
    n++;
  }
  if (!n || !ids.length) return false;
  for (const id of ids) filters.push(`${labels.get(id)}concat=n=${n}:v=0:a=1[out${hexOf(id)}]`);
  args.push('-filter_complex', filters.join(';'));
  for (const id of ids) args.push('-map', `[out${hexOf(id)}]`, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath(id));
  run('ffmpeg', args);
  return true;
}

// The subpicture units of one VOB file, timed against its mp4.
function subtitleFile(scanner, file) {
  const chunks = [Buffer.from(SUBTITLE_MAGIC)];
  for (const [stream, units] of scanner.spus) {
    for (const unit of units) {
      const vobu = scanner.vobus[unit.vobu];
      if (!vobu || unit.pts === null || vobu.sector < file.start || vobu.sector >= file.start + file.sectors) continue;
      const start = mp4Time(vobu.run, vobu.time);
      if (start === null) continue;
      let ticks = (unit.pts - vobu.pci.startPtm) % 0x100000000; // PTS is 33 bits, the VOBU's start 32
      if (ticks < -0x80000000) ticks += 0x100000000;
      if (ticks > 0x80000000) ticks -= 0x100000000;
      const head = Buffer.alloc(7);
      head.writeUInt8(stream, 0);
      head.writeUInt32BE(Math.max(0, Math.round((start + ticks / 90000) * 1000)), 1);
      head.writeUInt16BE(unit.data.length, 5);
      chunks.push(head, Buffer.from(unit.data));
    }
  }
  return chunks.length > 1 ? Buffer.concat(chunks) : null;
}

// The NAV packs and subpicture packs of a VOB set, in order: everything the
// player reads from it (the buttons and their highlights) without the video
// and audio, so it doesn't have to download the VOBs to find them.
function navFile(set, dest) {
  const out = openSync(dest, 'w');
  const buf = Buffer.alloc(CHUNK);
  let bytes = 0;
  for (const file of set.files) {
    const fd = openSync(file.path, 'r');
    for (let pos = 0, n; (n = readSync(fd, buf, 0, CHUNK, pos)) > 0; pos += n) {
      for (let off = 0; off + SECTOR <= n; off += SECTOR) {
        if (isNavPack(buf, off) || isSubpicturePack(buf, off)) bytes += writeSync(out, buf, off, SECTOR);
      }
    }
    closeSync(fd);
  }
  closeSync(out);
  return bytes;
}

function main() {
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const extrasOnly = flags.includes('--extras-only');
  const [input, outArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!input || !outArg) {
    console.error('usage: make-derivatives.mjs [--extras-only] <disc image | VIDEO_TS dir> <out dir>');
    process.exit(2);
  }
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'dvdjs-'));
  try {
    const dir = statSync(input).isDirectory() ? resolve(input) : extractVideoTs(resolve(input), tmp);
    const names = readdirSync(dir).map((n) => n.toUpperCase());
    const vmg = parseVMG(new Uint8Array(readFileSync(join(dir, 'VIDEO_TS.IFO'))));
    const sets = [];
    if (names.includes('VIDEO_TS.VOB')) sets.push({ names: ['VIDEO_TS.VOB'], video: vmg.menuAttrs.video });
    for (let v = 1; v <= vmg.nrTitleSets; v++) {
      const id = String(v).padStart(2, '0');
      const vts = parseVTS(new Uint8Array(readFileSync(join(dir, `VTS_${id}_0.IFO`))));
      if (names.includes(`VTS_${id}_0.VOB`)) sets.push({ names: [`VTS_${id}_0.VOB`], video: vts.menuAttrs.video });
      const titles = names.filter((n) => new RegExp(`^VTS_${id}_[1-9]\\.VOB$`).test(n)).sort();
      if (titles.length) sets.push({ names: titles, video: vts.attrs.video, title: true, firstAudio: firstAudioTrack(vts) });
    }
    const report = [];
    const manifest = {};
    for (const { names: vobNames, video, title, firstAudio } of sets) {
      const set = new VobSet(dir, vobNames);
      const scanner = set.scan();
      const runs = findRuns(scanner.vobus, set);
      // Menus always get a nav file; titles only if they put buttons over the video.
      if (runs.some(inMp4) && (!title || scanner.vobus.some((vobu) => vobu.pci.hli.status && vobu.pci.hli.btnNs))) {
        const nav = set.files[0].name.replace(/\.VOB$/, '.nav.bin');
        const bytes = navFile(set, join(out, nav));
        process.stderr.write(`${vobNames.join(' ')}: buttons -> ${nav} (${bytes} bytes)\n`);
      }
      set.files.forEach((file, i) => {
        const mine = runs.filter((r) => r.file === i);
        const name = file.name.replace(/\.VOB$/, '.mp4');
        const base = name.replace(/\.mp4$/, '');
        const duration = mine.reduce((a, r) => a + (inMp4(r) ? r.duration : 0), 0);
        process.stderr.write(`${file.name}: ${mine.length} run(s), ${duration.toFixed(3)}s -> ${name}\n`);
        if (!mine.some(inMp4)) {
          process.stderr.write(`  no video, skipped\n`);
          return;
        }
        const sources = new RunSources(set, file, tmp);
        try {
          // What the mp4 holds: the title set's first track, when this VOB has it.
          let mainAudio = title ? (firstAudio !== null && mine.some((r) => inMp4(r) && r.audio.has(firstAudio)) ? firstAudio : null) : undefined;
          if (extrasOnly) {
            mainAudio = title ? taggedAudio(join(out, name)) : undefined;
          } else {
            encode(file, mine, sources, video, mainAudio, join(out, name));
            report.push({
              vob: file.name,
              mp4: name,
              duration: +duration.toFixed(6),
              cells: mine.filter(inMp4).flatMap((r) => r.cells.map((c) => ({ vobId: c.vobId, cellId: c.cellId, sector: c.sector, start: +mp4Time(r, c.start).toFixed(6) }))),
            });
          }
          if (!title) return;
          // main: null says the mp4's own audio isn't any of the tracks.
          const extras = { main: mainAudio === undefined || mainAudio === null ? null : hexOf(mainAudio), audio: [], subs: false };
          const ids = [...new Set(mine.filter(inMp4).flatMap((r) => [...r.audio]))].sort((a, b) => a - b).filter((id) => id !== mainAudio);
          if (ids.length) {
            process.stderr.write(`  audio streams ${ids.map((id) => `0x${hexOf(id)}`).join(', ')} -> ${base}.audio-*.m4a\n`);
            encodeAudio(mine, sources, ids, (id) => join(out, `${base}.audio-${hexOf(id)}.m4a`));
            extras.audio = ids.map(hexOf);
          }
          const subs = subtitleFile(scanner, file);
          if (subs) {
            process.stderr.write(`  subtitles -> ${base}.spu.bin (${subs.length} bytes)\n`);
            writeFileSync(join(out, `${base}.spu.bin`), subs);
            extras.subs = true;
          }
          manifest[base] = extras;
        } finally {
          sources.clear();
        }
      });
    }
    writeFileSync(join(out, 'extras.json'), `${JSON.stringify(manifest, null, 1)}\n`);
    if (!extrasOnly) console.log(JSON.stringify(report, null, 1));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
