"""Small working copies made on this Mac, so the server never has to decode a
48-megapixel HEIC or a 4K HEVC clip just to describe it:
  thumb     480px card image
  analysis  1024px photo, or a 3x2 contact sheet of six frames for a video
  render    3840px JPEG for HEIC/RAW originals (ffmpeg cannot read those)
  preview   720p streaming copy of a video (optional, later)
HDR video is converted to standard color first, or its frames come out flat.
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

HLG = "zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:t=bt709:m=bt709:p=bt709:r=tv,format=yuv420p"
PQ = ("zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
      "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p")
WEB_SAFE = {"image/jpeg", "image/png"}
BIG_ORIGINAL = 40 * 1024 * 1024


@dataclass
class Derived:
    files: dict = field(default_factory=dict)  # kind -> path
    w: Optional[int] = None
    h: Optional[int] = None
    dhash: Optional[int] = None
    video_meta: Optional[dict] = None


def _open(path: str):
    from PIL import Image, ImageCms, ImageOps

    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except Exception:
        pass
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    icc = im.info.get("icc_profile")
    if icc:
        try:
            import io
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            im = ImageCms.profileToProfile(im.convert("RGB"), src, ImageCms.createProfile("sRGB"), outputMode="RGB")
        except Exception:
            pass
    return im.convert("RGB")


def dhash(im, size: int = 8) -> int:
    g = im.convert("L").resize((size + 1, size))
    px = list(g.getdata())
    bits = 0
    for y in range(size):
        for x in range(size):
            bits = (bits << 1) | (1 if px[y * (size + 1) + x] > px[y * (size + 1) + x + 1] else 0)
    return bits


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def _save(im, out: Path, long_side: int, quality: int):
    c = im.copy()
    c.thumbnail((long_side, long_side))
    c.save(out, "JPEG", quality=quality, optimize=True)


def derive_image(asset, work: Path) -> Derived:
    work.mkdir(parents=True, exist_ok=True)
    im = _open(asset.path)
    d = Derived(w=im.width, h=im.height)
    d.files["thumb"] = work / f"{asset.uuid}.thumb.jpg"
    d.files["analysis"] = work / f"{asset.uuid}.analysis.jpg"
    _save(im, d.files["thumb"], 480, 82)
    _save(im, d.files["analysis"], 1024, 80)
    d.dhash = dhash(im)
    # Originals the server cannot decode (HEIC, RAW) or very large ones get a
    # full-quality JPEG still for renders and downloads.
    if asset.mime not in WEB_SAFE or asset.size > BIG_ORIGINAL:
        d.files["render"] = work / f"{asset.uuid}.render.jpg"
        _save(im, d.files["render"], 3840, 90)
    return d


def _run(cmd, timeout=300):
    return subprocess.run(cmd, check=True, capture_output=True, timeout=timeout)


def probe_video(path: str, ffprobe: str = "ffprobe") -> dict:
    out = _run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                "stream=codec_name,width,height,avg_frame_rate,color_transfer:stream_side_data=rotation:format=duration",
                "-of", "json", path]).stdout
    j = json.loads(out)
    s = (j.get("streams") or [{}])[0]
    num, _, den = (s.get("avg_frame_rate") or "0/1").partition("/")
    fps = round(float(num) / float(den or 1), 2) if float(den or 1) else None
    rot = 0
    for sd in s.get("side_data_list", []) or []:
        rot = int(abs(sd.get("rotation", 0)))
    w, h = s.get("width"), s.get("height")
    if rot in (90, 270):
        w, h = h, w
    trc = s.get("color_transfer") or ""
    return {
        "duration": float((j.get("format") or {}).get("duration") or 0), "fps": fps, "w": w, "h": h,
        "codec": s.get("codec_name"), "hdr": "hlg" if trc == "arib-std-b67" else "pq" if trc == "smpte2084" else None,
    }


def _frame(path: str, t: float, out: Path, width: int, hdr: Optional[str], ffmpeg: str):
    vf = f"scale={width}:-2" + (f",{HLG if hdr == 'hlg' else PQ}" if hdr else "")
    _run([ffmpeg, "-v", "error", "-y", "-ss", f"{max(t, 0):.2f}", "-i", path, "-frames:v", "1", "-vf", vf, "-q:v", "3", str(out)])


def derive_video(asset, work: Path, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe", frames: int = 6) -> Derived:
    from PIL import Image

    work.mkdir(parents=True, exist_ok=True)
    meta = probe_video(asset.path, ffprobe)
    dur = meta["duration"] or 1.0
    d = Derived(w=meta["w"], h=meta["h"])
    pieces = []
    for i in range(frames):
        out = work / f"{asset.uuid}.f{i}.jpg"
        _frame(asset.path, dur * (i + 0.5) / frames, out, 512, meta["hdr"], ffmpeg)
        pieces.append(out)
    ims = [Image.open(p).convert("RGB") for p in pieces]
    cw = max(i.width for i in ims)
    ch = max(i.height for i in ims)
    sheet = Image.new("RGB", (cw * 3, ch * 2), (0, 0, 0))
    for idx, im in enumerate(ims):
        sheet.paste(im, ((idx % 3) * cw, (idx // 3) * ch))
    d.files["analysis"] = work / f"{asset.uuid}.analysis.jpg"
    sheet.save(d.files["analysis"], "JPEG", quality=80, optimize=True)
    d.files["thumb"] = work / f"{asset.uuid}.thumb.jpg"
    _save(ims[1] if len(ims) > 1 else ims[0], d.files["thumb"], 480, 82)
    d.dhash = dhash(ims[0])
    for p in pieces:
        p.unlink(missing_ok=True)
    d.video_meta = {"duration": round(dur, 2), "fps": meta["fps"], "codec": meta["codec"], "hdr": meta["hdr"], "frames": frames}
    return d


def make_preview(asset, out: Path, ffmpeg: str = "ffmpeg", hdr: Optional[str] = None, seconds: int = 90):
    vf = "scale=-2:720" + (f",{HLG if hdr == 'hlg' else PQ}" if hdr else "") + ",format=yuv420p"
    _run([ffmpeg, "-v", "error", "-y", "-i", asset.path, "-t", str(seconds), "-vf", vf, "-c:v", "libx264", "-crf", "28",
          "-preset", "veryfast", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", str(out)], timeout=1800)
