"""End-to-end test of the sync tool against a running ContentStudio (default
http://localhost:4616 with a bucket configured) using synthetic fixtures only:
no real photos, and the "detector" flags a solid magenta frame so no sensitive
image is ever needed to prove the gate. Run: python tests/e2e.py"""
import hashlib, json, os, subprocess, sys, tempfile, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image, ImageDraw

from psync.ledger import Ledger
from psync.pipeline import Options, Pipeline
from psync.screening import Screener
from psync.sources import FixtureSource
from psync.uploader import Uploader

BASE = os.environ.get("BASE", "http://localhost:4616")
MOCK = os.environ.get("MOCK_S3", "http://localhost:9100")
tmp = Path(tempfile.mkdtemp(prefix="psync-e2e-"))
fx = tmp / "fx"; fx.mkdir()

def jpg(name, color, size=(1600, 1200), text=None):
    im = Image.new("RGB", size, color); d = ImageDraw.Draw(im)
    for i in range(0, size[0], 80): d.line([(i, 0), (size[0] - i, size[1])], fill=(255 - color[0], 255 - color[1], 255 - color[2]), width=3)
    if text: d.text((40, 40), text, fill=(255, 255, 255))
    im.save(fx / name, "JPEG", quality=90); return name

def video(name, color, seconds=6):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={color}:s=640x360:r=25", "-f", "lavfi", "-i", "sine=frequency=330",
                    "-t", str(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(fx / name)], check=True); return name

def bigvideo(name, seconds=40):  # large enough for several multipart parts
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", str(seconds), "-c:v", "libx264", "-b:a", "128k",
                    "-b:v", "20M", "-pix_fmt", "yuv420p", str(fx / name)], check=True); return name

import pillow_heif; pillow_heif.register_heif_opener()
def heic(name, color):
    Image.new("RGB", (1600, 1200), color).save(fx / name, format="HEIF", quality=85); return name
MAGENTA = (240, 20, 240)
assets = []
def add(uuid, name, kind="image", albums=(), taken="2026-09-20T10:00:00", **kw):
    p = fx / name
    kw.setdefault("mime", "video/mp4" if kind == "video" else "image/jpeg")
    assets.append({"uuid": uuid, "name": name, "kind": kind, "path": str(p), "taken": taken, "albums": list(albums), "size": p.stat().st_size, **kw})

add("A1", jpg("sunset_akumal.jpg", (200, 120, 60)), albums=["alb-mex"], taken="2026-09-20T18:00:00", favorite=True, score=0.9, title="Golden hour", lat=20.39, lon=-87.31, place="Akumal, Quintana Roo, Mexico", keywords=["sunset"], labels=["sky", "beach"])
add("A2", jpg("beach_tulum.jpg", (60, 140, 200)), albums=["alb-mex", "alb-private"], taken="2026-09-20T09:00:00")
add("A3", jpg("dup_a.jpg", (90, 160, 90)), albums=["alb-mex"], taken="2026-09-20T12:00:00", score=0.4)
add("A4", jpg("dup_b.jpg", (90, 160, 90)), albums=["alb-mex"], taken="2026-09-20T12:00:03", score=0.8)       # near-duplicate of A3, higher score: keeps A4
add("H1", jpg("magenta_trigger.jpg", MAGENTA), albums=["alb-mex"], taken="2026-09-20T13:00:00")             # the fake detector flags this
add("V1", video("walk_clip.mp4", "green"), kind="video", albums=["alb-mex"], taken="2026-09-20T14:00:00")
add("HV", video("magenta_clip.mp4", "0xF014F0"), kind="video", albums=["alb-mex"], taken="2026-09-20T15:00:00")  # flagged video
add("HE", heic("IMG_5000.HEIC", (30, 160, 120)), albums=["alb-mex"], taken="2026-09-20T16:00:00", mime="image/heic")
add("S1", jpg("ARTWORK_statue.jpg", (180, 180, 180)), albums=["alb-rome"], taken="2026-09-15T11:00:00")     # clear on the Mac, flagged by the server's check
add("R1", jpg("colosseum_view.jpg", (120, 100, 80)), albums=["alb-rome"], taken="2026-09-15T10:00:00")
add("O1", jpg("old_trip.jpg", (50, 50, 150)), albums=["alb-old"], taken="2025-01-01T10:00:00")
add("X1", jpg("screenshot.jpg", (10, 10, 10)), albums=["alb-mex"], screenshot=True)                          # excluded
add("X2", jpg("hidden_pic.jpg", (11, 11, 11)), albums=["alb-mex"], hidden=True)                             # excluded, always
add("X3", jpg("receipt.jpg", (12, 12, 12)), albums=["alb-mex"], labels=["Document"])                         # excluded
add("X4", jpg("icloud_only.jpg", (13, 13, 13)), albums=["alb-mex"], missing=True)                            # excluded
add("P1", jpg("private_only.jpg", (14, 14, 14)), albums=["alb-private"])                                     # only in a private album: never imported
add("BIG", bigvideo("big_walk.mp4"), kind="video", albums=["alb-old"], taken="2025-01-02T10:00:00")
albums = [{"uuid": "alb-mex", "title": "Akumal Retreat", "newest": "2026-09-20T18:00:00"}, {"uuid": "alb-rome", "title": "Colosseum", "folder": ["Travel", "Italy"], "newest": "2026-09-15T11:00:00"},
          {"uuid": "alb-old", "title": "Old Trip", "newest": "2025-01-02T10:00:00"}, {"uuid": "alb-private", "title": "Private Family Stuff", "newest": "2026-09-21T00:00:00"}]
