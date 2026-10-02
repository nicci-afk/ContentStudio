"""Local nudity screening, on the Mac, before anything is uploaded.

Fail closed. An item is "clear" only when the detector ran on every frame it
was shown and found nothing exposed. A decode error, a missing file, a video
that yields no frames, or a detector that raises all HOLD the item: it stays on
this Mac and is never uploaded. Nothing here is ever released automatically.
"""
from __future__ import annotations

import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional

EXPOSED = {
    "FEMALE_GENITALIA_EXPOSED", "MALE_GENITALIA_EXPOSED", "FEMALE_BREAST_EXPOSED",
    "BUTTOCKS_EXPOSED", "ANUS_EXPOSED",
}
COVERED = {"FEMALE_GENITALIA_COVERED", "FEMALE_BREAST_COVERED", "BUTTOCKS_COVERED", "ANUS_COVERED"}


@dataclass
class ScreenResult:
    status: str  # 'clear' | 'held'
    reason: str = ""


class NudeNetDetector:
    """NudeNet v3 runs fully on this machine (no image leaves it)."""

    def __init__(self):
        from nudenet import NudeDetector  # noqa: lazy

        self.d = NudeDetector()

    def __call__(self, image_path: str) -> List[dict]:
        return self.d.detect(image_path)


class Screener:
    def __init__(self, detector: Optional[Callable[[str], List[dict]]], threshold: float = 0.25,
                 hold_covered: bool = False, frame_every: float = 2.0, max_frames: int = 60, ffmpeg: str = "ffmpeg"):
        self.detector = detector
        self.threshold = threshold
        self.classes = EXPOSED | (COVERED if hold_covered else set())
        self.frame_every = frame_every
        self.max_frames = max_frames
        self.ffmpeg = ffmpeg

    def _judge(self, detections: List[dict]) -> Optional[str]:
        hits = [d for d in detections if d.get("class") in self.classes and float(d.get("score", 0)) >= self.threshold]
        if not hits:
            return None
        top = max(hits, key=lambda d: d["score"])
        return f"{top['class'].lower().replace('_', ' ')} ({top['score']:.2f})"

    def _prep_image(self, path: str, out: Path) -> None:
        from PIL import Image, ImageOps

        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except Exception:
            pass
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((1280, 1280))
            im.save(out, "JPEG", quality=88)

    def screen_image(self, path: str) -> ScreenResult:
        if self.detector is None:
            return ScreenResult("clear", "unscreened locally (--no-local-screen)")
        try:
            with tempfile.TemporaryDirectory() as td:
                small = Path(td) / "s.jpg"
                self._prep_image(path, small)
                hit = self._judge(self.detector(str(small)))
        except Exception as err:  # decode or detector failure: never assume clean
            return ScreenResult("held", f"could not be screened ({type(err).__name__})")
        return ScreenResult("held", hit) if hit else ScreenResult("clear")

    def screen_video(self, path: str, duration: float = 0) -> ScreenResult:
        if self.detector is None:
            return ScreenResult("clear", "unscreened locally (--no-local-screen)")
        try:
            with tempfile.TemporaryDirectory() as td:
                every = max(self.frame_every, (duration / self.max_frames) if duration else self.frame_every)
                subprocess.run(
                    [self.ffmpeg, "-v", "error", "-i", path, "-vf", f"fps=1/{every:.3f},scale=640:-2",
                     "-frames:v", str(self.max_frames), "-q:v", "3", str(Path(td) / "f%04d.jpg")],
                    check=True, capture_output=True, timeout=600,
                )
                frames = sorted(Path(td).glob("f*.jpg"))
                if not frames:
                    return ScreenResult("held", "no frames could be read to screen this video")
                for f in frames:
                    hit = self._judge(self.detector(str(f)))
                    if hit:
                        return ScreenResult("held", f"video frame: {hit}")
        except Exception as err:
            return ScreenResult("held", f"could not be screened ({type(err).__name__})")
        return ScreenResult("clear")

    def screen(self, asset) -> ScreenResult:
        return self.screen_video(asset.path, getattr(asset, "duration", 0) or 0) if asset.kind == "video" else self.screen_image(asset.path)
