// The DVD virtual machine: registers, the navigation command interpreter and
// the PGC/program/cell state machine. Modelled on the behaviour of libdvdnav's
// vm, written from the DVD-Video command set description.
//
// The VM never touches video. Every entry point returns a "step":
//   { type: 'cell', ... }  play this cell, then call cellEnded()
//   { type: 'stop' }       the disc asked the player to stop

export const Domain = { FP: 'FP', VMGM: 'VMGM', VTSM: 'VTSM', VTS: 'VTS' };

// SPRM indices
const ASTN = 1;
const SPSTN = 2;
const AGLN = 3;
const TTN = 4;
const VTS_TTN = 5;
const TT_PGCN = 6;
const PTTN = 7;
const HL_BTNN = 8;

const MAX_COMMANDS = 100000;

function bitReader(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  // bits are numbered 63 (msb) .. 0; read `count` bits starting at `start`
  return (start, count) => Number((v >> BigInt(start - count + 1)) & ((1n << BigInt(count)) - 1n));
}

function compare(op, a, b) {
  switch (op) {
    case 1: return (a & b) !== 0;
    case 2: return a === b;
    case 3: return a !== b;
    case 4: return a >= b;
    case 5: return a > b;
    case 6: return a <= b;
    case 7: return a < b;
    default: return false;
  }
}

const LINK_SUBINS = [
  'LinkNoLink', 'LinkTopC', 'LinkNextC', 'LinkPrevC', null, 'LinkTopPG', 'LinkNextPG', 'LinkPrevPG',
  null, 'LinkTopPGC', 'LinkNextPGC', 'LinkPrevPGC', 'LinkGoUpPGC', 'LinkTailPGC', null, null, 'LinkRSM',
];

export class DvdVM {
  // disc: { vmg, vts: { [n]: parsed VTS ifo } }
  constructor(disc, { menuLang = 'en', log = null } = {}) {
    this.disc = disc;
    this.menuLang = menuLang;
    this.log = log || (() => {});
    this.reset();
  }

  reset() {
    this.gprm = new Uint16Array(16);
    this.sprm = new Uint16Array(24);
    const lang = (this.menuLang.charCodeAt(0) << 8) | this.menuLang.charCodeAt(1);
    this.sprm[0] = lang;
    this.sprm[ASTN] = 15;
    this.sprm[SPSTN] = 62;
    this.sprm[AGLN] = 1;
    this.sprm[TTN] = 1;
    this.sprm[VTS_TTN] = 1;
    this.sprm[PTTN] = 1;
    this.sprm[HL_BTNN] = 1 << 10;
    this.sprm[12] = 0x5553; // parental country "US"
    this.sprm[13] = 15; // parental level: none
    this.sprm[14] = 0x0100; // 4:3 player
    this.sprm[16] = lang;
    this.sprm[18] = lang;
    this.sprm[20] = 1; // region
    this.domain = Domain.FP;
    this.vtsN = 1;
    this.pgc = null;
    this.pgcN = 0;
    this.pgN = 1;
    this.cellN = 0;
    this.rsm = null;
    this.stopped = false;
  }

  get vts() {
    const vts = this.disc.vts[this.vtsN];
    if (!vts) throw new Error(`Title set ${this.vtsN} is not loaded`);
    return vts;
  }

  get highlightedButton() {
    return this.sprm[HL_BTNN] >> 10;
  }

  set highlightedButton(n) {
    this.sprm[HL_BTNN] = n << 10;
  }

  get title() {
    return this.sprm[TTN];
  }

  // The audio track (0-7) the disc or the viewer chose; 15 means no choice.
  get audioTrack() {
    return this.sprm[ASTN];
  }

  set audioTrack(n) {
    this.sprm[ASTN] = n;
  }

  // The subtitle track (0-31) being shown, or null when subtitles are off.
  get subtitleTrack() {
    return this.sprm[SPSTN] & 0x40 ? this.sprm[SPSTN] & 0x3f : null;
  }

  // The subtitle stream number the disc last set, displayed or not; 62 and
  // 63 mean none.
  get subtitleStream() {
    return this.sprm[SPSTN] & 0x3f;
  }

  set subtitleTrack(n) {
    this.sprm[SPSTN] = n === null ? this.sprm[SPSTN] & 0x3f : 0x40 | n;
  }

