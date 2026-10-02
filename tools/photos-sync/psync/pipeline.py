"""The batch pipeline: newest albums first, a few at a time. Each batch is
screened on this Mac, shrunk, uploaded in two phases, and recorded in a ledger
so a stopped run resumes where it left off.

  analysis   thumbnails and analysis copies (small: fast even on hotel Wi-Fi);
             the whole library becomes searchable and describable.
  originals  the full-quality files (photos as shot, videos in full 4K), plus a
             JPEG still for formats the server cannot decode. Uploads only after
             the server's own safety check has cleared each item.
"""
from __future__ import annotations

import csv
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional

from . import derive as D
from .sources import DEFAULT_SKIP_LABELS, exclusion_reason
from .uploader import ServerError


@dataclass
class Options:
    state_dir: Path
    albums: Optional[List[str]] = None
    exclude_albums: List[str] = field(default_factory=list)
    batch_albums: int = 3
    phase: str = "analysis"  # analysis | originals | both
    since: Optional[str] = None
    max_items: int = 0
    dry_run: bool = False
    include_unfiled: bool = False
    skip_labels: List[str] = field(default_factory=lambda: list(DEFAULT_SKIP_LABELS))
    workers: int = 4
    start_analysis: bool = True
    mbps: float = 0  # only used to print time estimates
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"


def _ts(s: Optional[str]):
    try:
        return datetime.fromisoformat(s) if s else None
    except Exception:
        return None


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024
    return f"{n:.1f}TB"


