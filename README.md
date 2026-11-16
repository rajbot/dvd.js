# dvd.js

**Demo: https://www.bitstream.io/dvd.js/** — pick a disc from the list, or try
[BBS: The Documentary](https://www.bitstream.io/dvd.js/?item=BBS_Documentary_DVD_Set&iso=BBS%20Documentary%20Disc%201.iso&mp4item=dvdjs-bbs-documentary-demo) or
[Big Buck Bunny](https://www.bitstream.io/dvd.js/?item=BigBuckBunny&mp4item=dvdjs-big-buck-bunny-demo)
directly.

A DVD-Video player for the browser. It plays a DVD image stored in an
[archive.org](https://archive.org) item, menus included, without downloading
the image: the video is streamed from ordinary mp4 files (one per VOB on the
disc) and the disc's navigation — first play, menus, buttons, chapters, the
DVD virtual machine — runs in JavaScript.

It also supports a title's multiple audio streams (commentaries, other
languages) and multiple subtitle streams, with Audio and Subtitles buttons
under the video to switch between them or turn subtitles off. See
[Audio tracks and subtitles](#audio-tracks-and-subtitles).

    index.html?item=<archive.org identifier>[&iso=<image file name>][&mp4item=<identifier>]

No build step and no dependencies: `index.html` loads the ES modules in `src/`
directly, so the repository can be served as is (for example from GitHub Pages).

## How it works

1. The item's file list comes from `https://archive.org/metadata/<identifier>`.
   The disc image is the first original `ISO Image` file (or `&iso=`).
2. The IFO files are fetched from inside the image
   (`/download/<id>/<image>/VIDEO_TS%2FVIDEO_TS.IFO`); they are a few kilobytes
   and hold the whole structure of the disc.
3. The DVD virtual machine (`src/vm.js`) runs the disc's commands and decides
   which cell to play. The player (`src/player.js`) plays it by seeking a
   `<video>` element to that cell's place in the mp4 of its VOB.
4. For menus, the menu VOB is read from inside the image as a stream while
   the menu's mp4 is already playing. Its NAV packs give the button positions
   and commands, and its subpicture stream gives the button highlights, which
   are drawn on a canvas over the video. Buttons work with the mouse or with
   the arrow keys and Enter. If the item has a `.nav.bin` file for the VOB
   (see [Buttons](#buttons)), that is read instead of the VOB.

### The mp4s it needs

One mp4 per VOB file, with the same base name: `VIDEO_TS.mp4` (from
`VIDEO_TS.VOB`), `VTS_01_0.mp4`, `VTS_01_1.mp4`, `VTS_01_2.mp4`, …

The player looks in the item's file list for a file with that name, in any
directory, preferring one that archive.org derived itself (`source` is
`derivative`) over an uploaded one. Today archive.org makes `VTS_xx_n.mp4` for
some DVD items but nothing for the menu VOBs, so until it does, generate them
with `tools/make-derivatives.mjs` and upload them alongside the image.

If the mp4s can't go in the disc's own item, put them in another one and name
it with `&mp4item=`. The disc's own item is still searched first.

An item can hold several discs. Pick one with `&iso=`, and keep each disc's
mp4s in a directory named after its image (`Disc 2.iso` -> `Disc 2/VTS_01_1.mp4`).
A disc never uses files from another disc's directory.

### Buttons

A menu VOB can be hundreds of megabytes, and a menu's buttons can't be used
until the player has read as far as that menu. So `tools/make-derivatives.mjs`
also writes `VTS_01_0.nav.bin` next to `VTS_01_0.mp4`: the VOB's NAV packs
and subpicture packs and nothing else, a few megabytes at most. The player
reads it instead of the VOB when it is there.

Titles can have buttons over the video too (a choice of what to watch next, a
hidden extra). The player never reads title VOBs, so those buttons only work
from a nav file: the tool writes one for each title set that has buttons,
covering all of the set's VOBs and named after the first
(`VTS_09_1.nav.bin`). It is fetched when a title of that set first plays.
While such buttons are up, an arrow key that has another button to go to
moves the highlight; otherwise the left and right arrows still seek.

A nav file is made from the VOB alone, so it can sit in either item (the
disc's own or the `&mp4item=` one), whichever mp4 is being played.

### Audio tracks and subtitles

A title can have several audio tracks and subtitle tracks. The player lists
them (from the IFO) under two buttons in the control bar, Audio and
Subtitles; A and S step through them. Browsers can't switch between audio tracks inside an mp4, and DVD
subtitles are pictures, so both need extra files next to a title VOB's mp4.
`tools/make-derivatives.mjs` writes them:

| File | |
| --- | --- |
| `VTS_01_1.mp4` | video, plus the disc's first audio track; its `comment` tag (`dvd.js audio=80`) names that stream |
| `VTS_01_1.audio-a1.m4a` | each further audio track, named by its stream id, on the mp4's timeline |
| `VTS_01_1.spu.bin` | all the subtitle streams of that VOB: the disc's own subpicture data, with times |
| `extras.json` | which of these exist for each VOB, and which audio stream each mp4 holds |

The extras are read from the `extras.json` in the same directory as the mp4
being played, so they always describe that mp4. A track with no file is still
listed, greyed out. When another audio track is chosen the video is muted and
the m4a is played alongside it, kept within 0.2 s of the picture; if the m4a
can't be played, the player goes back to a track that can and says so.
Subtitles are drawn over the video in the disc's own colours, and subtitles a
disc forces on (signs, foreign dialogue) are shown even when Subtitles is Off.
Menus keep the audio of their mp4.

The mp4's timeline has to be the VOB's presentation timeline with every
timestamp discontinuity closed up:

> mp4 time = the sum of the durations (`vobu_e_ptm − vobu_s_ptm`) of all the
> VOBUs before that point in the VOB file

That is what a straight transcode gives for a VOB whose clock never resets.
VOBs made of several pieces (a menu VOB with several menus, a title VOB with
several titles, still frames) restart their clock at each piece, and a naive
transcode drops or misplaces those pieces; `make-derivatives.mjs` transcodes
each continuous run on its own and concatenates them. It also puts a keyframe
at the start of every cell.

With that timeline the player can find any cell without reading the VOB: a
cell starts at the sum of the playback times, from the IFO, of the cells
stored before it.

## Running it locally

    node tools/serve.mjs            # http://localhost:8000/
    npm test

`tools/serve.mjs` is a small static server that answers Range requests
(`python -m http.server` doesn't, and video can't seek without them).

To make the mp4s for a disc (needs ffmpeg, and 7z or bsdtar for images):

    node tools/make-derivatives.mjs <disc image | VIDEO_TS dir> <out dir>

To play a disc from local files instead of archive.org:

    index.html?videots=<url of a VIDEO_TS dir>&mp4=<url of the mp4 dir>

## Layout

| File | |
| --- | --- |
| `src/ifo.js` | IFO parser (VMG and VTS: PGCs, cells, titles, chapters, menus) |
| `src/nav.js` | VOB scanner: NAV packs (buttons), subpicture decoding |
| `src/vm.js` | DVD virtual machine: registers, command interpreter, PGC state machine |
| `src/disc.js` | Maps cells onto the mp4 timelines; streams the menu VOBs |
| `src/archive.js` | archive.org item access (and plain URLs for local use) |
| `src/player.js` | The player UI |
| `tools/make-derivatives.mjs` | Makes the per-VOB mp4s with ffmpeg, and the audio, subtitle and button files |

## What archive.org allows from another origin

Found while building this; it shapes the design.

- `archive.org/metadata/<id>` sends `Access-Control-Allow-Origin: *`.
- Files inside an image (`/download/<id>/<image>/<path>`) can be fetched
  cross-origin, but Range is ignored: the whole file always comes back. That is
  why menu VOBs are read as a stream from the start, and why title VOBs (which
  can be a gigabyte each) are never read at all.
- Plain item files (the image itself, the mp4s) answer Range requests but
  without CORS headers. `<video>` can play them; `fetch` can't read them.

## Limitations

- Multi-angle titles play the first angle (none of the test discs has one).
- Subtitle and audio choices made by a disc's own setup menu are honoured.
  Forced subtitles are untested: none of the test discs has any.
- A separate audio track is played by a second media element, so it can be
  up to 0.2 s out of step with the picture.
- Button highlights are drawn; a menu's own subpicture artwork outside the
  highlighted button is not.
- Without a `.nav.bin` file, a menu VOB over 512 MB is not scanned to the
  end, and buttons over a title's video don't work at all.
- From inside a menu, the Menu button does nothing on discs whose root menu
  only works when called from a title.
- Parental levels and region codes are ignored; navigation timers are not run.
- Seeking and chapter skipping are always allowed (user-operation prohibitions
  are ignored).
- Tested on eight discs: one authored with dvdauthor with motion menus, one
  with 14 title sets and motion menus (Big Buck Bunny), a three-disc set with
  still menus and titles split across several VOBs (BBS: The Documentary), a
  two-disc set with scripted menus, a branching "interactive" version and
  buttons over the video (GET LAMP), and one with no menu.

## License

GPL-2.0-or-later; see `COPYING`.

dvd.js contains no code from other projects, but the DVD virtual machine
(`src/vm.js`) follows the design of [libdvdnav](https://code.videolan.org/videolan/libdvdnav)'s
and the IFO parser (`src/ifo.js`) follows the structure layouts in
[libdvdread](https://code.videolan.org/videolan/libdvdread). Both are
GPL-2.0-or-later, so dvd.js uses the same license.