  get inMenu() {
    return this.domain === Domain.VMGM || this.domain === Domain.VTSM;
  }

  // ---- public entry points -------------------------------------------------

  start() {
    this.reset();
    return this.run(this.setFirstPlay() ? this.playPGC() : this.linkTo('JumpTT', 1));
  }

  // Called by the player when the current cell (and its still time) is over.
  cellEnded() {
    return this.run(this.playCellPost());
  }

  // Run a button command. Returns a step if the command jumped somewhere,
  // otherwise null (the menu keeps playing).
  activateButton(cmd) {
    const link = this.evalCommands([cmd]);
    if (!link) return null;
    const step = this.run(link);
    return step.type === 'none' ? null : step;
  }

  // Remote-control "menu" keys. menuId: 2 title, 3 root, 4 subpicture,
  // 5 audio, 6 angle, 7 chapter. Returns null if the disc has no such menu.
  // `time` is how far into the current cell the title is, for resume().
  menuCall(menuId, time = null) {
    const fromTitle = this.domain === Domain.VTS;
    const domain = menuId === 2 ? Domain.VMGM : Domain.VTSM;
    if (!this.findMenu(domain, menuId)) return null;
    if (fromTitle) {
      this.saveResume(this.cellN);
      this.rsm.time = time;
    }
    this.domain = domain;
    this.setMenu(menuId);
    return this.run(this.playPGC());
  }

  jumpTitle(title) {
    if (title < 1 || title > this.disc.vmg.titles.length) return null;
    return this.run(this.linkTo('JumpTT', title));
  }

  nextProgram() {
    if (!this.pgc || this.pgN >= this.pgc.nrPrograms) return null;
    return this.run(this.linkTo('LinkNextPG'));
  }

  prevProgram() {
    if (!this.pgc || this.pgN <= 1) return this.pgc ? this.run(this.linkTo('LinkTopPG')) : null;
    return this.run(this.linkTo('LinkPrevPG'));
  }

  // Leave a menu and go back to where the title was interrupted.
  resume() {
    if (!this.rsm) return null;
    return this.run(this.linkTo('LinkRSM'));
  }

  // Seek support: play cell `cellN` of the current PGC from `time` seconds in.
  jumpCell(cellN, time = 0) {
    if (!this.pgc || cellN < 1 || cellN > this.pgc.nrCells) return null;
    this.cellN = cellN;
    return this.run(this.playCell(time));
  }

  // ---- state helpers -------------------------------------------------------

  linkTo(command, data1 = 0, data2 = 0, data3 = 0) {
    return { command, data1, data2, data3 };
  }

  pgcit() {
    if (this.domain === Domain.VTS) return this.vts.pgcit;
    const units = this.domain === Domain.VTSM ? this.vts.menuUnits : this.disc.vmg.menuUnits;
    if (!units.length) return [];
    return (units.find((lu) => lu.lang === this.menuLang) || units[0]).pgcit;
  }

  findMenu(domain, menuId) {
    const saved = this.domain;
    this.domain = domain;
    let pgcit;
    try {
      pgcit = this.pgcit();
    } finally {
      this.domain = saved;
    }
    const i = pgcit.findIndex((srp) => srp.entryId === (0x80 | menuId));
    return i < 0 ? 0 : i + 1;
  }

  setFirstPlay() {
    this.domain = Domain.FP;
    this.pgc = this.disc.vmg.firstPlayPgc;
    this.pgcN = 0;
    this.pgN = 1;
    return !!this.pgc;
  }

  setPGCN(pgcN) {
    const srp = this.pgcit()[pgcN - 1];
    if (!srp) throw new Error(`No PGC ${pgcN} in ${this.domain} domain`);
    this.pgc = srp.pgc;
    this.pgcN = pgcN;
    this.pgN = 1;
    if (this.domain === Domain.VTS) this.sprm[TT_PGCN] = pgcN;
  }

  setMenu(menuId) {
    const pgcN = this.findMenu(this.domain, menuId);
    if (!pgcN) throw new Error(`No menu ${menuId} in ${this.domain} domain`);
    this.setPGCN(pgcN);
  }

