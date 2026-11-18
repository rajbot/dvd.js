#!/usr/bin/env python3
"""Build the streaming files dvd.js needs from a DVD image.

A Python port of tools/make-derivatives.mjs, for running where Node isn't
(an archive.org deriver, say). It takes the same arguments and writes the
same files; see that script for what each file is.

    python3 tools/make_derivatives.py [--extras-only] <disc image | VIDEO_TS dir> <out dir>

One mp4 per VOB file (VIDEO_TS.mp4, VTS_01_0.mp4, VTS_01_1.mp4, ...), and for
title VOBs:
    VTS_01_1.audio-a1.m4a   each further audio stream (named by stream id)
    VTS_01_1.spu.bin        the subtitle (subpicture) streams
    extras.json             which of those exist, and which audio stream each mp4 has
and for menu VOBs, and title sets with buttons over the video:
    VTS_01_0.nav.bin        the NAV packs and subpicture packs
--extras-only makes just these, next to mp4s made earlier.

The mp4 timeline is the VOB's presentation timeline with every timestamp
discontinuity closed up (see the README). The IFO and VOB parsing here
mirrors src/ifo.js and src/nav.js, keeping only what this tool needs.

Requires Python 3.8+ (standard library only), ffmpeg, and 7z or bsdtar when
given a disc image.
"""

import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from decimal import ROUND_HALF_UP, Decimal

SECTOR = 2048
CHUNK = 8 * 1024 * 1024
SUBTITLE_MAGIC = b"DVDJSSP1"

# "No choice made": the mp4 takes whatever audio its VOB has (menus), or, with
# --extras-only, an mp4 that doesn't say which stream it holds. (None means
# the mp4 has no audio of the disc's tracks.) undefined in the JS version.
UNSET = object()


def js_round(x):
    """Math.round: halves go up, not to even."""
    return math.floor(x + 0.5)


def fixed(x, digits):
    """Number.prototype.toFixed: rounds the exact binary value with halves
    away from zero (format() rounds them to even), and -0 is "0"."""
    if abs(x) >= 1e21:
        return js_number(x)
    return str(Decimal(x if x else 0).quantize(Decimal(1).scaleb(-digits), ROUND_HALF_UP))