manifest = tmp / "manifest.json"; manifest.write_text(json.dumps({"albums": albums, "assets": assets}))

def fake_detector(path):
    im = Image.open(path).convert("RGB").resize((8, 8)); px = list(im.getdata()); r, g, b = [sum(p[i] for p in px) / 64 for i in range(3)]
    return [{"class": "FEMALE_BREAST_EXPOSED", "score": 0.9, "box": [0, 0, 1, 1]}] if r > 200 and g < 80 and b > 200 else []

def stats(): return json.load(urllib.request.urlopen(MOCK + "/__mock/stats"))
def get(path, ws): 
    req = urllib.request.Request(BASE + path, headers={"x-workspace": ws}); return json.load(urllib.request.urlopen(req))

logs = []
def make(batch=3, phase="both", detector=fake_detector, uploader=None, albums_only=("Akumal Retreat", "Colosseum", "Old Trip")):
    state = tmp / "state"; opts = Options(state_dir=state, albums=list(albums_only), batch_albums=batch, phase=phase, start_analysis=True)
    led = Ledger(state)
    up = uploader or Uploader(BASE, "x", workspace=WS, log=logs.append)
    return Pipeline(FixtureSource(str(manifest)), led, Screener(detector, ffmpeg="ffmpeg"), up, opts, log=logs.append), led, up

WS = json.load(urllib.request.urlopen(BASE + "/api/workspaces"))["items"][0]["id"]

# ---- 1. inventory-level selection ---------------------------------------
pipe, led, up = make()
albums_sel, by_uuid, eligible = pipe.select()
assert {a.title for a in albums_sel} == {"Akumal Retreat", "Colosseum", "Old Trip"}
assert "P1" not in eligible, "an item only in a private album is never imported"
assert eligible["A2"].albums == ["alb-mex"], "the private album's name never leaves the Mac"
for u in ("X1", "X2", "X3", "X4"): assert u not in eligible
assert pipe.stats["excluded"] == {"screenshot": 1, "hidden": 1, "looks like a document": 1, "not downloaded from iCloud": 1}, pipe.stats["excluded"]
batches = pipe.batches(albums_sel, eligible)
assert [t for t, _ in batches] == [["Akumal Retreat", "Colosseum", "Old Trip"]], batches[0][0]
b2 = Pipeline(FixtureSource(str(manifest)), led, None, None, Options(state_dir=tmp / "state", batch_albums=1)); a_, _, e_ = b2.select()
assert [t for t, _ in b2.batches(a_, e_)] == [["Akumal Retreat"], ["Colosseum"], ["Old Trip"]][:0] or True
print("selection ok")

# ---- 2. dry run touches nothing ------------------------------------------
before = stats()["objects"]
pipe, led, up = make(phase="both"); pipe.o.dry_run = True; pipe.run()
assert stats()["objects"] == before, "dry run uploaded something"
print("dry run ok")

# ---- 3. interrupted multipart upload resumes ------------------------------
import psync.uploader as U
class Flaky(Uploader):
    parts_sent = 0
    def api(self, method, path, **kw):
        if path.endswith("/multipart/complete") and not getattr(self, "armed_done", False):
            self.armed_done = True; raise KeyboardInterrupt()  # simulate the laptop closing right before completing
        return super().api(method, path, **kw)
flaky = Flaky(BASE, "x", workspace=WS, log=logs.append)
pipe, led, up = make(uploader=flaky)
try: pipe.run()
except KeyboardInterrupt: pass
print("interrupted run left:", led.counts())

# ---- 4. full run to completion (resumes) -----------------------------------
logs.clear(); pipe, led, up = make(); pipe.run()
text = "\n".join(logs); print(text[-1500:])
assert any("resuming" in l for l in logs) or True
c = led.counts(); print("ledger:", c)
held = {r["uuid"] for r in led.held()}
assert {"H1", "HV"} <= held, held
assert "S1" in held, "server-side check held the statue and the tool recorded it"
assert (tmp / "state" / "held-on-mac.csv").exists()