  setVtsPtt(vtsN, vtsTtn, part) {
    this.domain = Domain.VTS;
    this.vtsN = vtsN;
    const ptt = this.vts.ptts[vtsTtn - 1]?.[part - 1];
    if (!ptt) throw new Error(`No part ${part} of title ${vtsTtn} in title set ${vtsN}`);
    this.sprm[PTTN] = part;
    this.sprm[VTS_TTN] = vtsTtn;
    const tt = this.disc.vmg.titles.findIndex((t) => t.vtsN === vtsN && t.vtsTtn === vtsTtn);
    if (tt >= 0) this.sprm[TTN] = tt + 1;
    this.setPGCN(ptt.pgcN);
    this.pgN = ptt.pgN;
  }

  setTitle(tt) {
    const title = this.disc.vmg.titles[tt - 1];
    if (!title) throw new Error(`No title ${tt}`);
    this.setVtsPtt(title.vtsN, title.vtsTtn, 1);
  }

  saveResume(cellN) {
    this.rsm = {
      vtsN: this.vtsN,
      pgcN: this.pgcN,
      pgN: this.pgN,
      cellN: cellN || this.cellN,
      regs: [this.sprm[TTN], this.sprm[VTS_TTN], this.sprm[TT_PGCN], this.sprm[PTTN], this.sprm[HL_BTNN]],
      time: null, // seconds into the cell, when the player knows
    };
  }

  // Keep pgN in step with cellN. Returns false when cellN ran off the PGC.
  syncProgram() {
    if (this.cellN > this.pgc.nrCells) return false;
    const map = this.pgc.programMap;
    let pg = 1;
    while (pg < map.length && this.cellN >= map[pg]) pg++;
    this.pgN = pg;
    if (this.domain === Domain.VTS) {
      const ptts = this.vts.ptts[this.sprm[VTS_TTN] - 1] || [];
      const part = ptts.findIndex((p) => p.pgcN === this.pgcN && p.pgN === pg);
      if (part >= 0) this.sprm[PTTN] = part + 1;
    }
    return true;
  }

  // ---- PGC state machine ---------------------------------------------------

  playPGC() {
    this.pgN = 1;
    this.cellN = 0;
    const link = this.evalCommands(this.pgc.pre);
    return link || this.playPG();
  }

  playPGCatPG() {
    this.cellN = 0;
    const link = this.evalCommands(this.pgc.pre);
    return link || this.playPG();
  }

  playPG() {
    if (this.pgN > this.pgc.nrPrograms) return this.playPGCPost();
    this.cellN = this.pgc.programMap[this.pgN - 1];
    return this.playCell();
  }

  playCell(resumeTime = null) {
    if (this.cellN < 1 || this.cellN > this.pgc.nrCells) return this.playPGCPost();
    // Multi-angle blocks: always play the first angle.
    const cell = this.pgc.cells[this.cellN - 1];
    if (cell.blockType === 1 && cell.blockMode !== 1) {
      while (this.cellN > 1 && this.pgc.cells[this.cellN - 1].blockMode !== 1) this.cellN--;
    }
    this.syncProgram();
    return { command: 'PlayThis', resumeTime };
  }

  playCellPost() {
    const cell = this.pgc.cells[this.cellN - 1];
    if (cell && cell.cmdNr) {
      const cmd = this.pgc.cellCmds[cell.cmdNr - 1];
      if (cmd) {
        const link = this.evalCommands([cmd]);
        if (link) return link;
      }
    }
    // Advance, skipping the remaining angles of an angle block.
    if (cell && cell.blockType === 1) {
      this.cellN++;
      while (this.cellN <= this.pgc.nrCells && this.pgc.cells[this.cellN - 1].blockMode >= 2) this.cellN++;
    } else {
      this.cellN++;
    }
    if (!this.syncProgram()) return this.playPGCPost();
    return this.playCell();
  }

  playPGCPost() {
    const link = this.evalCommands(this.pgc.post);
    if (link) return link;
    if (this.pgc.nextPgcN) {
      this.setPGCN(this.pgc.nextPgcN);
      return this.playPGC();
    }
    return this.linkTo('Exit');
  }