def js_number(x):
    """A number as JavaScript writes it (Number.prototype.toString): 3.0 is
    "3", and exponents only below 1e-6 or from 1e21."""
    if isinstance(x, int) or (x.is_integer() and abs(x) < 1e21):
        return str(int(x))
    sign, digits, exp = Decimal(repr(x)).normalize().as_tuple()
    d = "".join(map(str, digits))
    k, n = len(d), len(d) + exp  # the value is 0.d * 10^n
    if k <= n <= 21:
        s = d + "0" * (n - k)
    elif 0 < n <= 21:
        s = d[:n] + "." + d[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * -n + d
    else:
        s = d[0] + ("." + d[1:] if k > 1 else "") + "e" + ("+" if n > 0 else "-") + str(abs(n - 1))
    return ("-" if sign else "") + s


def js_json(value, indent=1, depth=0):
    """JSON.stringify(value, null, indent)."""
    if value is None or isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    inner = "\n" + " " * (indent * (depth + 1))
    if isinstance(value, dict):
        items = [f"{json.dumps(k, ensure_ascii=False)}: {js_json(v, indent, depth + 1)}" for k, v in value.items()]
        brackets = "{}"
    else:
        items = [js_json(v, indent, depth + 1) for v in value]
        brackets = "[]"
    if not items:
        return brackets
    return brackets[0] + inner + ("," + inner).join(items) + "\n" + " " * (indent * depth) + brackets[1]


# ---- IFO files (src/ifo.js) -------------------------------------------------


def u16(b, off):
    return struct.unpack_from(">H", b, off)[0]


def u32(b, off):
    return struct.unpack_from(">I", b, off)[0]


def parse_video_attr(b, off):
    b0, b1 = b[off], b[off + 1]
    return {
        "format": "PAL" if (b0 >> 4) & 3 else "NTSC",
        "aspect": "16:9" if (b0 >> 2) & 3 == 3 else "4:3",
    }


AUDIO_FORMATS = ["ac3", "unknown", "mpeg1", "mpeg2ext", "lpcm", "unknown", "dts", "sdds"]
AUDIO_STREAM_BASE = {"ac3": 0x80, "dts": 0x88, "lpcm": 0xA0, "mpeg1": 0xC0, "mpeg2ext": 0xC0}


def parse_audio_attr(b, off):
    return {"format": AUDIO_FORMATS[(b[off] >> 5) & 7], "channels": (b[off + 1] & 7) + 1}


def audio_stream_id(attr, control):
    """Stream id of an audio track in the VOB: the base for its format plus the
    stream number from the PGC's audio control word."""
    return AUDIO_STREAM_BASE.get(attr["format"], 0x80) + ((control >> 8) & 7)


def parse_pgc(b, off):
    """The parts of a PGC this tool reads: its audio control words."""
    return {"audioControl": [u16(b, off + 0x0C + i * 2) for i in range(8)]}


def parse_pgcit(b, off):
    return [{"pgc": parse_pgc(b, off + u32(b, off + 8 + i * 8 + 4))} for i in range(u16(b, off))]


def read_table(b, field, parser, empty):
    """The table at the sector stored in the header, or `empty` when the disc
    doesn't have that table."""
    sector = u32(b, field)
    if not sector or sector * SECTOR >= len(b):
        return empty
    return parser(b, sector * SECTOR)


def parse_menu_attrs(b, base):
    return {"video": parse_video_attr(b, base)}


def parse_vmg(b):
    if b[0:12] != b"DVDVIDEO-VMG":
        raise ValueError("Not a VIDEO_TS.IFO (bad magic)")
    return {"nrTitleSets": u16(b, 0x3E), "menuAttrs": parse_menu_attrs(b, 0x100)}


def parse_vts(b):
    if b[0:12] != b"DVDVIDEO-VTS":
        raise ValueError("Not a VTS_xx_0.IFO (bad magic)")
    n_audio = b[0x203]
    audio = [parse_audio_attr(b, 0x204 + i * 8) for i in range(min(n_audio, 8))]
    return {
        "pgcit": read_table(b, 0xCC, parse_pgcit, []),
        "menuAttrs": parse_menu_attrs(b, 0x100),
        "attrs": {"video": parse_video_attr(b, 0x200), "audio": audio},
    }


# ---- VOBs (src/nav.js) ------------------------------------------------------

PCI = 0x2D  # PCI payload offset inside a NAV pack
DSI = 0x407  # DSI payload offset inside a NAV pack
PACK_START = b"\x00\x00\x01\xba"


def is_start_code(b, off, stream_id):
    return b[off] == 0 and b[off + 1] == 0 and b[off + 2] == 1 and b[off + 3] == stream_id


def is_nav_pack(b, off=0):
    return (
        is_start_code(b, off, 0xBA)
        and is_start_code(b, off + 14, 0xBB)
        and is_start_code(b, off + 0x26, 0xBF)
        and b[off + 0x2C] == 0x00
        and is_start_code(b, off + 0x400, 0xBF)
        and b[off + 0x406] == 0x01
    )


def is_subpicture_pack(b, off=0):
    """A pack of private stream 1 that carries a subpicture stream."""
    if not is_start_code(b, off, 0xBA):
        return False
    p = off + 14 + (b[off + 13] & 7)
    if not is_start_code(b, p, 0xBD):
        return False
    stream = b[p + 9 + b[p + 8]]
    return 0x20 <= stream <= 0x3F


def parse_pts(b, off):
    return ((b[off] >> 1) & 7) * 0x40000000 + (
        (b[off + 1] << 22) | ((b[off + 2] >> 1) << 15) | (b[off + 3] << 7) | (b[off + 4] >> 1)
    )


class Vobu:
    """One VOBU: its NAV pack, and what the packs after it carry."""

    __slots__ = (
        "sector", "start_ptm", "end_ptm", "hli_status", "btn_ns", "vob_id", "cell_id",
        "has_video", "has_audio", "audio",
        "cell", "end_sector", "home", "run", "time",
    )

    def __init__(self, sector, b, off):
        hl = off + PCI + 96
        self.sector = sector
        self.start_ptm = u32(b, off + PCI + 12)
        self.end_ptm = u32(b, off + PCI + 16)
        self.hli_status = u16(b, hl) & 3
        self.btn_ns = b[hl + 17]
        self.vob_id = u16(b, off + DSI + 24)
        self.cell_id = b[off + DSI + 27]
        self.has_video = False
        self.has_audio = False
        self.audio = []

    def heard(self, stream):
        self.has_audio = True
        if stream not in self.audio:
            self.audio.append(stream)


class VobScanner:
    """Reads a VOB sector by sector, keeping the VOBUs (NAV packs) in file
    order and the reassembled subpicture units of each SPU stream."""

    def __init__(self):
        self.vobus = []
        self.spus = {}  # stream -> [{"pts", "data", "vobu"}], in stream order of first unit
        self.sectors = 0
        self.partial = {}  # stream -> {"pts", "data", "size", "vobu"}

    def pack(self, b, off):
        """Take in one sector, b[off:off + SECTOR]. True if it is a NAV pack or
        a subpicture pack (is_nav_pack or is_subpicture_pack)."""
        sector = self.sectors
        self.sectors += 1
        if b[off:off + 4] != PACK_START:
            return False
        if is_nav_pack(b, off):
            self.vobus.append(Vobu(sector, b, off))
            return True
        vobu = self.vobus[-1] if self.vobus else None
        p = off + 14 + (b[off + 13] & 7)
        if b[p] != 0 or b[p + 1] != 0 or b[p + 2] != 1:
            return False
        stream_id = b[p + 3]
        if vobu and 0xE0 <= stream_id <= 0xEF:
            vobu.has_video = True
        if vobu and 0xC0 <= stream_id <= 0xDF:
            vobu.heard(stream_id)  # MPEG audio
        if stream_id != 0xBD:
            return False
        end = min(p + 6 + ((b[p + 4] << 8) | b[p + 5]), off + SECTOR)
        pts = parse_pts(b, p + 9) if b[p + 7] & 0x80 else None
        p += 9 + b[p + 8]
        stream = b[p]
        p += 1
        if vobu and 0x80 <= stream <= 0xA7:
            vobu.heard(stream)  # AC-3, DTS, LPCM
        if stream < 0x20 or stream > 0x3F:
            return False
        cur = self.partial.get(stream)
        if cur is None:
            if end - p < 2:
                return True
            cur = {"pts": pts, "data": bytearray(), "size": (b[p] << 8) | b[p + 1], "vobu": len(self.vobus) - 1}
            self.partial[stream] = cur
        cur["data"] += memoryview(b)[p:end]
        if len(cur["data"]) < cur["size"]:
            return True
        data = bytes(cur["data"][: cur["size"]])
        self.spus.setdefault(stream, []).append({"pts": cur["pts"], "data": data, "vobu": cur["vobu"]})
        del self.partial[stream]
        return True


# ---- the tool (tools/make-derivatives.mjs) ----------------------------------


def run(cmd, args):
    try:
        res = subprocess.run([cmd, *args], stdin=subprocess.DEVNULL, capture_output=True)
    except OSError as err:
        raise RuntimeError(f"{cmd}: {err}") from err
    if res.returncode != 0:
        raise RuntimeError(f"{cmd} {' '.join(args)}\n{res.stderr.decode(errors='replace')[-4000:]}")
    return res.stdout.decode(errors="replace")


def extract_video_ts(image, tmp):
    if shutil.which("7z"):
        run("7z", ["x", "-y", f"-o{tmp}", image, "VIDEO_TS"])
    else:
        run("bsdtar", ["-xf", image, "-C", tmp, "VIDEO_TS"])
    return os.path.join(tmp, "VIDEO_TS")


class VobFile:
    __slots__ = ("name", "path", "start", "sectors")

    def __init__(self, name, path, start, sectors):
        self.name, self.path, self.start, self.sectors = name, path, start, sectors


class VobSet:
    """The files of one VOB set, read as a single run of sectors."""

    def __init__(self, directory, names):
        self.files = []
        start = 0
        for name in names:
            path = os.path.join(directory, name)
            sectors = os.path.getsize(path) // SECTOR
            self.files.append(VobFile(name, path, start, sectors))
            start += sectors
        self.sectors = start

    def scan(self, nav_path):
        """Scan the set, copying its NAV packs and subpicture packs to nav_path
        on the way: everything the player reads from the VOBs (the buttons and
        their highlights) without the video and audio. Returns the scanner and
        the copy's size."""
        scanner = VobScanner()
        buf = bytearray(CHUNK)
        view = memoryview(buf)
        nav_bytes = 0
        with open(nav_path, "wb") as nav:
            for file in self.files:
                with open(file.path, "rb") as f:
                    pos = 0
                    total = file.sectors * SECTOR
                    while pos < total:
                        f.seek(pos)
                        n = f.readinto(view[: min(CHUNK, total - pos)])
                        # whole sectors only, so a short read can't shift the ones after it
                        whole = n - n % SECTOR
                        if not whole:
                            raise RuntimeError(f"{file.name}: read stopped at byte {pos}")
                        for off in range(0, whole, SECTOR):
                            if scanner.pack(buf, off):
                                nav.write(view[off:off + SECTOR])
                                nav_bytes += SECTOR
                        pos += whole
        return scanner, nav_bytes

    def copy(self, ranges, dest):
        """Copy the sector ranges [[from, to), ...] of the set into dest, end to end."""
        handles = {}
        try:
            with open(dest, "wb") as out:
                for first, to in ranges:
                    for file in self.files:
                        a = max(first, file.start)
                        b = min(to, file.start + file.sectors)
                        if a >= b:
                            continue
                        if file.path not in handles:
                            handles[file.path] = open(file.path, "rb")
                        f = handles[file.path]
                        pos = (a - file.start) * SECTOR
                        end = (b - file.start) * SECTOR
                        f.seek(pos)
                        while pos < end:
                            data = f.read(min(CHUNK, end - pos))
                            if not data:
                                break
                            out.write(data)
                            pos += len(data)
        finally:
            for f in handles.values():
                f.close()


class Cell:
    __slots__ = ("order", "first", "last", "block")

    def __init__(self, order, first):
        self.order, self.first, self.last, self.block = order, first, first, None


class Block:
    __slots__ = ("first", "last", "cells")

    def __init__(self, first, last):
        self.first, self.last, self.cells = first, last, 0


def timeline_order(vobus, vob_set):
    """The VOBUs in timeline order: cell by cell, the cells in the order they
    start in the VOBs. That is the order on disc except in a multi-angle block,
    where the angles' cells are stored interleaved, a piece of each in turn;
    here each angle's cell is gathered together, one after another.

    Each VOBU is also given a `home`: the sector that decides which VOB file's
    mp4 it goes in. That is its own sector, except that a whole multi-angle
    block goes where the block starts."""
    cells = {}  # (vobId, cellId) -> Cell (indexes on disc)
    for i, vobu in enumerate(vobus):
        key = (vobu.vob_id, vobu.cell_id)
        if key not in cells:
            cells[key] = Cell(len(cells), i)
        vobu.cell = cells[key]
        vobu.cell.last = i
        vobu.end_sector = vobus[i + 1].sector if i + 1 < len(vobus) else vob_set.sectors
    # Cells whose stretches of the disc overlap are the angles of one block.
    block = None
    for cell in cells.values():
        if block and cell.first <= block.last:
            block.last = max(block.last, cell.last)
        else:
            block = Block(cell.first, cell.last)
        block.cells += 1
        cell.block = block
    for vobu in vobus:
        vobu.home = vobus[vobu.cell.block.first].sector if vobu.cell.block.cells > 1 else vobu.sector
    return [v for _, v in sorted(enumerate(vobus), key=lambda iv: (iv[1].cell.order, iv[0]))]


class Run:
    __slots__ = ("file", "ranges", "start_ptm", "start", "duration", "has_video", "has_audio", "audio", "cells", "mp4_start")

    def __init__(self, file, start_ptm, start):
        self.file = file
        self.ranges = []
        self.start_ptm = start_ptm
        self.start = start
        self.duration = 0.0
        self.has_video = False
        self.has_audio = False
        self.audio = []  # stream ids, in the order first heard (a JS Set)
        self.cells = []
        self.mp4_start = None


def in_mp4(r):
    return r.has_video and r.duration > 0


def find_runs(scanned, vob_set):
    """Split the VOBUs into runs with continuous timestamps. A run also ends at
    a VOB file boundary, so every run belongs to exactly one mp4. A run's
    sectors are `ranges`: one stretch of the VOB, or several for an
    interleaved cell."""

    def file_of(sector):
        for i, f in enumerate(vob_set.files):
            if f.start <= sector < f.start + f.sectors:
                return i
        return -1

    vobus = timeline_order(scanned, vob_set)
    runs = []
    time = 0.0
    for i, vobu in enumerate(vobus):
        file = file_of(vobu.home)
        prev = vobus[i - 1] if i else None
        r = runs[-1] if runs else None
        if not r or r.file != file or prev.end_ptm != vobu.start_ptm:
            r = Run(file, vobu.start_ptm, time)
            runs.append(r)
        if r.ranges and r.ranges[-1][1] == vobu.sector:
            r.ranges[-1][1] = vobu.end_sector
        else:
            r.ranges.append([vobu.sector, vobu.end_sector])
        vobu.run = r
        if not prev or prev.vob_id != vobu.vob_id or prev.cell_id != vobu.cell_id:
            r.cells.append({"vobId": vobu.vob_id, "cellId": vobu.cell_id, "sector": vobu.sector, "start": time})
        dur = max(0, vobu.end_ptm - vobu.start_ptm) / 90000
        r.duration += dur
        r.has_video = r.has_video or vobu.has_video
        r.has_audio = r.has_audio or vobu.has_audio
        for stream in vobu.audio:
            if stream not in r.audio:
                r.audio.append(stream)
        vobu.time = time
        time += dur
    # Runs with no video are left out of the mp4, so later runs start earlier
    # there than on the VOB's own timeline.
    offsets = {}
    for r in runs:
        r.mp4_start = offsets.get(r.file, 0) if in_mp4(r) else None
        if in_mp4(r):
            offsets[r.file] = r.mp4_start + r.duration
    return runs


def mp4_time(r, time):
    """Seconds into its file's mp4 of a time on the VOB set's timeline that falls
    in run r, or None if the run isn't in the mp4."""
    return None if r.mp4_start is None else r.mp4_start + (time - r.start)


def first_audio_track(vts):
    """Stream id of a title set's first audio track, or None if it has none."""
    audio = vts["attrs"]["audio"]
    for srp in vts["pgcit"]:
        control = srp["pgc"]["audioControl"]
        for n in range(8):
            if control[n] & 0x8000 and n < len(audio):
                return audio_stream_id(audio[n], control[n])
    return None


def audio_channels(vts):
    """How many channels each of a title set's audio streams has: id -> n."""
    channels = {}
    for srp in vts["pgcit"]:
        control = srp["pgc"]["audioControl"]
        for n, attr in enumerate(vts["attrs"]["audio"]):
            if control[n] & 0x8000:
                channels[audio_stream_id(attr, control[n])] = attr["channels"]
    return channels


def layout_of(channels):
    """A surround track stays surround; anything else is mixed to stereo,
    which is also what silence and menus get."""
    return "5.1" if channels == 6 else "stereo"


def bitrate_of(layout):
    return "384k" if layout == "5.1" else "160k"


def stream_spec(stream):
    """ffmpeg stream specifier for an audio stream id (MPEG audio ids are 0x1c0+)."""
    return f"#0x{(0x100 + stream if stream >= 0xC0 else stream):x}"


def hex_of(stream):
    return f"{stream:02x}"


AUDIO_TAG = re.compile(r"^dvd\.js audio=([0-9a-f]{2}|none)$")


def tagged_audio(mp4_path):
    """The audio stream an existing mp4 holds: a stream id, None for none, or
    UNSET when the mp4 doesn't say (or doesn't exist)."""
    try:
        res = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format_tags=comment", "-of", "default=nw=1:nk=1", mp4_path],
            stdin=subprocess.DEVNULL, capture_output=True,
        )
    except OSError:
        return UNSET
    tag = AUDIO_TAG.match(res.stdout.decode(errors="replace").strip() if res.returncode == 0 else "")
    if not tag:
        return UNSET
    return None if tag.group(1) == "none" else int(tag.group(1), 16)


