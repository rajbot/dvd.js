"""Tests for tools/make_derivatives.py:  python3 -m unittest discover -s test"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import make_derivatives as md  # noqa: E402

SECTOR = md.SECTOR
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def nav_pack(start_ptm, end_ptm, vob_id, cell_id, buttons=0):
    """A NAV pack, as in test/nav.test.js."""
    b = bytearray(SECTOR)
    b[0:4] = b"\x00\x00\x01\xba"
    b[14:18] = b"\x00\x00\x01\xbb"
    b[0x26:0x2A] = b"\x00\x00\x01\xbf"
    b[0x400:0x404] = b"\x00\x00\x01\xbf"
    b[0x406] = 1
    pci = 0x2D
    struct.pack_into(">II", b, pci + 12, start_ptm, end_ptm)
    hl = pci + 96
    struct.pack_into(">H", b, hl, 1 if buttons else 0)
    b[hl + 17] = buttons
    dsi = 0x407
    struct.pack_into(">H", b, dsi + 24, vob_id)
    b[dsi + 27] = cell_id
    return bytes(b)


def pes_pack(stream_id, payload, substream=None, pts=None):
    """A PES pack of stream_id; private stream 1 gets a substream byte."""
    b = bytearray(SECTOR)
    b[0:4] = b"\x00\x00\x01\xba"
    header = b""
    flags = 0x00
    if pts is not None:
        flags = 0x80
        header = bytes([
            0x21 | ((pts >> 29) & 0x0E),
            (pts >> 22) & 0xFF, ((pts >> 14) & 0xFE) | 1,
            (pts >> 7) & 0xFF, ((pts << 1) & 0xFE) | 1,
        ])
    body = bytes([substream]) + payload if substream is not None else payload
    length = 3 + len(header) + len(body)
    pes = bytes([0, 0, 1, stream_id, length >> 8, length & 0xFF, 0x81, flags, len(header)]) + header + body
    b[14:14 + len(pes)] = pes
    return bytes(b)


def write_vobs(directory, files):
    names = []
    for name, packs in files:
        with open(os.path.join(directory, name), "wb") as f:
            f.write(b"".join(packs))
        names.append(name)
    return md.VobSet(directory, names)


SPU = bytes([0, 8, 0, 4, 0, 0, 0, 4])  # an 8-byte subpicture unit (size 8)


class ParsingTest(unittest.TestCase):
    def test_pts_round_trip(self):
        for pts in (0, 90000, 0x1FFFFFFFF, 123456789):
            pack = pes_pack(0xBD, SPU, 0x20, pts)
            p = 14
            self.assertEqual(md.parse_pts(pack, p + 9), pts)

    def test_pack_kinds(self):
        self.assertTrue(md.is_nav_pack(nav_pack(0, 1, 1, 1)))
        self.assertFalse(md.is_nav_pack(pes_pack(0xE0, b"\x00")))
        self.assertTrue(md.is_subpicture_pack(pes_pack(0xBD, SPU, 0x21)))
        self.assertFalse(md.is_subpicture_pack(pes_pack(0xBD, b"\x0b\x77", 0x80)))

    def test_stream_ids(self):
        self.assertEqual(md.audio_stream_id({"format": "ac3"}, 0x8100), 0x81)
        self.assertEqual(md.audio_stream_id({"format": "lpcm"}, 0x8000), 0xA0)
        self.assertEqual(md.stream_spec(0x81), "#0x81")
        self.assertEqual(md.stream_spec(0xC0), "#0x1c0")
        self.assertEqual(md.layout_of(6), "5.1")
        self.assertEqual(md.layout_of(2), "stereo")
        self.assertEqual(md.layout_of(None), "stereo")

    def test_js_number_formatting(self):
        self.assertEqual(md.js_round(2.5), 3)
        self.assertEqual(md.js_round(-2.5), -2)
        # toFixed rounds exact halves up; Python's format() rounds them to even
        self.assertEqual(md.fixed(1.0625, 3), "1.063")
        self.assertEqual(md.fixed(0.0078125, 6), "0.007813")
        self.assertEqual(md.fixed(-0.0, 3), "0.000")
        self.assertEqual([md.js_number(x) for x in (3.0, 0.5005, 0.00005, 5e-7, 1e21)], ["3", "0.5005", "0.00005", "5e-7", "1e+21"])
        self.assertEqual(md.js_json({"a": [1.0, {}], "b": [], "c": None}), '{\n "a": [\n  1,\n  {}\n ],\n "b": [],\n "c": null\n}')


class ScanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_scan_finds_vobus_audio_subtitles_and_writes_the_nav_file(self):
        packs = [
            nav_pack(0, 45000, 1, 1, buttons=2),
            pes_pack(0xE0, b"\x00"),
            pes_pack(0xBD, b"\x0b\x77", 0x81),
            pes_pack(0xBD, SPU, 0x20, pts=10000),
            nav_pack(45000, 90000, 1, 2),
            pes_pack(0xC0, b"\x00"),
        ]
        vob_set = write_vobs(self.dir, [("VTS_01_1.VOB", packs)])
        nav_path = os.path.join(self.dir, "nav.bin")
        scanner, nav_bytes = vob_set.scan(nav_path)
        self.assertEqual([v.sector for v in scanner.vobus], [0, 4])
        self.assertEqual(scanner.vobus[0].audio, [0x81])
        self.assertTrue(scanner.vobus[0].has_video)
        self.assertEqual(scanner.vobus[1].audio, [0xC0])
        self.assertEqual(scanner.vobus[0].btn_ns, 2)
        self.assertEqual(list(scanner.spus), [0x20])
        self.assertEqual(scanner.spus[0x20][0]["pts"], 10000)
        self.assertEqual(scanner.spus[0x20][0]["data"], SPU)
        # the two NAV packs and the subpicture pack
        self.assertEqual(nav_bytes, 3 * SECTOR)
        with open(nav_path, "rb") as f:
            self.assertEqual(f.read(), packs[0] + packs[3] + packs[4])

    def test_runs_split_at_a_clock_reset_and_skip_stretches_with_no_video(self):
        packs = [
            nav_pack(0, 45000, 1, 1), pes_pack(0xE0, b"\x00"),
            nav_pack(45000, 90000, 1, 1), pes_pack(0xE0, b"\x00"),
            nav_pack(0, 9000, 2, 1),  # the clock restarts; no video in this VOBU
            nav_pack(500, 45500, 3, 1), pes_pack(0xE0, b"\x00"),
        ]
        vob_set = write_vobs(self.dir, [("VTS_01_1.VOB", packs)])
        scanner, _ = vob_set.scan(os.path.join(self.dir, "nav.bin"))
        runs = md.find_runs(scanner.vobus, vob_set)
        self.assertEqual([round(r.duration, 3) for r in runs], [1.0, 0.1, 0.5])
        self.assertEqual([md.in_mp4(r) for r in runs], [True, False, True])
        # the third run follows the first in the mp4, the second being left out
        self.assertEqual(runs[2].start, 1.1)
        self.assertEqual(runs[2].mp4_start, 1.0)
        self.assertEqual(runs[0].ranges, [[0, 4]])

    def test_an_angle_block_is_gathered_per_angle_and_kept_in_the_file_it_starts_in(self):
        a, b = 1, 2  # two angles, interleaved: a1 b1 | a2 b2 across a file boundary
        first = [nav_pack(0, 45000, a, 1), pes_pack(0xE0, b"\x00"), nav_pack(0, 45000, b, 1), pes_pack(0xE0, b"\x00")]
        second = [nav_pack(45000, 90000, a, 1), pes_pack(0xE0, b"\x00"), nav_pack(45000, 90000, b, 1), pes_pack(0xE0, b"\x00")]
        vob_set = write_vobs(self.dir, [("VTS_01_1.VOB", first), ("VTS_01_2.VOB", second)])
        scanner, _ = vob_set.scan(os.path.join(self.dir, "nav.bin"))
        runs = md.find_runs(scanner.vobus, vob_set)
        # angle a's two pieces, then angle b's: both in the first file's mp4
        self.assertEqual([r.file for r in runs], [0, 0])
        self.assertEqual([c["vobId"] for r in runs for c in r.cells], [a, b])
        self.assertEqual(runs[0].ranges, [[0, 2], [4, 6]])
        self.assertEqual(runs[1].ranges, [[2, 4], [6, 8]])

    def test_subtitle_times_follow_the_mp4(self):
        packs = [
            nav_pack(90000, 135000, 1, 1), pes_pack(0xE0, b"\x00"),
            pes_pack(0xBD, SPU, 0x20, pts=90000 + 9000),  # 0.1 s into the VOBU
        ]
        vob_set = write_vobs(self.dir, [("VTS_01_1.VOB", packs)])
        scanner, _ = vob_set.scan(os.path.join(self.dir, "nav.bin"))
        md.find_runs(scanner.vobus, vob_set)
        data = md.subtitle_file(scanner, 0)
        self.assertEqual(data[:8], md.SUBTITLE_MAGIC)
        stream, ms, length = struct.unpack_from(">BIH", data, 8)
        self.assertEqual((stream, ms, length), (0x20, 100, len(SPU)))
        self.assertEqual(data[15:], SPU)
        self.assertIsNone(md.subtitle_file(scanner, 1))


# Stands in for ffmpeg: logs its arguments, with the tool's temporary copies
# replaced by their contents' hash and paths in the out dir made relative, and
# creates its outputs empty.
FAKE_FFMPEG = """#!/usr/bin/env python3
import hashlib, json, os, sys
args, out = sys.argv[1:], os.environ["FAKEFF_OUT"]
def show(i, a):
    if i and args[i - 1] == "-i" and "/dvdjs-" in a:
        with open(a, "rb") as f:
            return "<copy %s %s>" % (os.path.basename(a), hashlib.md5(f.read()).hexdigest())
    return a.replace(out, "<out>")