class Pipeline:
    def __init__(self, source, ledger, screener, uploader, opts: Options, log: Callable = print):
        self.source, self.ledger, self.screener, self.up, self.o, self.log = source, ledger, screener, uploader, opts, log
        self.work = opts.state_dir / "work"
        self.work.mkdir(parents=True, exist_ok=True)
        self.releases: set = set()
        self.video_slots = threading.Semaphore(2)
        self.stats = {"excluded": {}, "held_mac": 0, "uploaded_analysis": 0, "uploaded_originals": 0, "bytes": 0, "errors": 0}

    # -- selection ---------------------------------------------------------
    def _match(self, title: str, names: Optional[List[str]]) -> bool:
        return names is None or title.lower() in {n.lower() for n in names}

    def select(self):
        albums = [a for a in self.source.albums()
                  if self._match(a.title, self.o.albums) and a.title.lower() not in {n.lower() for n in self.o.exclude_albums}]
        albums.sort(key=lambda a: a.newest or "", reverse=True)
        allowed = {a.uuid for a in albums}
        by_uuid = {a.uuid: a for a in albums}
        eligible, reasons = {}, {}
        for a in self.source.assets():
            why = exclusion_reason(a, self.o.skip_labels)
            if why:
                reasons[why] = reasons.get(why, 0) + 1
                continue
            if self.o.since and (a.taken or "") < self.o.since:
                continue
            a.albums = [u for u in a.albums if u in allowed]  # private albums' names never leave this Mac
            if not a.albums and not (self.o.include_unfiled and self.o.albums is None):
                continue
            eligible[a.uuid] = a
        self.stats["excluded"] = reasons
        return albums, by_uuid, eligible

    def batches(self, albums, eligible):
        seen, out = set(), []
        members: Dict[str, list] = {}
        for a in eligible.values():
            for u in a.albums:
                members.setdefault(u, []).append(a)
        current: list = []
        titles: list = []
        for alb in albums:
            fresh = [x for x in sorted(members.get(alb.uuid, []), key=lambda x: x.taken or "", reverse=True) if x.uuid not in seen]
            for x in fresh:
                seen.add(x.uuid)
            if fresh:
                current.extend(fresh)
                titles.append(alb.title)
            if len(titles) >= self.o.batch_albums:
                out.append((titles, current))
                current, titles = [], []
        if titles:
            out.append((titles, current))
        unfiled = [a for a in eligible.values() if not a.albums and a.uuid not in seen]
        if unfiled:
            out.append((["(not in any album)"], sorted(unfiled, key=lambda x: x.taken or "", reverse=True)))
        if self.o.max_items:
            left, trimmed = self.o.max_items, []
            for t, items in out:
                if left <= 0:
                    break
                trimmed.append((t, items[:left]))
                left -= len(items[:left])
            out = trimmed
        return out

    # -- preparing ---------------------------------------------------------
    def _prepare(self, a):
        row = self.ledger.item(a.uuid)
        override = a.uuid in self.releases
        if row and row["screen"] == "held" and not override:
            return "held", row["screen_reason"], None
        if override or not row or row["screen"] != "clear":
            if a.kind == "video":
                with self.video_slots:
                    res = self.screener.screen(a)
            else:
                res = self.screener.screen(a)
            if res.status != "clear" and not override:
                self.ledger.upsert(a.uuid, name=a.name, kind=a.kind, taken=a.taken, size=a.size, screen="held", screen_reason=res.reason, state="held")
                return "held", res.reason, None
        self.ledger.upsert(a.uuid, name=a.name, kind=a.kind, taken=a.taken, size=a.size, screen="clear",
                           screen_reason="owner release" if override else "", state=(row["state"] if row and row["state"] not in (None, "held") else "screened"), override=1 if override else 0)
        try:
            if a.kind == "video":
                with self.video_slots:
                    d = D.derive_video(a, self.work, self.o.ffmpeg, self.o.ffprobe)
            else:
                d = D.derive_image(a, self.work)
        except Exception as err:
            self.ledger.upsert(a.uuid, state="error", error=f"{type(err).__name__}: {err}"[:300])
            return "error", str(err)[:120], None
        return "ok", "", d

    def _dedupe(self, prepared: dict, eligible_by_uuid: dict) -> dict:
        """uuid -> representative uuid for burst members and near-identical stills."""
        dup = {}
        imgs = sorted((u for u, (a, d) in prepared.items() if a.kind == "image"), key=lambda u: prepared[u][0].taken or "")
        for u in imgs:
            a, _ = prepared[u]
            if a.burst_member_of and a.burst_member_of != u:
                dup[u] = a.burst_member_of
        recent: list = []
        for u in imgs:
            if u in dup:
                continue
            a, d = prepared[u]
            t = _ts(a.taken)
            hit = None
            for r in recent[-6:]:
                ra, rd = prepared[r]
                rt = _ts(ra.taken)
                if t and rt and abs((t - rt).total_seconds()) <= 10 and d.dhash is not None and rd.dhash is not None and D.hamming(d.dhash, rd.dhash) <= 6:
                    hit = r
                    break
            if hit:
                best = max((hit, u), key=lambda x: (prepared[x][0].favorite, prepared[x][0].score or 0))
                loser = u if best == hit else hit
                dup[loser] = best
                if loser == hit:
                    recent[recent.index(hit)] = u
            else:
                recent.append(u)
        return dup

    def _record(self, a, d, kinds, dup_of, album_ok):
        rec = {
            "uuid": a.uuid, "name": a.name, "kind": a.kind, "mime": a.mime, "size": a.size, "w": d.w or a.w, "h": d.h or a.h,
            "takenAt": a.taken, "place": a.place, "albums": [u for u in a.albums if u in album_ok],
            "apple": {"title": a.title, "description": a.description, "place": a.place, "keywords": a.keywords,
                      "labels": a.labels, "favorite": a.favorite, "score": a.score},
            "dupOf": dup_of, "kinds": {k: True for k in kinds}, "localScreen": "clear",
        }
        if a.lat is not None and a.lon is not None:
            rec["gps"] = {"lat": a.lat, "lon": a.lon}
        if d.video_meta:
            rec["videoMeta"] = d.video_meta
        return rec

    # -- phases ------------------------------------------------------------
    def run(self, confirm: Optional[Callable[[str], bool]] = None):
        albums, by_uuid, eligible = self.select()
        self.log(f"{len(albums)} album(s) selected, {len(eligible)} item(s) eligible. Left out: "
                 + (", ".join(f"{n} {why}" for why, n in sorted(self.stats['excluded'].items(), key=lambda x: -x[1])) or "nothing"))
        if not self.o.dry_run:
            self.releases = self.up.releases()
        plan = self.batches(albums, eligible)
        self.log(f"{len(plan)} batch(es) of up to {self.o.batch_albums} album(s), newest first.")
        t0 = time.time()
        try:
            for i, (titles, items) in enumerate(plan, 1):
                self.log(f"\n== Batch {i}/{len(plan)}: {', '.join(titles[:6])}{' ...' if len(titles) > 6 else ''}  ({len(items)} items)")
                self.process_batch(items, by_uuid)
        except KeyboardInterrupt:
            self.log("\nStopped. Run the same command again and it picks up where it left off.")
        self.report(time.time() - t0)

    def process_batch(self, items, by_uuid):
        phases = ["analysis", "originals"] if self.o.phase == "both" else [self.o.phase]
        prepared: Dict[str, tuple] = {}
        held: List[dict] = []
        todo = []
        for a in items:
            kinds = self.ledger.kinds(a.uuid)
            done_analysis = {"thumb", "analysis"} <= kinds
            done_orig = "original" in kinds
            if ("analysis" in phases and not done_analysis) or ("originals" in phases and not done_orig):
                todo.append(a)
        self.log(f"   {len(items) - len(todo)} already done, {len(todo)} to process")
        if not todo:
            return
        with ThreadPoolExecutor(self.o.workers) as pool:
            results = list(pool.map(self._prepare, todo))
        for a, (status, reason, d) in zip(todo, results):
            if status == "ok":
                prepared[a.uuid] = (a, d)
            elif status == "held":
                held.append({"uuid": a.uuid, "name": a.name, "kind": a.kind, "takenAt": a.taken, "reason": reason})
            else:
                self.stats["errors"] += 1
                self.log(f"   skipped {a.name}: {reason}")
        self.stats["held_mac"] += len(held)
        dup = self._dedupe(prepared, {a.uuid: a for a in todo})
        self.log(f"   screened: {len(prepared)} clear, {len(held)} held on this Mac, {len(dup)} near-duplicate(s) marked")
        album_ok = {u for a, _ in prepared.values() for u in a.albums}
        album_recs = [{"uuid": u, "title": by_uuid[u].title, "folder": by_uuid[u].folder} for u in album_ok if u in by_uuid]

        if "analysis" in phases:
            self._phase_analysis(prepared, dup, held, album_recs, album_ok)
        elif held:
            self.up.commit([], [], held) if not self.o.dry_run else None
        if "originals" in phases:
            self._phase_originals(prepared, dup, album_recs, album_ok)

    def _phase_analysis(self, prepared, dup, held, album_recs, album_ok):
        total = sum(Path(p).stat().st_size for a, d in prepared.values() for k, p in d.files.items() if k in ("thumb", "analysis"))
        self.log(f"   analysis copies: {human(total)} for {len(prepared)} item(s)")
        if self.o.dry_run:
            self.stats["bytes"] += total
            return
        todo = {u: (a, d) for u, (a, d) in prepared.items() if not {"thumb", "analysis"} <= self.ledger.kinds(u)}
        records = []
        for chunk in _chunks(list(todo.items()), 200):
            planned = self.up.plan([{"uuid": u, "kinds": ["thumb", "analysis"]} for u, _ in chunk])
            jobs = []
            for p in planned:
                a, d = todo[p["uuid"]]
                if p["action"] == "held":
                    self.ledger.upsert(a.uuid, screen="held", screen_reason=p.get("reason") or "held by the server", state="held")
                    continue
                for kind, url in (p.get("urls") or {}).items():
                    jobs.append((url, d.files[kind]))
            with ThreadPoolExecutor(4) as pool:
                list(pool.map(lambda j: self.up.put_file(j[0], j[1], "image/jpeg"), jobs))
            for p in planned:
                if p["action"] == "held":
                    continue
                a, d = todo[p["uuid"]]
                records.append(self._record(a, d, ["thumb", "analysis"], dup.get(a.uuid), album_ok))
        for chunk in _chunks(records, 100):
            res = self.up.commit(chunk, album_recs, [])
            for r in res.get("rejected", []):
                self.log(f"   server declined {r.get('uuid')}: {r.get('reason')}")
            for rec in chunk:
                self.ledger.upsert(rec["uuid"], state="committed", kinds=self.ledger.kinds(rec["uuid"]) | {"thumb", "analysis"}, dup_of=rec.get("dupOf"))
        if held:
            self.up.commit([], [], held)
        self.stats["uploaded_analysis"] += len(records)
        self.stats["bytes"] += total
        self.log(f"   uploaded and committed {len(records)} item(s)")
        if self.o.start_analysis and records:
            try:
                self.up.start_analysis()
            except ServerError as err:
                if err.status != 409:
                    self.log(f"   could not start server analysis: {err}")

    def _wait_server_analysis(self):
        """Originals are uploaded only after the server's own safety check
        has looked at every analysis copy; a failed check stops the run."""
        started = False
        while True:
            st = self.up.analysis_state()
            state, est = st["state"], st["estimate"]
            if state.get("stopped"):
                raise RuntimeError(f"server analysis stopped ({state['stopped']}); originals are not uploaded until the safety check can run")
            if state["running"]:
                self.log(f"   waiting for the server's safety check: {state['done']}/{state['total']}")
                time.sleep(6)
                continue
            if est["items"] > 0 and not started:
                try:
                    self.up.start_analysis()
                except ServerError as err:
                    if err.status != 409:
                        raise
                started = True
                time.sleep(2)
                continue
            if est["items"] > 0:
                raise RuntimeError("server analysis did not finish; originals are not uploaded until it does")
            return

    def _phase_originals(self, prepared, dup, album_recs, album_ok):
        if self.o.dry_run:
            total = sum(a.size for a, _ in prepared.values())
            self.stats["bytes"] += total
            eta = f" (about {total * 8 / (self.o.mbps * 1e6) / 3600:.1f} hours at {self.o.mbps:g} Mbps)" if self.o.mbps else ""
            self.log(f"   originals: {human(total)}{eta}")
            return
        self._wait_server_analysis()
        todo = {u: (a, d) for u, (a, d) in prepared.items() if "original" not in self.ledger.kinds(u)}
        for u, (a, d) in list(todo.items()):
            if a.kind == "image" and (a.mime not in D.WEB_SAFE or a.size > D.BIG_ORIGINAL) and "render" not in d.files:
                todo[u] = (a, D.derive_image(a, self.work))
        count = 0
        for chunk in _chunks(list(todo.items()), 50):
            planned = self.up.plan([{"uuid": u, "kinds": ["original"] + (["render"] if "render" in d.files else [])} for u, (a, d) in chunk])
            for p in planned:
                a, d = todo[p["uuid"]]
                if p["action"] == "held":
                    self.ledger.upsert(a.uuid, screen="held", screen_reason=p.get("reason") or "held by the server", state="held")
                    self.log(f"   not uploading {a.name}: held by the server's check")
                    continue
                kinds = {"original"}
                try:
                    for kind, url in (p.get("urls") or {}).items():
                        self.up.put_file(url, d.files[kind], "image/jpeg")
                        kinds.add(kind)
                    if "original" in (p.get("multipart") or []) or "original" not in (p.get("have") or []):
                        self.up.multipart(p["id"], a.uuid, "original", Path(a.path), a.mime, self.ledger,
                                          progress=_progress(a.name, a.size))
                except Exception as err:
                    self.stats["errors"] += 1
                    self.ledger.upsert(a.uuid, error=f"{type(err).__name__}: {err}"[:300])
                    self.log(f"   FAILED {a.name}: {err} (will retry on the next run)")
                    continue
                res = self.up.commit([self._record(a, d, kinds, dup.get(a.uuid), album_ok)], album_recs, [])
                if res.get("rejected"):
                    self.log(f"   server declined {a.name}: {res['rejected']}")
                    continue
                self.ledger.upsert(a.uuid, state="originals_done", kinds=self.ledger.kinds(a.uuid) | kinds, error=None)
                for pth in d.files.values():
                    Path(pth).unlink(missing_ok=True)
                count += 1
                self.stats["bytes"] += a.size
        self.stats["uploaded_originals"] += count
        self.log(f"   uploaded {count} original(s)")

    # -- report ------------------------------------------------------------
    def report(self, seconds: float):
        held = self.ledger.held()
        path = self.o.state_dir / "held-on-mac.csv"
        with open(path, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["original filename", "captured", "kind", "reason", "photos uuid"])
            for r in held:
                w.writerow([r["name"], r["taken"], r["kind"], r["screen_reason"], r["uuid"]])
        s = self.stats
        self.log(f"\nDone in {seconds / 60:.1f} min. Analysis copies uploaded: {s['uploaded_analysis']}, originals: {s['uploaded_originals']}, "
                 f"{human(s['bytes'])} sent, {s['held_mac']} held on this Mac this run, {s['errors']} error(s).")
        self.log(f"{len(held)} item(s) are held in total. Their names and reasons are in {path} (never uploaded; open Photos and search by date to find them).")


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _progress(name: str, size: int):
    state = {"last": -1}

    def cb(sent: int, total: int):
        pct = int(sent * 100 / total) // 10 * 10
        if pct != state["last"] and total > 128 * 1024 * 1024:
            state["last"] = pct
            print(f"   {name}: {pct}% of {human(size)}")
    return cb