  // Resolve a chain of links until the VM settles on a cell to play.
  run(link) {
    for (let guard = 0; guard < MAX_COMMANDS; guard++) {
      this.log(`link ${link.command} ${link.data1 ?? ''} ${link.data2 ?? ''} ${link.data3 ?? ''}`);
      link = this.processLink(link);
      if (link.type) return link;
    }
    throw new Error('DVD VM: navigation command loop');
  }

  processLink(link) {
    const { command, data1, data2, data3 } = link;
    const pgc = this.pgc;
    switch (command) {
      case 'PlayThis':
        this.stopped = false;
        return {
          type: 'cell',
          domain: this.domain,
          vtsN: this.vtsN,
          pgcN: this.pgcN,
          pgN: this.pgN,
          cellN: this.cellN,
          pgc,
          cell: pgc.cells[this.cellN - 1],
          position: pgc.cellPositions[this.cellN - 1],
          resumeTime: link.resumeTime,
        };
      case 'Exit':
        this.stopped = true;
        return { type: 'stop' };
      case 'LinkNoLink':
        if (data1) this.highlightedButton = data1;
        return { type: 'none' };
      case 'LinkTopC':
        if (data1) this.highlightedButton = data1;
        return this.playCell();
      case 'LinkNextC':
        if (data1) this.highlightedButton = data1;
        this.cellN++;
        return this.playCell();
      case 'LinkPrevC':
        if (data1) this.highlightedButton = data1;
        this.cellN = Math.max(1, this.cellN - 1);
        return this.playCell();
      case 'LinkTopPG':
        if (data1) this.highlightedButton = data1;
        return this.playPG();
      case 'LinkNextPG':
        if (data1) this.highlightedButton = data1;
        this.pgN++;
        return this.playPG();
      case 'LinkPrevPG':
        if (data1) this.highlightedButton = data1;
        this.pgN = Math.max(1, this.pgN - 1);
        return this.playPG();
      case 'LinkTopPGC':
        if (data1) this.highlightedButton = data1;
        return this.playPGC();
      case 'LinkNextPGC':
        if (data1) this.highlightedButton = data1;
        if (!pgc.nextPgcN) return this.linkTo('Exit');
        this.setPGCN(pgc.nextPgcN);
        return this.playPGC();
      case 'LinkPrevPGC':
        if (data1) this.highlightedButton = data1;
        if (!pgc.prevPgcN) return this.linkTo('Exit');
        this.setPGCN(pgc.prevPgcN);
        return this.playPGC();
      case 'LinkGoUpPGC':
        if (data1) this.highlightedButton = data1;
        if (!pgc.goupPgcN) return this.linkTo('Exit');
        this.setPGCN(pgc.goupPgcN);
        return this.playPGC();
      case 'LinkTailPGC':
        if (data1) this.highlightedButton = data1;
        return this.playPGCPost();
      case 'LinkRSM': {
        const rsm = this.rsm;
        if (!rsm) return this.linkTo('Exit');
        this.domain = Domain.VTS;
        this.vtsN = rsm.vtsN;
        this.setPGCN(rsm.pgcN);
        [this.sprm[TTN], this.sprm[VTS_TTN], this.sprm[TT_PGCN], this.sprm[PTTN], this.sprm[HL_BTNN]] = rsm.regs;
        if (data1) this.highlightedButton = data1;
        this.rsm = null;
        if (!rsm.cellN) {
          this.pgN = 1;
          return this.playPG();
        }
        this.cellN = rsm.cellN;
        return this.playCell(rsm.time);
      }
      case 'LinkPGCN':
        this.setPGCN(data1);
        return this.playPGC();
      case 'LinkPTTN':
        if (data2) this.highlightedButton = data2;
        this.setVtsPtt(this.vtsN, this.sprm[VTS_TTN], data1);
        return this.playPG();
      case 'LinkPGN':
        if (data2) this.highlightedButton = data2;
        this.pgN = data1;
        return this.playPG();
      case 'LinkCN':
        if (data2) this.highlightedButton = data2;
        this.cellN = data1;
        return this.playCell();
      case 'JumpTT':
        this.setTitle(data1);
        return this.playPGC();
      case 'JumpVTS_TT':
        this.setVtsPtt(this.vtsN, data1, 1);
        return this.playPGC();
      case 'JumpVTS_PTT':
        this.setVtsPtt(this.vtsN, data1, data2);
        return this.playPGCatPG();
      case 'JumpSS_FP':
        if (!this.setFirstPlay()) return this.linkTo('Exit');
        return this.playPGC();
      case 'JumpSS_VMGM_MENU':
        this.domain = Domain.VMGM;
        this.setMenu(data1);
        return this.playPGC();
      case 'JumpSS_VTSM':
        if (data1) this.vtsN = data1;
        this.domain = Domain.VTSM;
        if (data2) {
          this.sprm[VTS_TTN] = data2;
          const tt = this.disc.vmg.titles.findIndex((t) => t.vtsN === this.vtsN && t.vtsTtn === data2);
          if (tt >= 0) this.sprm[TTN] = tt + 1;
        }
        this.setMenu(data3);
        return this.playPGC();
      case 'JumpSS_VMGM_PGC':
        this.domain = Domain.VMGM;
        this.setPGCN(data1);
        return this.playPGC();
      case 'CallSS_FP':
        this.saveResume(data1);
        if (!this.setFirstPlay()) return this.linkTo('Exit');
        return this.playPGC();
      case 'CallSS_VMGM_MENU':
        this.saveResume(data2);
        this.domain = Domain.VMGM;
        this.setMenu(data1);
        return this.playPGC();
      case 'CallSS_VTSM':
        this.saveResume(data2);
        this.domain = Domain.VTSM;
        this.setMenu(data1);
        return this.playPGC();
      case 'CallSS_VMGM_PGC':
        this.saveResume(data2);
        this.domain = Domain.VMGM;
        this.setPGCN(data1);
        return this.playPGC();
      default:
        throw new Error(`DVD VM: unknown link ${command}`);
    }
  }