class RunSources:
    """The sectors of each run as a file ffmpeg can read: the VOB itself when
    the run is all of it, else a copy, made once and shared by every encode."""

    def __init__(self, vob_set, file, tmp):
        self.set, self.file, self.tmp = vob_set, file, tmp
        self.copies = {}  # id(run) -> path

    def path(self, r):
        file = self.file
        first, end = r.ranges[0]
        if len(r.ranges) == 1 and first == file.start and end == file.start + file.sectors:
            return file.path
        if id(r) not in self.copies:
            copy = os.path.join(self.tmp, f"{file.name}.{len(self.copies)}.vob")
            self.set.copy(r.ranges, copy)
            self.copies[id(r)] = copy
        return self.copies[id(r)]

    def clear(self):
        for copy in self.copies.values():
            try:
                os.remove(copy)
            except FileNotFoundError:
                pass
        self.copies.clear()


INPUT = ["-analyzeduration", "100M", "-probesize", "100M", "-i"]


def audio_filter(source, spec, r, label, layout="stereo"):
    """Filter for one run's audio stream `spec` of input `source`, shifted to
    start at 0 and exactly as long as the run."""
    s = fixed(r.start_ptm / 90000, 6)
    d = fixed(r.duration, 6)
    return (
        f"[{source}:{spec}]asetpts=PTS-{s}/TB,aresample=48000:async=1:first_pts=0,"
        f"aformat=sample_fmts=fltp:channel_layouts={layout},apad=whole_dur={d},atrim=duration={d}[{label}]"
    )


