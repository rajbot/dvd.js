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
export class ArchiveSource {
  static async open(identifier, imageName = null) {
    const meta = await (await get(`${ARCHIVE}/metadata/${encodeURIComponent(identifier)}`)).json();
    if (!meta.files) throw new Error(`archive.org has no item "${identifier}"`);
    const images = meta.files.filter((f) => f.source === 'original' && (f.format === 'ISO Image' || IMAGE_NAME.test(f.name)));
    const image = imageName ? images.find((f) => f.name === imageName) : images[0];
    if (!image) throw new Error(imageName ? `"${imageName}" is not a disc image in ${identifier}` : `${identifier} has no DVD disc image`);
    return new ArchiveSource(identifier, meta, image.name);
  }

  constructor(identifier, meta, image) {
    this.identifier = identifier;
    this.files = meta.files;
    this.image = image;
    this.title = meta.metadata?.title || identifier;
    this.link = `${ARCHIVE}/details/${encodeURIComponent(identifier)}`;
  }

  fileUrl(name) {
    return `${ARCHIVE}/download/${encodeURIComponent(this.identifier)}/${name.split('/').map(encodeURIComponent).join('/')}`;
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
  async mp4(base) {
    const wanted = `${base}.mp4`.toLowerCase();
    const found = this.files.filter((f) => f.name.split('/').pop().toLowerCase() === wanted);
    const file = found.find((f) => f.source === 'derivative') || found[0];
    if (!file) return null;
    return { url: this.fileUrl(file.name), duration: parseLength(file.length), derivative: file.source === 'derivative' };
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