with open(os.environ["FAKEFF_LOG"], "a") as f:
    f.write(json.dumps([show(i, a) for i, a in enumerate(args)]) + "\\n")
for i, a in enumerate(args):
    if i and args[i - 1] == "+faststart":
        open(a, "w").close()
"""


def ifo(magic, size=3 * SECTOR):
    b = bytearray(size)
    b[0:12] = magic
    return b


def write_disc(directory):
    """A small disc: a menu with buttons and a title set in two files, with two
    AC-3 tracks (5.1 and stereo), subtitles, a cell starting at 1.0625 s and a
    two-angle block that crosses into the second file."""
    os.makedirs(directory)
    vmg = ifo(b"DVDVIDEO-VMG")
    struct.pack_into(">H", vmg, 0x3E, 1)
    vts = ifo(b"DVDVIDEO-VTS")
    vts[0x203] = 2
    vts[0x205] = 5  # track 1: AC-3, 6 channels; track 2: AC-3, 2 channels
    vts[0x20D] = 1
    struct.pack_into(">I", vts, 0xCC, 1)  # the PGCIT, in sector 1
    pgcit = SECTOR
    struct.pack_into(">HxxI", vts, pgcit, 1, 0x200)
    struct.pack_into(">BxxxI", vts, pgcit + 8, 0x81, 16)
    struct.pack_into(">HH", vts, pgcit + 16 + 0x0C, 0x8000, 0x8100)
    files = {
        "VIDEO_TS.IFO": vmg,
        "VTS_01_0.IFO": vts,
        "VIDEO_TS.VOB": [nav_pack(0, 45000, 1, 1, buttons=2), pes_pack(0xE0, b"\x00"), pes_pack(0xBD, SPU, 0x20, pts=0)],
        "VTS_01_1.VOB": [
            nav_pack(0, 95625, 1, 1), pes_pack(0xE0, b"\x00"), pes_pack(0xBD, b"\x0b\x77", 0x80), pes_pack(0xBD, b"\x0b\x77", 0x81),
            nav_pack(95625, 140625, 1, 2), pes_pack(0xE0, b"\x00"), pes_pack(0xBD, b"\x0b\x77", 0x80),
            pes_pack(0xBD, SPU, 0x20, pts=100000),
            nav_pack(0, 45000, 2, 1), pes_pack(0xE0, b"\x00"), pes_pack(0xBD, b"\x0b\x77", 0x80),
            nav_pack(0, 45000, 3, 1), pes_pack(0xE0, b"\x00"), pes_pack(0xBD, b"\x0b\x77", 0x80),
        ],
        "VTS_01_2.VOB": [
            nav_pack(45000, 90000, 2, 1), pes_pack(0xE0, b"\x00"), pes_pack(0xBD, b"\x0b\x77", 0x80),
            nav_pack(45000, 90000, 3, 1), pes_pack(0xE0, b"\x00"), pes_pack(0xBD, b"\x0b\x77", 0x80),
            nav_pack(9000, 54000, 4, 1), pes_pack(0xC0, b"\x00"),
            nav_pack(54000, 99000, 4, 1), pes_pack(0xE0, b"\x00"), pes_pack(0xBD, b"\x0b\x77", 0x81),
        ],
    }
    for name, data in files.items():
        with open(os.path.join(directory, name), "wb") as f:
            f.write(data if isinstance(data, (bytes, bytearray)) else b"".join(data))


@unittest.skipUnless(shutil.which("node"), "needs node")
class ParityTest(unittest.TestCase):
    """The Python tool does exactly what tools/make-derivatives.mjs does."""

    def test_same_ffmpeg_commands_report_and_files_as_the_node_tool(self):
        with tempfile.TemporaryDirectory() as tmp:
            disc = os.path.join(tmp, "VIDEO_TS")
            write_disc(disc)
            bin_dir = os.path.join(tmp, "bin")
            os.makedirs(bin_dir)
            fake = os.path.join(bin_dir, "ffmpeg")
            with open(fake, "w") as f:
                f.write(FAKE_FFMPEG)
            os.chmod(fake, 0o755)
            results = {}
            for impl, cmd in (("js", ["node", os.path.join(ROOT, "tools", "make-derivatives.mjs")]),
                              ("py", [sys.executable, os.path.join(ROOT, "tools", "make_derivatives.py")])):
                out = os.path.join(tmp, impl)
                log = os.path.join(tmp, f"{impl}.log")
                env = dict(os.environ, PATH=bin_dir + os.pathsep + os.environ["PATH"], FAKEFF_LOG=log, FAKEFF_OUT=out)
                res = subprocess.run([*cmd, disc, out], capture_output=True, env=env)
                self.assertEqual(res.returncode, 0, res.stderr.decode())
                with open(log) as f:
                    calls = [json.loads(line) for line in f]
                outputs = {}
                for name in sorted(os.listdir(out)):
                    with open(os.path.join(out, name), "rb") as f:
                        outputs[name] = f.read()
                results[impl] = {"stdout": res.stdout.decode(), "stderr": res.stderr.decode().replace(out, "<out>"), "ffmpeg": calls, "files": outputs}
            js, py = results["js"], results["py"]
            # the disc exercises what it is meant to
            self.assertIn("1.063", json.dumps(js["ffmpeg"]))
            self.assertIn("VTS_01_1.audio-81.m4a", js["files"])
            self.assertIn("VTS_01_1.spu.bin", js["files"])
            self.assertIn("VIDEO_TS.nav.bin", js["files"])
            for key in ("stdout", "stderr", "ffmpeg", "files"):
                self.assertEqual(py[key], js[key], key)


if __name__ == "__main__":
    unittest.main()
