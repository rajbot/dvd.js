import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArchiveSource } from '../src/archive.js';

const file = (name, source = 'original') => ({ name, source });

function source(files, image = 'Disc 2.iso', images = ['Disc 1.iso', 'Disc 2.iso']) {
  return new ArchiveSource('item', { files }, image, images);
}

test('a disc takes the mp4 in its own directory', async () => {
  const s = source([file('Disc 1/VTS_01_1.mp4'), file('Disc 2/VTS_01_1.mp4')]);
  assert.equal((await s.mp4('VTS_01_1')).url, 'https://archive.org/download/item/Disc%202/VTS_01_1.mp4');
});

test("a disc never takes another disc's files", async () => {
  const s = source([file('Disc 1/VTS_01_1.mp4'), file('Disc 1/extras.json')]);
  assert.equal(await s.mp4('VTS_01_1'), null);
  assert.equal(await s.extras('VTS_01_1'), null);
});

test('files outside any disc directory are shared', async () => {
  const s = source([file('dvdjs/VTS_01_1.mp4'), file('Disc 1/VTS_01_1.mp4')]);
  assert.equal((await s.mp4('VTS_01_1')).url, 'https://archive.org/download/item/dvdjs/VTS_01_1.mp4');
});

test("the archive's own derivative wins, and extras made for another mp4 are not used", async () => {
  const s = source([file('VTS_01_1.mp4', 'derivative')], 'disc.iso', ['disc.iso']);
  s.mp4Items.push({ identifier: 'extra', files: [file('dvdjs/VTS_01_1.mp4'), file('dvdjs/extras.json')] });
  const mp4 = await s.mp4('VTS_01_1');
  assert.equal(mp4.url, 'https://archive.org/download/item/VTS_01_1.mp4');
  assert.equal(mp4.derivative, true);
  assert.equal(await s.extras('VTS_01_1'), null);
});

test('extras come from the extras.json beside the mp4', async (t) => {
  const s = source([], 'disc.iso', ['disc.iso']);
  s.mp4Items.push({ identifier: 'extra', files: [file('dvdjs/VTS_01_1.mp4'), file('dvdjs/extras.json')] });
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetched.push(url);
    return { ok: true, json: async () => ({ VTS_01_1: { main: '80', audio: ['81'], subs: true } }) };
  });
  const extras = await s.extras('VTS_01_1');
  assert.deepEqual(fetched, ['https://archive.org/cors/extra/dvdjs/extras.json']);
  assert.equal(extras.main, '80');
  assert.deepEqual([...extras.audio], [['81', 'https://archive.org/download/extra/dvdjs/VTS_01_1.audio-81.m4a']]);
  assert.equal(extras.subsUrl, 'https://archive.org/cors/extra/dvdjs/VTS_01_1.spu.bin');
  await s.extras('VTS_01_1');
  assert.equal(fetched.length, 1);
});
