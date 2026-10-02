"""Where assets come from: the real Photos library (osxphotos) or a JSON
fixture manifest used for dry runs and tests."""
from __future__ import annotations

import json
import mimetypes
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

# Apple's scene labels that usually mean "a picture of paper", not a travel
# moment. Best effort: the label vocabulary is Apple's, so this list is
# editable with --skip-labels.
DEFAULT_SKIP_LABELS = ["document", "receipt", "passport", "driver license", "identification card", "boarding pass", "whiteboard"]


@dataclass
class AlbumRec:
    uuid: str
    title: str
    folder: list = field(default_factory=list)
    newest: str = ""
    count: int = 0


@dataclass
class Asset:
    uuid: str
    name: str
    kind: str  # 'image' | 'video'
    mime: str
    size: int
    w: Optional[int]
    h: Optional[int]
    taken: Optional[str]  # local wall-clock 'YYYY-MM-DDTHH:MM:SS'
    lat: Optional[float] = None
    lon: Optional[float] = None
    place: Optional[str] = None
    albums: list = field(default_factory=list)  # album uuids
    title: Optional[str] = None
    description: Optional[str] = None
    keywords: list = field(default_factory=list)
    labels: list = field(default_factory=list)
    favorite: bool = False
    score: Optional[float] = None
    burst_member_of: Optional[str] = None  # uuid of the burst's key photo
    hidden: bool = False
    in_trash: bool = False
    screenshot: bool = False
    missing: bool = False  # original not downloaded from iCloud
    path: Optional[str] = None


def exclusion_reason(a: Asset, skip_labels: list) -> Optional[str]:
    """Why an asset is never imported. Hidden items are never imported by this
    tool, whatever the options: the Hidden album is where private photos live."""
    if a.hidden:
        return "hidden"
    if a.in_trash:
        return "recently deleted"
    if a.screenshot:
        return "screenshot"
    wanted = {s.lower() for s in skip_labels}
    if any(l.lower() in wanted for l in a.labels):
        return "looks like a document"
    if a.missing or not a.path:
        return "not downloaded from iCloud"
    return None


class Source:
    def albums(self) -> list: raise NotImplementedError
    def assets(self) -> Iterable[Asset]: raise NotImplementedError


def _first(v):
    if isinstance(v, (list, tuple)):
        return v[0] if v else None
    return v or None


class OsxPhotosSource(Source):
    """The real library. Needs macOS, the Photos library on disk, and Full Disk
    Access for the terminal running this (System Settings > Privacy)."""

    def __init__(self, library_path=None, include_shared=False, use_edited=False):
        import osxphotos  # noqa: lazy: only needed on the Mac

        self.db = osxphotos.PhotosDB(dbfile=library_path) if library_path else osxphotos.PhotosDB()
        self.include_shared = include_shared
        self.use_edited = use_edited

    def albums(self) -> list:
        infos = list(self.db.album_info)
        if self.include_shared:
            infos += list(self.db.album_info_shared)
        out = []
        for a in infos:
            end = getattr(a, "end_date", None)
            out.append(AlbumRec(
                uuid=a.uuid, title=a.title or "Untitled", folder=list(getattr(a, "folder_names", []) or []),
                newest=end.strftime("%Y-%m-%dT%H:%M:%S") if end else "", count=len(a.photos),
            ))
        return out

    def _place(self, p) -> Optional[str]:
        place = getattr(p, "place", None)
        if not place:
            return None
        n = getattr(place, "names", None)
        parts = []
        if n:
            for attr in ("area_of_interest", "city", "state_province", "country"):
                v = _first(getattr(n, attr, None))
                if v and v not in parts:
                    parts.append(v)
        return ", ".join(parts[:3]) or (getattr(place, "name", None) or None)

    def assets(self) -> Iterable[Asset]:
        for p in self.db.photos(images=True, movies=True, intrash=True):
            loc = p.location or (None, None)
            lat, lon = (loc[0], loc[1]) if loc else (None, None)
            path = (p.path_edited if self.use_edited and getattr(p, "path_edited", None) else p.path)
            name = p.original_filename or p.filename
            mime = mimetypes.guess_type(name)[0] or ("video/quicktime" if p.ismovie else "image/heic")
            burst_of = None
            if p.burst and not p.burst_key:
                key = next((b for b in (p.burst_photos or []) if b.burst_key), None)
                burst_of = key.uuid if key else None
            score = None
            try:
                score = float(p.score.overall)
            except Exception:
                pass
            yield Asset(
                uuid=p.uuid, name=name, kind="video" if p.ismovie else "image", mime=mime,
                size=int(p.original_filesize or 0), w=p.original_width or p.width, h=p.original_height or p.height,
                taken=p.date.strftime("%Y-%m-%dT%H:%M:%S") if p.date else None, lat=lat, lon=lon, place=self._place(p),
                albums=[a.uuid for a in p.album_info], title=p.title, description=p.description,
                keywords=list(p.keywords or []), labels=list(p.labels or []), favorite=bool(p.favorite), score=score,
                burst_member_of=burst_of, hidden=bool(p.hidden), in_trash=bool(p.intrash),
                screenshot=bool(p.screenshot), missing=bool(p.ismissing), path=path,
            )


class FixtureSource(Source):
    """A JSON manifest of albums and assets pointing at ordinary files, for
    dry runs and tests on any machine. Paths resolve relative to the file."""

    def __init__(self, manifest: str):
        self.base = Path(manifest).parent
        self.data = json.loads(Path(manifest).read_text())

    def albums(self) -> list:
        return [AlbumRec(uuid=a["uuid"], title=a["title"], folder=a.get("folder", []), newest=a.get("newest", ""), count=a.get("count", 0)) for a in self.data["albums"]]

    def assets(self) -> Iterable[Asset]:
        for a in self.data["assets"]:
            path = a.get("path")
            if path and not Path(path).is_absolute():
                path = str(self.base / path)
            yield Asset(
                uuid=a["uuid"], name=a["name"], kind=a.get("kind", "image"), mime=a.get("mime", mimetypes.guess_type(a["name"])[0] or "image/jpeg"),
                size=a.get("size") or (Path(path).stat().st_size if path and Path(path).exists() else 0),
                w=a.get("w"), h=a.get("h"), taken=a.get("taken"), lat=a.get("lat"), lon=a.get("lon"), place=a.get("place"),
                albums=a.get("albums", []), title=a.get("title"), description=a.get("description"), keywords=a.get("keywords", []),
                labels=a.get("labels", []), favorite=a.get("favorite", False), score=a.get("score"),
                burst_member_of=a.get("burst_member_of"), hidden=a.get("hidden", False), in_trash=a.get("in_trash", False),
                screenshot=a.get("screenshot", False), missing=a.get("missing", False), path=path,
            )
