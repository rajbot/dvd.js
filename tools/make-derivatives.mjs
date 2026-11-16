#!/usr/bin/env node
// Build the streaming files dvd.js needs from a DVD image: one mp4 per VOB
// file (VIDEO_TS.mp4, VTS_01_0.mp4, VTS_01_1.mp4, ...).
//
//   node tools/make-derivatives.mjs <disc image | VIDEO_TS dir> <out dir>
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
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SECTOR, parseVMG, parseVTS } from '../src/ifo.js';
import { VobScanner } from '../src/nav.js';

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
    return scanner.vobus;
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
      run = { file, firstSector: vobu.sector, endSector: 0, startPtm: vobu.pci.startPtm, start: time, duration: 0, hasVideo: false, hasAudio: false, cells: [] };
      runs.push(run);
    }
    const next = vobus[i + 1];
    run.endSector = next ? next.sector : set.sectors;
    if (!prev || prev.dsi.vobId !== vobu.dsi.vobId || prev.dsi.cellId !== vobu.dsi.cellId) {
      run.cells.push({ vobId: vobu.dsi.vobId, cellId: vobu.dsi.cellId, sector: vobu.sector, start: time });
    }
    const dur = Math.max(0, vobu.pci.endPtm - vobu.pci.startPtm) / 90000;
    run.duration += dur;
    run.hasVideo ||= vobu.hasVideo;
    run.hasAudio ||= vobu.hasAudio;
    time += dur;
  });
  return runs;
}

function encode(set, fileIndex, runs, video, outPath, tmp) {
  const file = set.files[fileIndex];
  const fps = video.format === 'PAL' ? '25' : '30000/1001';
  const fpsValue = video.format === 'PAL' ? 25 : 30000 / 1001;
  const height = video.format === 'PAL' ? 576 : 480;
  const dar = video.aspect === '16:9' ? '16/9' : '4/3';
  const anyAudio = runs.some((r) => r.hasAudio);
  const fileStart = runs[0].start;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-copyts'];
  const filters = [];
  const keyframes = [];
  let inputs = 0;
  let labels = '';
  let n = 0;
  for (const run of runs) {
    if (!run.hasVideo || run.duration <= 0) continue;
    const whole = run.firstSector === file.start && run.endSector === file.start + file.sectors;
    let src = file.path;
    if (!whole) {
      src = join(tmp, `${file.name}.${n}.vob`);
      set.copy(run.firstSector, run.endSector, src);
    }
    args.push('-analyzeduration', '100M', '-probesize', '100M', '-i', src);
    const s = (run.startPtm / 90000).toFixed(6);
    const d = run.duration.toFixed(6);
    const frames = Math.round(run.duration * fpsValue);
    filters.push(
      `[${inputs}:v:0]bwdif=mode=send_frame:deint=interlaced,fps=${fps}:start_time=${s},setpts=PTS-${s}/TB,` +
        `scale=720:${height},setdar=${dar},format=yuv420p,tpad=stop_mode=clone:stop_duration=${d},trim=end_frame=${frames}[v${n}]`
    );
    if (anyAudio) {
      filters.push(
        run.hasAudio
          ? `[${inputs}:a:0]asetpts=PTS-${s}/TB,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${d},atrim=duration=${d}[a${n}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${d}[a${n}]`
      );
    }
    labels += anyAudio ? `[v${n}][a${n}]` : `[v${n}]`;
    for (const cell of run.cells) keyframes.push((cell.start - fileStart).toFixed(3));
    inputs++;
    n++;
  }
  if (!n) return false;
  filters.push(`${labels}concat=n=${n}:v=1:a=${anyAudio ? 1 : 0}[v]${anyAudio ? '[a]' : ''}`);
  args.push('-filter_complex', filters.join(';'), '-map', '[v]');
  if (anyAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', fps, '-g', '60',
    '-force_key_frames', keyframes.join(','),
    '-movflags', '+faststart', outPath
  );
  run('ffmpeg', args);
  return true;
}

function main() {
  const [input, outArg] = process.argv.slice(2);
  if (!input || !outArg) {
    console.error('usage: make-derivatives.mjs <disc image | VIDEO_TS dir> <out dir>');
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
      if (titles.length) sets.push({ names: titles, video: vts.attrs.video });
    }
    const report = [];
    for (const { names: vobNames, video } of sets) {
      const set = new VobSet(dir, vobNames);
      const runs = findRuns(set.scan(), set);
      set.files.forEach((file, i) => {
        const mine = runs.filter((r) => r.file === i);
        const name = file.name.replace(/\.VOB$/, '.mp4');
        const duration = mine.reduce((a, r) => a + r.duration, 0);
        process.stderr.write(`${file.name}: ${mine.length} run(s), ${duration.toFixed(3)}s -> ${name}\n`);
        if (!mine.length || !encode(set, i, mine, video, join(out, name), tmp)) {
          process.stderr.write(`  no video, skipped\n`);
          return;
        }
        report.push({
          vob: file.name,
          mp4: name,
          duration: +duration.toFixed(6),
          cells: mine.flatMap((r) => r.cells.map((c) => ({ vobId: c.vobId, cellId: c.cellId, sector: c.sector, start: +(c.start - mine[0].start).toFixed(6) }))),
        });
      });
    }
    console.log(JSON.stringify(report, null, 1));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
