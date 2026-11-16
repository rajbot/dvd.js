// The player: runs the DVD VM against a Disc and plays the cells it asks for
// by seeking around the streaming mp4s. Menu buttons are drawn on a canvas
// over the video from the highlight data in the menu VOB.

import { Disc } from './disc.js';
import { decodeSpu, paletteToRgb, parseSubtitles } from './nav.js';
import { Domain, DvdVM } from './vm.js';

const END_EPSILON = 0.02; // a cell is over this close to its end
const STILL_EPSILON = 0.05; // stop this early to hold a cell's last frame
const SEAMLESS = 0.1; // don't seek if the video is already this close
const MAX_VIDEOS = 4;
const MAX_EMPTY_CELLS = 64;
const ACTION_FLASH = 150; // ms a button shows its "action" colours
const SKIP = 10; // seconds for the arrow keys
const AUDIO_DRIFT = 0.2; // seconds a separate audio track may be off the video
const SUBTITLE_MAX = 20; // seconds a subtitle with no end time stays up

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

export class DvdPlayer {
  // source: an ArchiveSource or UrlSource (see archive.js)
  static async create(container, source, options = {}) {
    const player = new DvdPlayer(container, options);
    player.message('Loading disc…');
    try {
      player.load(await Disc.open(source));
    } catch (err) {
      player.fail(err);
    }
    return player;
  }

  constructor(container, { debug = false } = {}) {
    this.debug = debug;
    this.disc = null;
    this.vm = null;
    this.step = null; // the cell being played
    this.set = null;
    this.segments = [];
    this.segment = 0;
    this.video = null; // the visible <video>
    this.incoming = null; // a <video> waiting for its first frame
    this.videos = new Map(); // mp4 url -> <video>
    this.still = null; // { timer } while a cell's still time runs
    this.paused = false; // paused by the user
    this.skippedMenus = false;
    this.flash = null; // button number showing its action colours
    this.drawn = '';
    this.volume = 1;
    this.muted = false;
    this.tracks = { audio: [], subs: [] }; // of the title being played
    this.audioTrack = null; // the one being heard
    this.altUrl = null; // its file, when it isn't the mp4's own audio
    this.subTrack = null; // the subtitle track being shown
    this.subs = null; // its subpicture units, once loaded
    this.menus = '';
    this.build(container);
    const frame = () => {
      this.tick();
      this.syncAudio();
      this.draw();
      this.refresh();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ---- DOM -------------------------------------------------------------------

  build(container) {
    this.root = el('div', 'dvd-player');
    this.root.tabIndex = 0;
    this.stage = el('div', 'dvd-stage');
    this.canvas = el('canvas', 'dvd-overlay');
    this.canvas.width = 720;
    this.canvas.height = 480;
    this.ctx = this.canvas.getContext('2d');
    this.banner = el('div', 'dvd-message');
    this.bannerText = el('p');
    this.bannerButton = el('button', 'dvd-big');
    this.banner.append(this.bannerText, this.bannerButton);
    this.note = el('div', 'dvd-note');
    this.note.hidden = true;
    this.alt = el('audio'); // plays audio tracks the mp4 doesn't have
    this.alt.preload = 'auto';
    this.stage.append(this.canvas, this.note, this.banner, this.alt);

    const button = (label, title, onClick) => {
      const b = el('button', null, label);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', onClick);
      return b;
    };
    const ui = (this.ui = {});
    ui.prev = button('⏮︎', 'Previous chapter', () => this.previous());
    ui.play = button('▶︎', 'Play', () => this.togglePause());
    ui.next = button('⏭︎', 'Next chapter', () => this.next());
    ui.seek = el('input', 'dvd-seek');
    ui.seek.type = 'range';
    ui.seek.min = 0;
    ui.seek.step = 'any';
    ui.seek.setAttribute('aria-label', 'Seek');
    ui.seek.addEventListener('input', () => {
      this.seeking = true;
    });
    ui.seek.addEventListener('change', () => {
      this.seeking = false;
      this.seek(Number(ui.seek.value));
    });
    ui.time = el('span', 'dvd-time');
    ui.where = el('span', 'dvd-where');
    ui.menu = button('Menu', 'Disc menu', () => this.menu());
    ui.resume = button('Resume', 'Back to the title', () => this.resume());
    const picker = (label, onChange) => {
      const select = el('select');
      select.title = label;
      select.setAttribute('aria-label', label);
      select.hidden = true;
      select.addEventListener('change', () => onChange(select.value));
      return select;
    };
    ui.audio = picker('Audio track', (value) => this.setAudioTrack(Number(value)));
    ui.subs = picker('Subtitles', (value) => this.setSubtitleTrack(value === 'off' ? null : Number(value)));
    ui.mute = button('🔊︎', 'Mute', () => this.setVolume(this.volume, !this.muted));
    ui.volume = el('input', 'dvd-volume');
    ui.volume.type = 'range';
    ui.volume.min = 0;
    ui.volume.max = 1;
    ui.volume.step = 0.05;
    ui.volume.value = 1;
    ui.volume.setAttribute('aria-label', 'Volume');
    ui.volume.addEventListener('input', () => this.setVolume(Number(ui.volume.value), false));
    ui.full = button('⛶', 'Full screen', () => this.toggleFullscreen());
    this.controls = el('div', 'dvd-controls');
    this.controls.append(ui.prev, ui.play, ui.next, ui.seek, ui.time, ui.where, ui.menu, ui.resume, ui.audio, ui.subs, ui.mute, ui.volume, ui.full);

    this.root.append(this.stage, this.controls);
    container.append(this.root);

    this.canvas.addEventListener('mousemove', (e) => this.pointer(e, false));
    this.canvas.addEventListener('click', (e) => this.pointer(e, true));
    this.root.addEventListener('keydown', (e) => this.key(e));
  }

  message(text, action = null, onAction = null) {
    this.banner.hidden = !text;
    this.bannerText.textContent = text || '';
    this.bannerButton.hidden = !action;
    this.bannerButton.textContent = action || '';
    this.bannerButton.onclick = onAction;
  }

  notice(text) {
    this.note.textContent = text;
    this.note.hidden = false;
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.note.hidden = true;
    }, 8000);
  }