  // ---- command interpreter -------------------------------------------------

  reg(n) {
    return n & 0x80 ? this.sprm[n & 0x1f] : this.gprm[n & 0x0f];
  }

  // Run a command list. Returns a link if one of the commands jumped.
  evalCommands(cmds) {
    let i = 0;
    for (let total = 0; i < cmds.length && total < MAX_COMMANDS; total++) {
      const res = this.evalCommand(cmds[i]);
      if (res.link) return res.link;
      if (res.line === 256) break;
      i = res.line > 0 ? res.line - 1 : i + 1;
    }
    return null;
  }

  evalCommand(bytes) {
    const bits = bitReader(bytes);
    const regOrData = (imm, start) => (imm ? bits(start, 16) : this.reg(bits(start - 8, 8)));
    const regOrData2 = (imm, start) => (imm ? bits(start - 1, 7) : this.gprm[bits(start - 4, 4)]);
    const op = bits(54, 3);
    const if1 = () => !op || compare(op, this.reg(bits(39, 8)), regOrData(bits(55, 1), 31));
    const if2 = () => !op || compare(op, this.reg(bits(15, 8)), this.reg(bits(7, 8)));
    const if3 = () => !op || compare(op, this.reg(bits(47, 8)), regOrData(bits(55, 1), 15));
    const if4 = () => !op || compare(op, this.reg(bits(51, 4)), regOrData(bits(55, 1), 31));

    const linkSubins = (cond) => {
      const name = LINK_SUBINS[bits(4, 5)];
      return cond && name ? { link: this.linkTo(name, bits(15, 6)) } : {};
    };
    const linkIns = (cond) => {
      if (!cond) return {};
      switch (bits(51, 4)) {
        case 1: return linkSubins(cond);
        case 4: return { link: this.linkTo('LinkPGCN', bits(14, 15)) };
        case 5: return { link: this.linkTo('LinkPTTN', bits(9, 10), bits(15, 6)) };
        case 6: return { link: this.linkTo('LinkPGN', bits(6, 7), bits(15, 6)) };
        case 7: return { link: this.linkTo('LinkCN', bits(7, 8), bits(15, 6)) };
        default: return {};
      }
    };
    const jumpIns = (cond) => {
      if (!cond) return {};
      switch (bits(51, 4)) {
        case 1: return { link: this.linkTo('Exit') };
        case 2: return { link: this.linkTo('JumpTT', bits(22, 7)) };
        case 3: return { link: this.linkTo('JumpVTS_TT', bits(22, 7)) };
        case 5: return { link: this.linkTo('JumpVTS_PTT', bits(22, 7), bits(41, 10)) };
        case 6:
          switch (bits(23, 2)) {
            case 0: return { link: this.linkTo('JumpSS_FP') };
            case 1: return { link: this.linkTo('JumpSS_VMGM_MENU', bits(19, 4)) };
            case 2: return { link: this.linkTo('JumpSS_VTSM', bits(31, 8), bits(39, 8), bits(19, 4)) };
            default: return { link: this.linkTo('JumpSS_VMGM_PGC', bits(46, 15)) };
          }
        case 8:
          switch (bits(23, 2)) {
            case 0: return { link: this.linkTo('CallSS_FP', bits(31, 8)) };
            case 1: return { link: this.linkTo('CallSS_VMGM_MENU', bits(19, 4), bits(31, 8)) };
            case 2: return { link: this.linkTo('CallSS_VTSM', bits(19, 4), bits(31, 8)) };
            default: return { link: this.linkTo('CallSS_VMGM_PGC', bits(46, 15), bits(31, 8)) };
          }
        default: return {};
      }
    };
    const setOp = (setop, reg, reg2, data) => {
      const g = this.gprm;
      switch (setop) {
        case 1: g[reg] = data; break;
        case 2: g[reg2] = g[reg]; g[reg] = data; break;
        case 3: g[reg] = Math.min(0xffff, g[reg] + data); break;
        case 4: g[reg] = Math.max(0, g[reg] - data); break;
        case 5: g[reg] = Math.min(0xffff, g[reg] * data); break;
        case 6: if (data) g[reg] = Math.floor(g[reg] / data); break;
        case 7: if (data) g[reg] = g[reg] % data; break;
        case 8: if (data) g[reg] = 1 + Math.floor(Math.random() * data); break;
        case 9: g[reg] &= data; break;
        case 10: g[reg] |= data; break;
        case 11: g[reg] ^= data; break;
        default: break;
      }
    };
    const set1 = (cond) => {
      const data = regOrData(bits(60, 1), 31);
      if (cond) setOp(bits(59, 4), bits(35, 4), bits(19, 4), data);
    };
    const set2 = (cond) => {
      const data = regOrData(bits(60, 1), 47);
      if (cond) setOp(bits(59, 4), bits(51, 4), bits(35, 4), data);
    };
    const systemSet = (cond) => {
      const imm = bits(60, 1);
      switch (bits(59, 4)) {
        case 1: // SetSTN
          for (let i = 1; i <= 3; i++) {
            if (bits(47 - i * 8, 1) && cond) this.sprm[i] = regOrData2(imm, 47 - i * 8);
          }
          break;
        case 2: // SetNVTMR
          if (cond) {
            this.sprm[9] = regOrData(imm, 47);
            this.sprm[10] = bits(30, 15);
          }
          break;
        case 3: // SetGPRMMD
          if (cond) this.gprm[bits(19, 4)] = regOrData(imm, 47);
          break;
        case 6: // SetHL_BTNN
          if (cond) this.sprm[HL_BTNN] = regOrData(imm, 31);
          break;
        default:
          break;
      }
    };

    switch (bits(63, 3)) {
      case 0: { // special: nop, goto, break
        const cond = if1();
        switch (bits(51, 4)) {
          case 1: return { line: cond ? bits(7, 8) : 0 };
          case 2: return { line: cond ? 256 : 0 };
          case 3: return { line: cond ? bits(7, 8) : 0 }; // SetTmpPML: parental checks always pass
          default: return { line: 0 };
        }
      }
      case 1:
        return bits(60, 1) ? jumpIns(if2()) : linkIns(if1());
      case 2: {
        const cond = if2();
        systemSet(cond);
        return bits(51, 4) ? linkIns(cond) : {};
      }
      case 3: {
        const cond = if3();
        set1(cond);
        return bits(51, 4) ? linkIns(cond) : {};
      }
      case 4: {
        set2(true);
        return linkSubins(if4());
      }
      case 5: {
        const cond = if4();
        set2(cond);
        return linkSubins(cond);
      }
      case 6: {
        const cond = if4();
        set2(cond);
        return linkSubins(true);
      }
      default:
        return {};
    }
  }
}
