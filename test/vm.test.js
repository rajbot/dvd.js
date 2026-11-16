import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVMG, parseVTS } from '../src/ifo.js';
import { Domain, DvdVM } from '../src/vm.js';
import { buildPGC, buildVMG, buildVTS, cmd } from './helpers.js';

// A two-title disc with a main menu, wired the way dvdauthor does it:
// first play jumps to the menu; menu buttons set g0 and the menu's post
// commands jump to that title; each title returns to the menu when it ends.
function disc() {
  const menu = buildPGC({
    cells: [{ time: 0x00001040, first: 0, last: 99 }],
    post: [
      '00a1000000010004', // if g0 == 1 goto 4
      '00a1000000020005', // if g0 == 2 goto 5
      '2001000000000009', // LinkTopPGC (loop the menu)
      '3002000000010000', // JumpTT 1
      '3002000000020000', // JumpTT 2
    ],
  });
  const vmg = parseVMG(
    buildVMG({
      firstPlay: buildPGC({ pre: ['3006000000420000'] }), // JumpSS VMGM title menu
      titles: [{ vtsN: 1, vtsTtn: 1 }, { vtsN: 1, vtsTtn: 2 }],
      menus: [{ entryId: 0x82, bytes: menu }],
    })
  );
  const toMenu = '3008000001420000'; // CallSS VMGM title menu, resume cell 1
  const vts = parseVTS(
    buildVTS({
      pgcs: [
        { bytes: buildPGC({ cells: [{ time: 0x00010040, cellId: 1 }, { time: 0x00010040, cellId: 2 }], post: [toMenu] }) },
        { bytes: buildPGC({ cells: [{ time: 0x00020040, vobId: 2, cellId: 1 }], post: [toMenu] }) },
      ],
    })
  );
  return { vmg, vts: { 1: vts } };
}

const where = (s) => (s.type === 'cell' ? `${s.domain} ${s.pgcN}/${s.cellN}` : s.type);
const pick = (n) => cmd(`7101000000${n.toString(16).padStart(2, '0')}000d`); // g0 = n; LinkTailPGC

test('first play lands on the menu', () => {
  const vm = new DvdVM(disc());
  assert.equal(where(vm.start()), `${Domain.VMGM} 1/1`);
  assert.equal(vm.inMenu, true);
});

test('a menu with no selection loops', () => {
  const vm = new DvdVM(disc());
  vm.start();
  assert.equal(where(vm.cellEnded()), `${Domain.VMGM} 1/1`);
});

test('buttons run their command and jump to a title', () => {
  const vm = new DvdVM(disc());
  vm.start();
  const step = vm.activateButton(pick(2));
  assert.equal(where(step), `${Domain.VTS} 2/1`);
  assert.deepEqual(step.position, { vobId: 2, cellId: 1 });
  assert.equal(vm.title, 2);
});

test('a button command that goes nowhere returns null', () => {
  const vm = new DvdVM(disc());
  vm.start();
  assert.equal(vm.activateButton(cmd('7100000100050000')), null); // g1 = 5
  assert.equal(vm.gprm[1], 5);
});

test('cells play in order and the title returns to the menu', () => {
  const vm = new DvdVM(disc());
  vm.start();
  assert.equal(where(vm.activateButton(pick(1))), `${Domain.VTS} 1/1`);
  assert.equal(where(vm.cellEnded()), `${Domain.VTS} 1/2`);
  assert.equal(where(vm.cellEnded()), `${Domain.VMGM} 1/1`);
});

test('menu call saves the position and resume returns to it', () => {
  const vm = new DvdVM(disc());
  vm.start();
  vm.activateButton(pick(1));
  vm.cellEnded();
  assert.equal(where(vm.menuCall(2, 12.5)), `${Domain.VMGM} 1/1`);
  const step = vm.resume();
  assert.equal(where(step), `${Domain.VTS} 1/2`);
  assert.equal(step.resumeTime, 12.5);
  assert.equal(vm.resume(), null);
});

test('jumpCell seeks inside the current PGC', () => {
  const vm = new DvdVM(disc());
  vm.start();
  vm.activateButton(pick(1));
  const step = vm.jumpCell(2, 30);
  assert.equal(where(step), `${Domain.VTS} 1/2`);
  assert.equal(step.resumeTime, 30);
  assert.equal(vm.jumpCell(3), null);
});

test('a disc without a first-play PGC starts at title 1', () => {
  const d = disc();
  d.vmg.firstPlayPgc = null;
  assert.equal(where(new DvdVM(d).start()), `${Domain.VTS} 1/1`);
});

test('conditions, arithmetic and goto', () => {
  const vm = new DvdVM(disc());
  const link = vm.evalCommands([
    cmd('7100000200070000'), // g2 = 7
    cmd('7300000200030000'), // g2 += 3
    cmd('00a1000200090005'), // if g2 == 9 goto 5 (not taken)
    cmd('00c10002000a0006'), // if g2 >= 10 goto 6
    cmd('3002000000010000'), // JumpTT 1 (skipped)
    cmd('3002000000020000'), // JumpTT 2
  ]);
  assert.equal(vm.gprm[2], 10);
  assert.deepEqual(link, { command: 'JumpTT', data1: 2, data2: 0, data3: 0 });
});

test('a menu call that runs off the end of the disc leaves the player where it was', () => {
  const d = disc();
  // A root menu with no cells: it sets g1 and then has nowhere to go.
  const root = buildPGC({ pre: ['7100000100070000'] });
  d.vts[1] = parseVTS(
    buildVTS({
      pgcs: [{ bytes: buildPGC({ cells: [{ time: 0x00010040, cellId: 1 }] }) }],
      menus: [{ entryId: 0x83, bytes: root }],
    })
  );
  const vm = new DvdVM(d);
  vm.start();
  const title = vm.activateButton(pick(1));
  assert.equal(vm.menuCall(3, 5), null);
  assert.equal(vm.domain, Domain.VTS);
  assert.equal(vm.pgc, title.pgc);
  assert.equal(vm.gprm[1], 0);
  assert.equal(vm.rsm, null);
  assert.equal(vm.stopped, false);
});