  fail(err) {
    console.error(err);
    this.halt();
    this.message(err.message || String(err));
  }

  log(...args) {
    if (this.debug) console.log('[dvd.js]', ...args);
  }

  // ---- starting and stopping -------------------------------------------------

  load(disc) {
    this.disc = disc;
    this.vm = new DvdVM(disc, { log: (line) => this.log(line) });
    this.message(disc.source.title, '▶︎ Play', () => this.start());
  }

  start() {
    this.message(null);
    this.paused = false;
    this.skippedMenus = false;
    this.root.focus();
    this.go(() => this.vm.start());
  }

  halt() {
    this.clearStill();
    this.step = null;
    this.segments = [];
    for (const video of this.videos.values()) video.pause();
    this.applyTracks();
  }

  // Run a VM entry point and play whatever it settles on. Returns false if the
  // VM had nowhere to go (a null step).
  go(navigate) {
    try {
      const step = navigate();
      if (!step) return false;
      this.play(step);
    } catch (err) {
      this.fail(err);
    }
    return true;
  }

  play(step) {
    this.clearStill();
    for (let empty = 0; step; empty++) {
      if (step.type === 'stop') {
        this.halt();
        this.message('The disc has stopped.', '▶︎ Play again', () => this.start());
        return;
      }
      const set = this.disc.setFor(step);
      const segments = set ? this.disc.segments(set, step.position) : [];
      if (segments.length) {
        this.playCell(step, set, segments);
        return;
      }
      // A cell with no mp4 behind it. Skip it; if the disc only loops through
      // such cells (a menu with no mp4), go straight to the first title.
      if (empty < MAX_EMPTY_CELLS) {
        step = this.vm.cellEnded();
      } else if (!this.skippedMenus) {
        this.skippedMenus = true;
        this.notice('No streaming video was found for this disc’s menus, so the first title is playing.');
        step = this.vm.jumpTitle(1);
        empty = 0;
      } else {
        throw new Error('This item has no streaming mp4s for the disc’s video (expected files like VTS_01_1.mp4).');
      }
    }
  }