def silence(r, label, layout="stereo"):
    return f"anullsrc=r=48000:cl={layout},atrim=duration={fixed(r.duration, 6)}[{label}]"


def encode(runs, sources, video, main_audio, layout, out_path):
    """main_audio: the stream id the mp4 should carry, None for none, or UNSET
    to take whatever audio there is (menus)."""
    pal = video["format"] == "PAL"
    fps = "25" if pal else "30000/1001"
    fps_value = 25 if pal else 30000 / 1001
    height = 576 if pal else 480
    dar = "16/9" if video["aspect"] == "16:9" else "4/3"

    def audible(r):
        return r.has_audio if main_audio is UNSET else main_audio is not None and main_audio in r.audio

    audio_spec = "a:0" if main_audio is UNSET or main_audio is None else stream_spec(main_audio)
    any_audio = any(in_mp4(r) and audible(r) for r in runs)
    args = ["-hide_banner", "-loglevel", "error", "-y", "-copyts"]
    filters = []
    keyframes = []
    labels = ""
    n = 0
    for r in runs:
        if not in_mp4(r):
            continue
        args += [*INPUT, sources.path(r)]
        s = fixed(r.start_ptm / 90000, 6)
        d = fixed(r.duration, 6)
        frames = js_round(r.duration * fps_value)
        filters.append(
            f"[{n}:v:0]bwdif=mode=send_frame:deint=interlaced,fps={fps}:start_time={s},setpts=PTS-{s}/TB,"
            f"scale=720:{height},setdar={dar},format=yuv420p,tpad=stop_mode=clone:stop_duration={d},trim=end_frame={frames}[v{n}]"
        )
        if any_audio:
            filters.append(audio_filter(n, audio_spec, r, f"a{n}", layout) if audible(r) else silence(r, f"a{n}", layout))
        labels += f"[v{n}][a{n}]" if any_audio else f"[v{n}]"
        keyframes += [fixed(mp4_time(r, c["start"]), 3) for c in r.cells]
        n += 1
    if not n:
        return False
    filters.append(f"{labels}concat=n={n}:v=1:a={1 if any_audio else 0}[v]{'[a]' if any_audio else ''}")
    args += ["-filter_complex", ";".join(filters), "-map", "[v]"]
    if any_audio:
        args += ["-map", "[a]", "-c:a", "aac", "-b:a", bitrate_of(layout)]
    if main_audio is not UNSET:
        args += ["-metadata", f"comment=dvd.js audio={hex_of(main_audio) if any_audio else 'none'}"]
    args += [
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", fps, "-g", "60",
        "-force_key_frames", ",".join(keyframes),
        "-movflags", "+faststart", out_path,
    ]
    run("ffmpeg", args)
    return True


