// Where the disc's files come from. A source gives the player three things:
//   readFile(name)    -> Uint8Array of a small VIDEO_TS file (the IFOs)
//   openStream(name)  -> ReadableStream of a VIDEO_TS file (the menu VOBs)
//   mp4(base)         -> { url, duration } of the streaming mp4 made from
//                        <base>.VOB, or null if the item doesn't have one

const ARCHIVE = 'https://archive.org';
const IMAGE_NAME = /\.(iso|cdr|img|udf)$/i;

// files.xml lengths are either seconds ("647.42") or clock times ("10:47").
function parseLength(length) {
  if (!length) return null;
  const secs = String(length).split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0);
  return Number.isFinite(secs) && secs > 0 ? secs : null;
}

async function get(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

// A DVD image inside an archive.org item. The IFOs and menu VOBs are read
// straight out of the image (archive.org serves the files inside an ISO), and
// the video comes from the item's per-VOB mp4s.
//
// mp4Identifier names a second item to take the mp4s from, for discs whose
// own item doesn't have them (yet).
export class ArchiveSource {
  static async open(identifier, imageName = null, mp4Identifier = null) {
    const load = async (id) => {
      const meta = await (await get(`${ARCHIVE}/metadata/${encodeURIComponent(id)}`)).json();
      if (!meta.files) throw new Error(`archive.org has no item "${id}"`);
      return meta;
    };
    const [meta, mp4Meta] = await Promise.all([load(identifier), mp4Identifier ? load(mp4Identifier) : null]);
    const images = meta.files.filter((f) => f.source === 'original' && (f.format === 'ISO Image' || IMAGE_NAME.test(f.name)));
    const image = imageName ? images.find((f) => f.name === imageName) : images[0];
    if (!image) throw new Error(imageName ? `"${imageName}" is not a disc image in ${identifier}` : `${identifier} has no DVD disc image`);
    const source = new ArchiveSource(identifier, meta, image.name);
    if (mp4Meta) source.mp4Items.push({ identifier: mp4Identifier, files: mp4Meta.files });
    return source;
  }

  constructor(identifier, meta, image) {
    this.identifier = identifier;
    this.mp4Items = [{ identifier, files: meta.files }];
    this.image = image;
    this.title = meta.metadata?.title || identifier;
    this.link = `${ARCHIVE}/details/${encodeURIComponent(identifier)}`;
  }

  fileUrl(name, identifier = this.identifier) {
    return `${ARCHIVE}/download/${encodeURIComponent(identifier)}/${name.split('/').map(encodeURIComponent).join('/')}`;
  }

  discUrl(name) {
    return `${this.fileUrl(this.image)}/${encodeURIComponent(`VIDEO_TS/${name}`)}`;
  }

  async readFile(name) {
    return new Uint8Array(await (await get(this.discUrl(name))).arrayBuffer());
  }

  async openStream(name, signal) {
    return (await get(this.discUrl(name), signal)).body;
  }

  // Prefer the mp4 the archive derived itself; until it makes one for every
  // VOB, fall back to an uploaded file of the same name (in any directory).
  // Items with several discs keep each disc's mp4s in a directory named
  // after its image ("Disc 2.iso" -> "Disc 2/VTS_01_1.mp4").
  async mp4(base) {
    const wanted = `${base}.mp4`.toLowerCase();
    const disc = this.image.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
    for (const { identifier, files } of this.mp4Items) {
      let found = files.filter((f) => f.name.split('/').pop().toLowerCase() === wanted);
      const mine = found.filter((f) => f.name.toLowerCase().split('/').slice(0, -1).includes(disc));
      if (mine.length) found = mine;
      const file = found.find((f) => f.source === 'derivative') || found[0];
      if (file) return { url: this.fileUrl(file.name, identifier), duration: parseLength(file.length), derivative: file.source === 'derivative' };
    }
    return null;
  }
}

// Plain URLs, for local development: a VIDEO_TS directory and a directory of
// mp4s made by tools/make-derivatives.mjs.
export class UrlSource {
  constructor(videoTs, mp4Dir) {
    this.videoTs = videoTs.replace(/\/$/, '');
    this.mp4Dir = mp4Dir.replace(/\/$/, '');
    this.title = this.videoTs;
    this.link = null;
  }

  async readFile(name) {
    return new Uint8Array(await (await get(`${this.videoTs}/${name}`)).arrayBuffer());
  }

  async openStream(name, signal) {
    return (await get(`${this.videoTs}/${name}`, signal)).body;
  }

  async mp4(base) {
    const url = `${this.mp4Dir}/${base}.mp4`;
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok ? { url, duration: null, derivative: false } : null;
  }
}