  // ---- cells -----------------------------------------------------------------

  playCell(step, set, segments) {
    this.log(`cell ${step.domain} vts ${step.vtsN} pgc ${step.pgcN} cell ${step.cellN}`, segments);
    this.step = step;
    this.set = set;
    this.segments = segments;
    this.flash = null;
    this.canvas.height = set.video.format === 'PAL' ? 576 : 480;
    this.stage.style.setProperty('--dvd-aspect', set.video.aspect === '16:9' ? '16 / 9' : '4 / 3');
    this.drawn = '';
    let offset = step.resumeTime || 0;
    let index = 0;
    while (index + 1 < segments.length && offset >= segments[index].to - segments[index].from) {
      offset -= segments[index].to - segments[index].from;
      index++;
    }
    this.playSegment(index, offset);
  }

  playSegment(index, offset = 0) {
    this.segment = index;
    const seg = this.segments[index];
    const video = this.videoFor(seg.file);
    const target = seg.from + offset;
    const carryOn = video === this.video && !video.paused && !video.seeking && Math.abs(video.currentTime - target) < SEAMLESS;
    if (!carryOn) video.currentTime = target;
    this.show(video);
    this.applyTracks();
    if (!this.paused) this.resumeVideo(video);
  }

  resumeVideo(video) {
    video.play().catch((err) => {
      if (err.name === 'NotAllowedError') {
        this.paused = true;
        this.message('', '▶︎ Play', () => {
          this.message(null);
          this.togglePause();
        });
      }
    });
  }

  videoFor(file) {
    let video = this.videos.get(file.url);
    if (video) {
      this.videos.delete(file.url); // re-insert: the map is kept in LRU order
    } else {
      video = el('video');
      video.playsInline = true;
      video.preload = 'auto';
      video.volume = this.volume;
      video.muted = this.muted;
      video.src = file.url;
      video.addEventListener('timeupdate', () => this.tick());
      video.addEventListener('ended', () => this.tick());
      const ready = () => this.arrived(video);
      video.addEventListener('seeked', ready);
      video.addEventListener('canplay', ready);
      video.addEventListener('error', () => {
        if (video.getAttribute('src')) this.fail(new Error(`Could not play ${file.url}`));
      });
      this.stage.insertBefore(video, this.canvas);
    }
    this.videos.set(file.url, video);
    for (const [url, old] of this.videos) {
      if (this.videos.size <= MAX_VIDEOS) break;
      if (old === this.video || old === video) continue;
      this.videos.delete(url);
      old.removeAttribute('src');
      old.load();
      old.remove();
    }
    return video;
  }

  // Switch the picture to `video`. When it is a different element the old
  // picture stays up until the new one has a frame to show.
  show(video) {
    if (video === this.video) {
      this.incoming = null;
      return;
    }
    if (this.video) this.video.pause();
    this.incoming = video;
    if (!this.video || (video.readyState >= 2 && !video.seeking)) this.arrived(video);
  }

  arrived(video) {
    if (this.incoming !== video) return;
    this.incoming = null;
    if (this.video) this.video.classList.remove('dvd-active');
    this.video = video;
    video.classList.add('dvd-active');
    this.drawn = '';
  }

  get current() {
    return this.incoming || this.video;
  }

