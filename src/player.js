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
const AUDIO_WAIT = 3; // let the video catch up when the audio is ahead by less than this
const AUDIO_LEAD_MAX = 2; // most a seek of the audio track aims ahead of the video
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
    this.failedAudio = new Set(); // urls of audio tracks that wouldn't play
    this.altLead = 0; // how long the last seek of the audio track took, in seconds
    this.altSeekAt = 0;
    this.subTrack = null; // the subtitle track the viewer switched on
    this.subStream = null; // { id, forcedOnly } of the subtitles being drawn
    this.subs = null; // its subpicture units, once loaded
    this.buttonStream = null; // id of the subpicture stream a title's buttons are lit on
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
    this.alt.addEventListener('error', () => this.audioFailed());
    this.alt.addEventListener('seeked', () => {
      if (this.altSeekAt) this.altLead = Math.min(AUDIO_LEAD_MAX, (performance.now() - this.altSeekAt) / 1000);
      this.altSeekAt = 0;
    });
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
    // A button that opens a list of choices above the control bar.
    const menuButton = (label, title) => {
      const menu = { wrap: el('div', 'dvd-menu'), list: el('div', 'dvd-popup') };
      menu.button = button(label, title, () => this.togglePopup(menu));
      menu.button.setAttribute('aria-haspopup', 'menu');
      menu.button.setAttribute('aria-expanded', 'false');
      menu.list.setAttribute('role', 'menu');
      menu.list.setAttribute('aria-label', title);
      menu.list.hidden = true;
      menu.wrap.hidden = true;
      menu.wrap.append(menu.button, menu.list);
      return menu;
    };
    ui.audio = menuButton('Audio', 'Audio track');
    ui.subs = menuButton('Subtitles', 'Subtitles');
    ui.angle = menuButton('Angle', 'Camera angle');
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
    this.controls.append(ui.prev, ui.play, ui.next, ui.seek, ui.time, ui.where, ui.menu, ui.resume, ui.audio.wrap, ui.subs.wrap, ui.angle.wrap, ui.mute, ui.volume, ui.full);

    this.root.append(this.stage, this.controls);
    container.append(this.root);

    this.canvas.addEventListener('mousemove', (e) => this.pointer(e, false));
    this.canvas.addEventListener('click', (e) => this.pointer(e, true));
    this.root.addEventListener('keydown', (e) => this.key(e));
    document.addEventListener('click', (e) => {
      if (!(e.target instanceof Element && e.target.closest('.dvd-menu'))) this.closePopups();
    });
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
      if (set) this.disc.scanTitle(set);
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
    this.drawn = null;
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
    this.drawn = null;
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
  // Where each cell of the title starts. The angles of a multi-angle block
  // are the same stretch of the title, so only the one being shown counts.
  timeline() {
    const starts = [];
    let total = 0;
    this.step.pgc.cells.forEach((cell, i) => {
      const block = this.vm.angleCells(i + 1);
      const shown = !block || block[Math.min(this.vm.angle, block.length) - 1] === i + 1;
      starts.push(block ? starts[block[0] - 1] ?? total : total);
      if (shown) total += cell.playbackTime;
    });
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
    // From inside a menu, a root menu that goes nowhere means "stay here",
    // not "try the title menu".
    let stay = false;
    try {
      stay = this.vm.inMenu && !!this.vm.findMenu(Domain.VTSM, 3);
    } catch {
      // no title set to have a root menu
    }
    const found = this.go(() => this.vm.menuCall(3, time)) || (!stay && this.go(() => this.vm.menuCall(2, time)));
    if (!found && !this.vm.inMenu) this.notice('This disc has no menu.');
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
    for (const track of audio) {
      if (track.url && this.failedAudio.has(track.url)) track.available = false;
    }
    // What the disc or the viewer chose, else the first one there is a file for.
    this.audioTrack = audio.find((t) => t.n === this.vm.audioTrack && t.available) || audio.find((t) => t.available) || null;
    const url = (this.audioTrack && this.audioTrack.url) || null;
    if (url !== this.altUrl) {
      this.altUrl = url;
      this.altSeekAt = 0;
      this.alt.pause();
      if (url) this.alt.src = url;
      else this.alt.removeAttribute('src');
      this.alt.load();
    }
    this.subTrack = subs.find((t) => t.n === this.vm.subtitleTrack && t.available) || null;
    // With subtitles off a player still shows the subtitles a disc forces on
    // (signs, foreign dialogue), from the stream that would otherwise be shown.
    const fallback = subs.find((t) => t.n === this.vm.subtitleStream && t.available) || subs.find((t) => t.available);
    const shown = this.subTrack || fallback;
    this.subStream = shown ? { id: shown.id, forcedOnly: !this.subTrack } : null;
    // Buttons over a title are highlighted on the subpicture stream the disc
    // has selected, whether or not there is a subtitle file for it.
    const selected = subs.find((t) => t.n === this.vm.subtitleStream) || subs[0];
    this.buttonStream = this.inTitle ? (selected ? selected.id : -1) : null;
    this.subs = null;
    this.drawn = null;
    if (this.subStream) {
      const { file } = seg;
      const stream = this.subStream;
      file.subs ??= fetch(file.extras.subsUrl)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`${res.status} for ${res.url}`))))
        .then((buf) => parseSubtitles(new Uint8Array(buf)))
        .catch((err) => {
          console.warn('dvd.js: could not load subtitles:', err);
          return new Map();
        });
      file.subs.then((streams) => {
        const now = this.segments[this.segment];
        if (now && now.file === file && this.subStream === stream) this.subs = streams.get(stream.id) || [];
      });
    }
    this.fillPickers();
    this.setVolume(this.volume, this.muted);
  }

  // Fill the Audio and Subtitles buttons' lists with the title's tracks.
  fillPickers() {
    const { audio, subs } = this.tracks;
    const angles = (this.inTitle && this.vm.angleCells()) || [];
    const angle = Math.min(this.vm.angle, angles.length);
    const state = [audio.map((t) => [t.n, t.label, t.available]), subs.map((t) => [t.n, t.label, t.available]), this.audioTrack && this.audioTrack.n, this.subTrack && this.subTrack.n, angles.length, angle];
    const key = JSON.stringify(state);
    if (key === this.menus) return;
    this.menus = key;
    this.closePopups();
    const fill = (menu, options, onPick) => {
      menu.list.replaceChildren(
        ...options.map(([value, label, available, chosen]) => {
          const item = el('button', null, available ? label : `${label} (not available)`);
          item.type = 'button';
          item.setAttribute('role', 'menuitemradio');
          item.setAttribute('aria-checked', String(!!chosen));
          item.disabled = !available;
          item.addEventListener('click', () => {
            onPick(value);
            this.closePopups();
            menu.button.focus();
          });
          return item;
        })
      );
    };
    fill(this.ui.audio, audio.map((t) => [t.n, t.label, t.available, t === this.audioTrack]), (n) => this.setAudioTrack(n));
    fill(this.ui.subs, [[null, 'Off', true, !this.subTrack], ...subs.map((t) => [t.n, t.label, t.available, t === this.subTrack])], (n) => this.setSubtitleTrack(n));
    fill(this.ui.angle, angles.map((_, i) => [i + 1, `Angle ${i + 1}`, true, i + 1 === angle]), (n) => this.setAngle(n));
    this.ui.angle.wrap.hidden = angles.length < 2;
    this.ui.angle.button.textContent = `Angle: ${angle}/${angles.length}`;
    this.ui.audio.wrap.hidden = audio.length < 2;
    this.ui.subs.wrap.hidden = !subs.length;
    this.ui.audio.button.textContent = `Audio: ${this.audioTrack ? this.audioTrack.short : '–'}`;
    this.ui.subs.button.textContent = `Subtitles: ${this.subTrack ? this.subTrack.label : 'Off'}`;
  }

  togglePopup(menu) {
    const open = menu.list.hidden;
    this.closePopups();
    if (!open) return;
    menu.list.hidden = false;
    menu.button.setAttribute('aria-expanded', 'true');
    const item = menu.list.querySelector('[aria-checked="true"]:not(:disabled)') || menu.list.querySelector('button:not(:disabled)');
    if (item) item.focus();
  }

  closePopups() {
    for (const menu of [this.ui.audio, this.ui.subs, this.ui.angle]) {
      menu.list.hidden = true;
      menu.button.setAttribute('aria-expanded', 'false');
    }
  }

  // Arrow keys and Escape inside an open list.
  popupKey(event, list) {
    const items = [...list.querySelectorAll('button:not(:disabled)')];
    const at = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
      if (next) next.focus();
    } else if (event.key === 'Escape') {
      const menu = [this.ui.audio, this.ui.subs, this.ui.angle].find((m) => m.list === list);
      this.closePopups();
      menu.button.focus();
    } else {
      return;
    }
    event.preventDefault();
  }

  setAudioTrack(n) {
    this.vm.audioTrack = n;
    this.applyTracks();
  }

  setSubtitleTrack(n) {
    this.vm.subtitleTrack = n;
    this.applyTracks();
  }

  // Show the same moment of a multi-angle scene from another camera.
  setAngle(n) {
    const block = this.inTitle && this.vm.angleCells();
    if (!block || n < 1 || n > block.length) return;
    const time = this.cellTime();
    this.vm.angle = n;
    this.go(() => this.vm.jumpCell(this.vm.cellN, time));
  }

  // Step to the next audio track, the next subtitle track (then off), or
  // the next camera angle.
  cycle(kind) {
    if (kind === 'angle') {
      const block = this.inTitle && this.vm.angleCells();
      if (block && block.length > 1) this.setAngle((Math.min(this.vm.angle, block.length) % block.length) + 1);
      return;
    }
    const list = this.tracks[kind].filter((t) => t.available);
    if (kind === 'audio') {
      if (list.length < 2) return;
      this.setAudioTrack(list[(list.indexOf(this.audioTrack) + 1) % list.length].n);
    } else if (list.length) {
      const next = list[list.indexOf(this.subTrack) + 1];
      this.setSubtitleTrack(next ? next.n : null);
    }
  }

  // The separate audio track can't be played: go back to a track that can,
  // and say so, rather than play the title in silence.
  audioFailed() {
    const url = this.altUrl;
    if (!url || this.failedAudio.has(url)) return;
    this.failedAudio.add(url);
    const name = this.audioTrack ? this.audioTrack.label : 'That audio track';
    this.applyTracks();
    this.notice(`${name} could not be played${this.audioTrack ? `, so this is ${this.audioTrack.label}` : ''}.`);
  }

  // Keep the separate audio track in step with the video.
  syncAudio() {
    const video = this.current;
    const alt = this.alt;
    if (!this.altUrl || !video) return;
    const playing = !video.paused && !video.seeking && video.readyState >= 3;
    const ahead = alt.currentTime - video.currentTime;
    // A little ahead: wait for the video instead of seeking again.
    const waiting = playing && !alt.seeking && ahead > AUDIO_DRIFT && ahead < AUDIO_WAIT;
    if (!alt.seeking && !waiting && Math.abs(ahead) > AUDIO_DRIFT) {
      // Aim ahead by as long as the last seek took, so that it lands in step.
      this.altSeekAt = performance.now();
      alt.currentTime = video.currentTime + (playing ? this.altLead : 0);
    }
    if (playing && !waiting && alt.paused) {
      alt.play().catch((err) => {
        if (err.name !== 'AbortError') this.audioFailed();
      });
    }
    if ((!playing || waiting) && !alt.paused) alt.pause();
  }

  // The subtitle to show now, or null.
  subtitleAt() {
    if (!this.subs || !this.subStream || !this.video || this.incoming) return null;
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
    if (!spu.pixels || (this.subStream.forcedOnly && !spu.forced)) return null;
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
    const state = this.disc.menuState(this.set, this.step.position, seg.file.start + this.video.currentTime, this.inTitle ? this.buttonStream : null);
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
    // A title can have buttons over the video and subtitles at once.
    const subtitle = state && !this.inTitle ? null : this.subtitleAt();
    const n = state ? this.vm.highlightedButton : 0;
    const mode = this.flash === n ? 'action' : 'select';
    let key = subtitle ? `subtitle/${this.subStream.id}/${subtitle.time}` : '';
    if (state) key += `/${this.step.pgcN}/${this.step.cellN}/${state.hli.startPtm}/${n}/${mode}/${state.spu ? state.spu.pixels.length : 0}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.canvas.style.cursor = '';
    if (subtitle) this.drawSubtitle(subtitle);
    if (!state) return;
    const button = state.hli.buttons[n - 1];
    const coli = state.hli.colors[button.colorN - 1]?.[mode] ?? 0;
    if (!this.drawHighlight(button, coli, state.spu) && !this.inTitle) {
      // Nothing visible to highlight with: outline the button instead. (Not
      // over a title, where a button may be meant to stay unseen.)
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
    if (visible) this.paint(image, x1, y1);
    return visible;
  }

  // Draw `image` over what is on the canvas. (putImageData would replace it,
  // transparent pixels included.)
  paint(image, x, y) {
    const scratch = (this.scratch ??= document.createElement('canvas'));
    scratch.width = image.width;
    scratch.height = image.height;
    scratch.getContext('2d').putImageData(image, 0, 0);
    this.ctx.drawImage(scratch, x, y);
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
    const time = this.inTitle ? this.cellTime() : null;
    this.go(() => this.vm.activateButton(button.cmd, time));
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
    const list = event.target instanceof Element && event.target.closest('.dvd-popup');
    if (list) {
      this.popupKey(event, list);
      return;
    }
    if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) return;
    const state = this.buttons();
    const arrow = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[event.key];
    const target = arrow && state ? state.hli.buttons[this.vm.highlightedButton - 1][arrow] : 0;
    // Over a title, an arrow that has no other button to go to keeps its
    // usual job (seeking), so a lone or hidden button doesn't take the keys.
    if (target && !(this.inTitle && target === this.vm.highlightedButton)) {
      this.select(target);
    } else if (arrow && state && !this.inTitle) {
      // a menu button with nowhere to go in that direction
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
    } else if (event.key === 'c') {
      this.cycle('angle');
    } else if (event.key === 'f') {
      this.toggleFullscreen();
    } else {
      return;
    }
    event.preventDefault();
  }
}
