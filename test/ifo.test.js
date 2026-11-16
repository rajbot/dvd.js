import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audioStreamId, parseDvdTime, parseVMG, parseVTS } from '../src/ifo.js';
import { buildPGC, buildVMG, buildVTS } from './helpers.js';

test('parseDvdTime reads BCD times at the disc frame rate', () => {
  assert.equal(parseDvdTime(0x00000000), 0);
  assert.equal(parseDvdTime(0x01023040 | 0x05), 3750 + 5 / 25); // PAL 01:02:30.05
  // NTSC counts 30 frames a second, so real time runs 0.1% long
  assert.ok(Math.abs(parseDvdTime(0x001045c0 | 0x15) - (645 + 15 / 30) * 1.001) < 1e-9);
});

test('parseVMG reads the first-play PGC, titles and menus', () => {
  const vmg = parseVMG(
    buildVMG({
      firstPlay: buildPGC({ pre: ['3002000000010000'] }),
      titles: [{ vtsN: 1, vtsTtn: 1 }, { vtsN: 1, vtsTtn: 2 }],
      menus: [{ entryId: 0x82, bytes: buildPGC({ cells: [{ time: 0x00000540, first: 0, last: 99 }] }) }],
    })
  );
  assert.equal(vmg.nrTitleSets, 1);
  assert.equal(vmg.titles.length, 2);
  assert.deepEqual([vmg.titles[1].vtsN, vmg.titles[1].vtsTtn], [1, 2]);
  assert.equal(vmg.firstPlayPgc.pre.length, 1);
  assert.equal(vmg.menuUnits[0].lang, 'en');
  assert.equal(vmg.menuUnits[0].pgcit[0].entryId, 0x82);
  assert.equal(vmg.menuUnits[0].pgcit[0].pgc.cells[0].lastSector, 99);
});

test('parseVTS reads title PGCs, cells and chapters', () => {
  const vts = parseVTS(
    buildVTS({
      pgcs: [
        { bytes: buildPGC({ cells: [{ time: 0x00010040, first: 0, last: 499, cellId: 1 }, { time: 0x00000240, first: 500, last: 599, cellId: 2, still: 5 }] }) },
        { bytes: buildPGC({ cells: [{ time: 0x00020040, first: 600, last: 999, vobId: 2, cellId: 1 }] }) },
      ],
    })
  );
  assert.equal(vts.pgcit.length, 2);
  assert.deepEqual(vts.ptts, [[{ pgcN: 1, pgN: 1 }], [{ pgcN: 2, pgN: 1 }]]);
  const [a, b] = vts.pgcit[0].pgc.cells;
  assert.equal(a.playbackTime, 60);
  assert.equal(b.firstSector, 500);
  assert.equal(b.stillTime, 5);
  assert.deepEqual(vts.pgcit[1].pgc.cellPositions, [{ vobId: 2, cellId: 1 }]);
});

test('parsers reject files of the wrong kind', () => {
  assert.throws(() => parseVMG(buildVTS({ pgcs: [] })), /VIDEO_TS\.IFO/);
  assert.throws(() => parseVTS(new Uint8Array(4096)), /VTS_xx_0\.IFO/);
});

test('audioStreamId adds the stream number to the base for the format', () => {
  assert.equal(audioStreamId({ format: 'ac3' }, 0x8000), 0x80);
  assert.equal(audioStreamId({ format: 'ac3' }, 0x8300), 0x83);
  assert.equal(audioStreamId({ format: 'lpcm' }, 0x8100), 0xa1);
  assert.equal(audioStreamId({ format: 'mpeg1' }, 0x8000), 0xc0);
  assert.equal(audioStreamId({ format: 'dts' }, 0x8200), 0x8a);
});