  // Seconds into the current cell.
  cellTime() {
    const seg = this.segments[this.segment];
    if (!seg || !this.current) return 0;
    let time = Math.max(0, Math.min(this.current.currentTime, seg.to) - seg.from);
    for (let i = 0; i < this.segment; i++) time += this.segments[i].to - this.segments[i].from;
    return time;
  }

  // Watch for the end of the current piece of video.
  tick() {
    const seg = this.segments[this.segment];
    const video = this.current;
    if (!seg || !video || this.still || video.seeking) return;
    const last = this.segment + 1 === this.segments.length;
    const stillTime = last ? this.stillTime() : 0;
    if (!video.ended && video.currentTime < seg.to - (stillTime ? STILL_EPSILON : END_EPSILON)) return;
    if (!last) {
      this.playSegment(this.segment + 1);
    } else if (stillTime) {
      this.hold(stillTime);
    } else {
      this.go(() => this.vm.cellEnded());
    }
  }

  stillTime() {
    const { cell, pgc, cellN } = this.step;
    return cell.stillTime || (cellN === pgc.nrCells ? pgc.stillTime : 0);
  }

  // Hold the last frame of the cell: for `seconds`, or until a button is
  // pressed when seconds is 255.
  hold(seconds) {
    const video = this.current;
    video.pause();
    this.still = { timer: null };
    if (seconds < 255) {
      this.still.timer = setTimeout(() => {
        this.still = null;
        this.go(() => this.vm.cellEnded());
      }, seconds * 1000);
    }
  }

  clearStill() {
    if (this.still) clearTimeout(this.still.timer);
    this.still = null;
  }

  // ---- transport -------------------------------------------------------------

  get inTitle() {
    return !!this.step && this.step.domain === Domain.VTS;
  }

  togglePause() {
    if (!this.step || this.still) return;
    this.paused = !this.paused;
    if (this.paused) this.current.pause();
    else this.resumeVideo(this.current);
  }

  // Length of the current PGC and where each of its cells starts.
  timeline() {
    const starts = [];
    let total = 0;
    for (const cell of this.step.pgc.cells) {
      starts.push(total);
      total += cell.playbackTime;
    }
    return { starts, total };
  }

  position() {
    if (!this.step) return 0;
    return this.timeline().starts[this.step.cellN - 1] + this.cellTime();
  }

  seek(time) {
    if (!this.inTitle) return;
    const { starts, total } = this.timeline();
    const target = Math.max(0, Math.min(time, total - 0.5));
    let cellN = starts.length;
    while (cellN > 1 && starts[cellN - 1] > target) cellN--;
    this.go(() => this.vm.jumpCell(cellN, target - starts[cellN - 1]));
  }

  next() {
    if (!this.inTitle) return;
    this.go(() => this.vm.nextProgram()) || this.go(() => this.vm.jumpTitle(this.vm.title + 1));
  }

  previous() {
    if (!this.inTitle) return;
    this.go(() => this.vm.prevProgram());
  }

  menu() {
    if (!this.step) return;
    const time = this.cellTime();
    const found = this.go(() => this.vm.menuCall(3, time)) || this.go(() => this.vm.menuCall(2, time));
    if (!found) this.notice('This disc has no menu.');
  }

  resume() {
    if (this.vm && this.vm.inMenu) this.go(() => this.vm.resume());
  }

  setVolume(volume, muted) {
    this.volume = volume;
    this.muted = muted;
    for (const video of this.videos.values()) {
      video.volume = volume;
      video.muted = muted || !!this.altUrl; // another track is playing instead
    }
    this.alt.volume = volume;
    this.alt.muted = muted;
  }

  // ---- audio tracks and subtitles --------------------------------------------