def encode_audio(runs, sources, ids, layouts, out_path):
    """The audio streams `ids` of a VOB file, each as an m4a on the same
    timeline as the file's mp4, in one pass. out_path(id) names each one."""
    args = ["-hide_banner", "-loglevel", "error", "-y", "-copyts"]
    filters = []
    labels = {stream: "" for stream in ids}
    inputs = 0
    n = 0
    for r in runs:
        if not in_mp4(r):
            continue
        present = [stream for stream in ids if stream in r.audio]
        if present:
            args += [*INPUT, sources.path(r)]
        for stream in ids:
            label = f"a{hex_of(stream)}_{n}"
            if stream in present:
                filters.append(audio_filter(inputs, stream_spec(stream), r, label, layouts(stream)))
            else:
                filters.append(silence(r, label, layouts(stream)))
            labels[stream] += f"[{label}]"
        if present:
            inputs += 1
        n += 1
    if not n or not ids:
        return False
    for stream in ids:
        filters.append(f"{labels[stream]}concat=n={n}:v=0:a=1[out{hex_of(stream)}]")
    args += ["-filter_complex", ";".join(filters)]
    for stream in ids:
        args += ["-map", f"[out{hex_of(stream)}]", "-c:a", "aac", "-b:a", bitrate_of(layouts(stream)), "-movflags", "+faststart", out_path(stream)]
    run("ffmpeg", args)
    return True