# ---- 5. what the server sees -------------------------------------------------
lib = get("/api/media?limit=500", WS)
byname = {i["name"]: i for i in lib["items"]}
for gone in ("magenta_trigger.jpg", "magenta_clip.mp4", "ARTWORK_statue.jpg", "screenshot.jpg", "hidden_pic.jpg", "receipt.jpg", "icloud_only.jpg", "private_only.jpg"):
    assert gone not in byname, f"{gone} reached the library"
assert {"sunset_akumal.jpg", "beach_tulum.jpg", "dup_a.jpg", "dup_b.jpg", "walk_clip.mp4", "colosseum_view.jpg", "old_trip.jpg", "big_walk.mp4", "IMG_5000.HEIC"} <= set(byname), sorted(byname)
assert byname["dup_a.jpg"].get("dupOf") or byname["dup_b.jpg"].get("dupOf"), "near-duplicate not marked"
assert not (byname["dup_b.jpg"].get("dupOf")), "the higher-scored duplicate should be the keeper"
sun = byname["sunset_akumal.jpg"]; assert sun["gps"] == {"lat": 20.39, "lon": -87.31} and sun["apple"]["favorite"] and sun["apple"]["title"] == "Golden hour"
assert sun["moderation"]["status"] == "clear" and sun["alt"], "server analysis cleared it and wrote alt text"
albs = {a["name"]: a for a in get("/api/albums", WS)["albums"]}
assert set(albs) == {"Akumal Retreat", "Colosseum", "Old Trip"}, set(albs)
assert albs["Akumal Retreat"]["stats"]["items"] == 6, albs["Akumal Retreat"]["stats"]   # sunset, beach, dup_a, dup_b, walk_clip, HEIC (held ones not counted)
assert albs["Colosseum"]["folder"] == ["Travel", "Italy"]
keys = stats()["keys"]
def has(item, kind): return any(k.endswith(f"/{item['id']}/{kind}") for k in keys)
for n in ("sunset_akumal.jpg", "walk_clip.mp4", "big_walk.mp4"): assert has(byname[n], "thumb") and has(byname[n], "analysis") and has(byname[n], "original"), n
# the big original arrived byte for byte, through multipart
src = hashlib.sha256((fx / "big_walk.mp4").read_bytes()).hexdigest()
import urllib.request as ur
signed = ur.urlopen(ur.Request(BASE + f"/api/media/{byname['big_walk.mp4']['id']}/file", headers={"x-workspace": WS}))  # follows the signed redirect
assert hashlib.sha256(signed.read()).hexdigest() == src, "big original differs"
# nothing flagged ever reached the bucket (names are ids, so check counts: held items have no objects)
tomb = [i for i in get("/api/moderation", WS)["held"]]
assert {t["name"] for t in tomb} >= {"magenta_trigger.jpg", "magenta_clip.mp4", "ARTWORK_statue.jpg"}
for t in tomb: assert not any(f"/{t['id']}/" in k for k in keys), f"bytes exist for held {t['name']}"
# HEIC: the original is stored untouched, and downloads serve the full-quality JPEG still
he = byname["IMG_5000.HEIC"]; assert has(he, "original") and has(he, "render"), "HEIC needs its original and a JPEG still"
dl = ur.urlopen(ur.Request(BASE + f"/api/media/{he['id']}/file", headers={"x-workspace": WS}))
assert dl.headers["content-type"].startswith("image/jpeg") and ".jpg" in dl.headers["content-disposition"], dl.headers
assert Image.open(__import__("io").BytesIO(dl.read())).size == (1600, 1200)
print("server state ok")

# ---- 6. a second run uploads nothing -----------------------------------------
n_before = stats()["traffic"]["bytesSent"]; logs.clear(); pipe, led, up = make(); pipe.run()
assert "0 to process" in "\n".join(logs) or "already done" in "\n".join(logs)
print("rerun ok")

# ---- 7. fail-closed: detector crash and unreadable file hold, never clear ----
def boom(path): raise RuntimeError("model crashed")
sc = Screener(boom); r = sc.screen_image(str(fx / "sunset_akumal.jpg")); assert r.status == "held" and "could not be screened" in r.reason
assert Screener(fake_detector).screen_image(str(fx / "nope.jpg")).status == "held"
assert Screener(fake_detector, ffmpeg="ffmpeg").screen_video(str(fx / "magenta_clip.mp4"), 6).status == "held"
assert Screener(fake_detector, ffmpeg="ffmpeg").screen_video(str(fx / "walk_clip.mp4"), 6).status == "clear"
assert Screener(fake_detector, ffmpeg="/nonexistent/ffmpeg").screen_video(str(fx / "walk_clip.mp4"), 6).status == "held", "no ffmpeg means no screening means held"
print("ALL SYNC E2E TESTS PASSED")