  // Work out which audio and subtitles go with the piece of video now playing.
  applyTracks() {
    const seg = this.segments[this.segment];
    this.tracks = this.inTitle && seg ? this.disc.tracks(this.step, seg.file) : { audio: [], subs: [] };
    const { audio, subs } = this.tracks;
    // What the disc or the viewer chose, else the first one there is a file for.
    this.audioTrack = audio.find((t) => t.n === this.vm.audioTrack && t.available) || audio.find((t) => t.available) || null;
    const url = (this.audioTrack && this.audioTrack.url) || null;
    if (url !== this.altUrl) {
      this.altUrl = url;
      this.alt.pause();
      if (url) this.alt.src = url;
      else this.alt.removeAttribute('src');
      this.alt.load();
    }
    this.subTrack = subs.find((t) => t.n === this.vm.subtitleTrack && t.available) || null;
    this.subs = null;
    this.drawn = '';
    if (this.subTrack) {
      const { file } = seg;
      const { id } = this.subTrack;
      file.subs ??= fetch(file.extras.subsUrl)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`${res.status} for ${res.url}`))))
        .then((buf) => parseSubtitles(new Uint8Array(buf)))
        .catch((err) => {
          console.warn('dvd.js: could not load subtitles:', err);
          return new Map();
        });
      file.subs.then((streams) => {
        const now = this.segments[this.segment];
        if (now && now.file === file && this.subTrack && this.subTrack.id === id) this.subs = streams.get(id) || [];
      });
    }
    this.fillPickers();
    this.setVolume(this.volume, this.muted);
  }

  fillPickers() {
    const { audio, subs } = this.tracks;
    const key = JSON.stringify([audio.map((t) => [t.n, t.label, t.available]), subs.map((t) => [t.n, t.label, t.available])]);
    if (key !== this.menus) {
      this.menus = key;
      const fill = (select, options) => {
        select.replaceChildren(
          ...options.map(([value, label, available]) => {
            const option = el('option', null, label);
            option.value = String(value);
            option.disabled = !available;
            return option;
          })
        );
      };
      fill(this.ui.audio, audio.map((t) => [t.n, `Audio: ${t.label}${t.available ? '' : ' (not available)'}`, t.available]));
      fill(this.ui.subs, [['off', 'Subtitles: off', true], ...subs.map((t) => [t.n, `Subtitles: ${t.label}${t.available ? '' : ' (not available)'}`, t.available])]);
      this.ui.audio.hidden = audio.length < 2;
      this.ui.subs.hidden = !subs.length;
    }
    if (this.audioTrack) this.ui.audio.value = String(this.audioTrack.n);
    this.ui.subs.value = this.subTrack ? String(this.subTrack.n) : 'off';
  }

  setAudioTrack(n) {
    this.vm.audioTrack = n;
    this.applyTracks();
  }

  setSubtitleTrack(n) {
    this.vm.subtitleTrack = n;
    this.applyTracks();
  }

  // Step to the next audio track, or the next subtitle track (then off).
  cycle(kind) {
    const list = this.tracks[kind].filter((t) => t.available);
    if (kind === 'audio') {
      if (list.length < 2) return;
      this.setAudioTrack(list[(list.indexOf(this.audioTrack) + 1) % list.length].n);
    } else if (list.length) {
      const next = list[list.indexOf(this.subTrack) + 1];
      this.setSubtitleTrack(next ? next.n : null);
    }
  }

  // Keep the separate audio track in step with the video.
  syncAudio() {
    const video = this.current;
    const alt = this.alt;
    if (!this.altUrl || !video) return;
    const playing = !video.paused && !video.seeking && video.readyState >= 3;
    if (!alt.seeking && Math.abs(alt.currentTime - video.currentTime) > AUDIO_DRIFT) alt.currentTime = video.currentTime;
    if (playing && alt.paused) alt.play().catch(() => {});
    if (!playing && !alt.paused) alt.pause();
  }

  // The subtitle to show now, or null.
  subtitleAt() {
    if (!this.subs || !this.video || this.incoming) return null;
    const time = this.video.currentTime;
    let found = -1;
    for (let lo = 0, hi = this.subs.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1;
      if (this.subs[mid].time <= time) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return null;
    const unit = this.subs[found];
    unit.spu ??= decodeSpu(unit.data);
    const { spu } = unit;
    if (!spu.pixels) return null;
    const start = unit.time + spu.startDelay / 90000;
    const stop = unit.time + (spu.stopDelay === null ? SUBTITLE_MAX : spu.stopDelay / 90000);
    return time >= start && time < stop ? unit : null;
  }

  drawSubtitle({ spu }) {
    const palette = this.step.pgc.palette;
    const rgba = [0, 1, 2, 3].map((v) => [...paletteToRgb(palette[spu.palette[v]]), Math.round((spu.alpha[v] * 255) / 15)]);
    const image = this.ctx.createImageData(spu.width, spu.height);
    for (let i = 0; i < spu.pixels.length; i++) {
      const colour = rgba[spu.pixels[i]];
      if (colour[3]) image.data.set(colour, i * 4);
    }
    this.ctx.putImageData(image, spu.x1, spu.y1);
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.root.requestFullscreen?.();
  }

  // Keep the control bar in step with the player.
  refresh() {
    const ui = this.ui;
    const set = (node, prop, value) => {
      if (node[prop] !== value) node[prop] = value;
    };
    const playing = !!this.step && !this.paused && !this.still;
    set(ui.play, 'textContent', playing ? '⏸︎' : '▶︎');
    set(ui.play, 'title', playing ? 'Pause' : 'Play');
    set(ui.play, 'disabled', !this.step || !!this.still);
    set(ui.prev, 'disabled', !this.inTitle);
    set(ui.next, 'disabled', !this.inTitle);
    set(ui.seek, 'disabled', !this.inTitle);
    set(ui.menu, 'disabled', !this.step);
    set(ui.resume, 'hidden', !(this.step && this.vm.inMenu && this.vm.rsm));
    set(ui.mute, 'textContent', this.muted || !this.volume ? '🔇︎' : '🔊︎');
    set(ui.volume, 'value', String(this.muted ? 0 : this.volume));
    if (!this.inTitle) {
      set(ui.time, 'textContent', '');
      set(ui.where, 'textContent', '');
      if (!this.seeking) set(ui.seek, 'value', '0');
      return;
    }
    const { total } = this.timeline();
    const position = this.position();
    set(ui.seek, 'max', String(total));
    if (!this.seeking) set(ui.seek, 'value', String(position));
    set(ui.time, 'textContent', `${clock(this.seeking ? Number(ui.seek.value) : position)} / ${clock(total)}`);
    set(ui.where, 'textContent', `Title ${this.vm.title} · Chapter ${this.step.pgN}`);
  }

  // ---- buttons ---------------------------------------------------------------

  // Highlight information for what is on screen now, or null.
  buttons() {
    const seg = this.segments[this.segment];
    if (!this.step || !seg || this.incoming || !this.video) return null;
    const state = this.disc.menuState(this.set, this.step.position, seg.file.start + this.video.currentTime);
    if (!state) return null;
    const { hli } = state;
    if (hli !== this.lastHli) {
      this.lastHli = hli;
      if (hli.forcedSelect) this.vm.highlightedButton = hli.forcedSelect;
    }
    const n = this.vm.highlightedButton;
    if (n < 1 || n > hli.buttons.length) this.vm.highlightedButton = 1;
    return state;
  }

  draw() {
    const state = this.buttons();
    const subtitle = state ? null : this.subtitleAt();
    const n = state ? this.vm.highlightedButton : 0;
    const mode = this.flash === n ? 'action' : 'select';
    let key = subtitle ? `subtitle/${this.subTrack.id}/${subtitle.time}` : '';
    if (state) key = `${this.step.pgcN}/${this.step.cellN}/${state.hli.startPtm}/${n}/${mode}/${state.spu ? state.spu.pixels.length : 0}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.canvas.style.cursor = '';
    if (subtitle) this.drawSubtitle(subtitle);
    if (!state) return;
    const button = state.hli.buttons[n - 1];
    const coli = state.hli.colors[button.colorN - 1]?.[mode] ?? 0;
    if (!this.drawHighlight(button, coli, state.spu)) {
      // Nothing visible to highlight with: outline the button instead.
      ctx.lineWidth = 3;
      ctx.strokeStyle = mode === 'action' ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 221, 0, 0.9)';
      ctx.strokeRect(button.x1 + 1.5, button.y1 + 1.5, button.x2 - button.x1 - 3, button.y2 - button.y1 - 3);
    }
  }

  // Recolour the part of the subpicture inside the button with the button's
  // colours. Returns false if that leaves nothing visible.
  drawHighlight(button, coli, spu) {
    if (!spu) return false;
    const x1 = Math.max(button.x1, spu.x1);
    const y1 = Math.max(button.y1, spu.y1);
    const x2 = Math.min(button.x2, spu.x2);
    const y2 = Math.min(button.y2, spu.y2);
    if (x2 < x1 || y2 < y1) return false;
    const palette = this.step.pgc.palette;
    const rgba = [0, 1, 2, 3].map((v) => {
      const alpha = (coli >> (4 * v)) & 0xf;
      return [...paletteToRgb(palette[(coli >> (16 + 4 * v)) & 0xf]), Math.round((alpha * 255) / 15)];
    });
    const image = this.ctx.createImageData(x2 - x1 + 1, y2 - y1 + 1);
    let visible = false;
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        const colour = rgba[spu.pixels[(y - spu.y1) * spu.width + (x - spu.x1)]];
        if (!colour[3]) continue;
        image.data.set(colour, ((y - y1) * image.width + (x - x1)) * 4);
        visible = true;
      }
    }
    if (visible) this.ctx.putImageData(image, x1, y1);
    return visible;
  }

  select(n) {
    const state = this.buttons();
    if (!state || n < 1 || n > state.hli.buttons.length) return;
    this.vm.highlightedButton = n;
    if (state.hli.buttons[n - 1].autoAction) this.activate();
  }

  activate() {
    const state = this.buttons();
    if (!state) return;
    const n = this.vm.highlightedButton;
    const button = state.hli.buttons[n - 1];
    this.flash = n;
    this.paused = false;
    setTimeout(() => {
      this.flash = null;
    }, ACTION_FLASH);
    this.go(() => this.vm.activateButton(button.cmd));
  }

  pointer(event, click) {
    const state = this.buttons();
    const box = this.canvas.getBoundingClientRect();
    const x = ((event.clientX - box.left) * this.canvas.width) / box.width;
    const y = ((event.clientY - box.top) * this.canvas.height) / box.height;
    const hit = state ? state.hli.buttons.findIndex((b) => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) + 1 : 0;
    this.canvas.style.cursor = hit ? 'pointer' : '';
    if (hit) {
      if (hit !== this.vm.highlightedButton) this.vm.highlightedButton = hit;
      if (click) this.activate();
    } else if (click && this.inTitle) {
      this.togglePause();
    }
  }

  key(event) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) return;
    const state = this.buttons();
    const arrow = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[event.key];
    if (arrow && state) {
      this.select(state.hli.buttons[this.vm.highlightedButton - 1][arrow]);
    } else if (event.key === 'Enter' && state) {
      this.activate();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (this.inTitle) this.seek(this.position() + (event.key === 'ArrowLeft' ? -SKIP : SKIP));
    } else if (event.key === ' ') {
      this.togglePause();
    } else if (event.key === 'm') {
      this.menu();
    } else if (event.key === 'a') {
      this.cycle('audio');
    } else if (event.key === 's') {
      this.cycle('subs');
    } else if (event.key === 'f') {
      this.toggleFullscreen();
    } else {
      return;
    }
    event.preventDefault();
  }
}