def subtitle_file(scanner, file_index):
    """The subpicture units of one VOB file, timed against its mp4, or None."""
    chunks = [SUBTITLE_MAGIC]
    for stream, units in scanner.spus.items():
        for unit in units:
            vobu = scanner.vobus[unit["vobu"]] if unit["vobu"] >= 0 else None
            if vobu is None or unit["pts"] is None or vobu.run.file != file_index:
                continue
            start = mp4_time(vobu.run, vobu.time)
            if start is None:
                continue
            # PTS is 33 bits, the VOBU's start 32. (A JS remainder keeps the
            # sign of the dividend.)
            ticks = unit["pts"] - vobu.start_ptm
            ticks = int(math.copysign(abs(ticks) % 0x100000000, ticks))
            if ticks < -0x80000000:
                ticks += 0x100000000
            if ticks > 0x80000000:
                ticks -= 0x100000000
            chunks.append(struct.pack(">BIH", stream, max(0, js_round((start + ticks / 90000) * 1000)), len(unit["data"])))
            chunks.append(unit["data"])
    return b"".join(chunks) if len(chunks) > 1 else None


def main(argv):
    flags = [a for a in argv if a.startswith("--")]
    extras_only = "--extras-only" in flags
    positional = [a for a in argv if not a.startswith("--")]
    if len(positional) < 2:
        print("usage: make_derivatives.py [--extras-only] <disc image | VIDEO_TS dir> <out dir>", file=sys.stderr)
        return 2
    source, out_arg = positional[0], positional[1]
    if not os.path.exists(source):
        print(f"{source}: no such file or directory", file=sys.stderr)
        return 1
    out = os.path.abspath(out_arg)
    os.makedirs(out, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="dvdjs-")
    log = sys.stderr.write
    try:
        directory = os.path.abspath(source) if os.path.isdir(source) else extract_video_ts(os.path.abspath(source), tmp)
        names = [n.upper() for n in os.listdir(directory)]

        def read(name):
            with open(os.path.join(directory, name), "rb") as f:
                return f.read()

        vmg = parse_vmg(read("VIDEO_TS.IFO"))
        sets = []
        if "VIDEO_TS.VOB" in names:
            sets.append({"names": ["VIDEO_TS.VOB"], "video": vmg["menuAttrs"]["video"]})
        for v in range(1, vmg["nrTitleSets"] + 1):
            vid = f"{v:02d}"
            vts = parse_vts(read(f"VTS_{vid}_0.IFO"))
            if f"VTS_{vid}_0.VOB" in names:
                sets.append({"names": [f"VTS_{vid}_0.VOB"], "video": vts["menuAttrs"]["video"]})
            titles = sorted(n for n in names if re.fullmatch(rf"VTS_{vid}_[1-9]\.VOB", n))
            if titles:
                sets.append({
                    "names": titles, "video": vts["attrs"]["video"], "title": True,
                    "firstAudio": first_audio_track(vts), "channels": audio_channels(vts),
                })
        report = []
        manifest = {}
        for entry in sets:
            vob_names, video, title = entry["names"], entry["video"], entry.get("title", False)
            first_audio, channels = entry.get("firstAudio"), entry.get("channels")

            def layouts(stream, channels=channels):
                return layout_of(channels.get(stream) if channels is not None else 2)

            vob_set = VobSet(directory, vob_names)
            nav = re.sub(r"\.VOB$", ".nav.bin", vob_set.files[0].name)
            scanner, nav_bytes = vob_set.scan(os.path.join(tmp, nav))
            runs = find_runs(scanner.vobus, vob_set)
            # Menus always get a nav file; titles only if they put buttons over the video.
            if any(in_mp4(r) for r in runs) and (not title or any(v.hli_status and v.btn_ns for v in scanner.vobus)):
                shutil.copyfile(os.path.join(tmp, nav), os.path.join(out, nav))
                log(f"{' '.join(vob_names)}: buttons -> {nav} ({nav_bytes} bytes)\n")
            os.remove(os.path.join(tmp, nav))
            for i, file in enumerate(vob_set.files):
                mine = [r for r in runs if r.file == i]
                name = re.sub(r"\.VOB$", ".mp4", file.name)
                base = re.sub(r"\.mp4$", "", name)
                duration = sum(r.duration for r in mine if in_mp4(r))
                log(f"{file.name}: {len(mine)} run(s), {fixed(duration, 3)}s -> {name}\n")
                if not any(in_mp4(r) for r in mine):
                    log("  no video, skipped\n")
                    continue
                sources = RunSources(vob_set, file, tmp)
                try:
                    # What the mp4 holds: the title set's first track, when this VOB has it.
                    if not title:
                        main_audio = UNSET
                    elif first_audio is not None and any(in_mp4(r) and first_audio in r.audio for r in mine):
                        main_audio = first_audio
                    else:
                        main_audio = None
                    if extras_only:
                        main_audio = tagged_audio(os.path.join(out, name)) if title else UNSET
                    else:
                        encode(mine, sources, video, main_audio, layouts(None if main_audio is UNSET else main_audio), os.path.join(out, name))
                        report.append({
                            "vob": file.name,
                            "mp4": name,
                            "duration": float(fixed(duration, 6)),
                            "cells": [
                                {"vobId": c["vobId"], "cellId": c["cellId"], "sector": c["sector"], "start": float(fixed(mp4_time(r, c["start"]), 6))}
                                for r in mine if in_mp4(r) for c in r.cells
                            ],
                        })
                    if not title:
                        continue
                    # main: null says the mp4's own audio isn't any of the tracks.
                    extras = {"main": None if main_audio is UNSET or main_audio is None else hex_of(main_audio), "audio": [], "subs": False}
                    heard = sorted({s for r in mine if in_mp4(r) for s in r.audio})
                    ids = [s for s in heard if s != main_audio]
                    if ids:
                        log(f"  audio streams {', '.join(f'0x{hex_of(s)}' for s in ids)} -> {base}.audio-*.m4a\n")
                        encode_audio(mine, sources, ids, layouts, lambda s: os.path.join(out, f"{base}.audio-{hex_of(s)}.m4a"))
                        extras["audio"] = [hex_of(s) for s in ids]
                    subs = subtitle_file(scanner, i)
                    if subs:
                        log(f"  subtitles -> {base}.spu.bin ({len(subs)} bytes)\n")
                        with open(os.path.join(out, f"{base}.spu.bin"), "wb") as f:
                            f.write(subs)
                        extras["subs"] = True
                    manifest[base] = extras
                finally:
                    sources.clear()
        with open(os.path.join(out, "extras.json"), "w") as f:
            f.write(js_json(manifest) + "\n")
        if not extras_only:
            print(js_json(report))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
