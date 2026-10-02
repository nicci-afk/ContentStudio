"""Talks to the ContentStudio server: plan, signed uploads straight to the
bucket (small files and resumable multipart), and the commit of items, albums
and files held back on this Mac. Large files never pass through the app server."""
from __future__ import annotations

import time
from pathlib import Path
from typing import Callable, Optional

import requests


class ServerError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}")
        self.status = status


class Uploader:
    def __init__(self, server: str, password: str, workspace: Optional[str] = None, max_mbps: float = 0,
                 session: Optional[requests.Session] = None, log: Callable = print):
        self.server = server.rstrip("/")
        self.s = session or requests.Session()
        self.s.auth = ("studio", password)
        self.workspace = workspace
        self.max_mbps = max_mbps
        self.log = log
        self._t = time.time()
        self._sent = 0

    # -- plumbing ----------------------------------------------------------
    def _throttle(self, nbytes: int):
        if not self.max_mbps:
            return
        self._sent += nbytes
        due = self._sent * 8 / (self.max_mbps * 1e6)
        wait = due - (time.time() - self._t)
        if wait > 0:
            time.sleep(wait)
        if time.time() - self._t > 30:  # keep the window short so bursts do not bank up
            self._t, self._sent = time.time(), 0

    def _retry(self, fn, tries: int = 6, what: str = "request"):
        delay = 2.0
        for attempt in range(tries):
            try:
                return fn()
            except (requests.ConnectionError, requests.Timeout) as err:
                if attempt == tries - 1:
                    raise
                self.log(f"   network trouble on {what} ({type(err).__name__}); retrying in {delay:.0f}s")
            except ServerError as err:
                if err.status < 500 or attempt == tries - 1:
                    raise
                self.log(f"   server said {err.status} on {what}; retrying in {delay:.0f}s")
            time.sleep(delay)
            delay = min(delay * 2, 60)

    def api(self, method: str, path: str, **kw):
        headers = {"x-workspace": self.workspace} if self.workspace else {}
        def go():
            r = self.s.request(method, self.server + path, headers=headers, timeout=120, **kw)
            if r.status_code >= 400:
                try:
                    msg = r.json().get("error", r.text[:200])
                except Exception:
                    msg = r.text[:200]
                raise ServerError(r.status_code, msg)
            return r.json() if r.content else {}
        return self._retry(go, what=f"{method} {path}")

    # -- API ---------------------------------------------------------------
    def workspaces(self):
        return self.api("GET", "/api/workspaces")

    def status(self):
        return self.api("GET", "/api/ingest/status")

    def plan(self, items: list):
        return self.api("POST", "/api/ingest/plan", json={"items": items})["items"]

    def commit(self, items: list, albums: list, held_local: list):
        return self.api("POST", "/api/ingest/commit", json={"items": items, "albums": albums, "heldLocal": held_local})

    def releases(self) -> set:
        return set(self.api("GET", "/api/ingest/releases").get("uuids", []))

    def start_analysis(self):
        return self.api("POST", "/api/media/analysis", json={})

    def analysis_state(self):
        return self.api("GET", "/api/media/analysis")

    # -- uploads -----------------------------------------------------------
    def put_file(self, url: str, path: Path, content_type: str = "application/octet-stream"):
        data = Path(path).read_bytes()
        def go():
            r = requests.put(url, data=data, headers={"content-type": content_type}, timeout=300)
            if r.status_code >= 400:
                raise ServerError(r.status_code, r.text[:200])
            return r
        self._retry(go, what=f"upload {Path(path).name}")
        self._throttle(len(data))

    def multipart(self, item_id: str, item_uuid: str, kind: str, path: Path, mime: str, ledger,
                  progress: Optional[Callable[[int, int], None]] = None):
        size = Path(path).stat().st_size
        if size <= 0:
            raise ServerError(0, f"{path} is empty")
        row = ledger.upload_get(item_uuid, kind)
        done, urls, upload_id, part_size = {}, {}, None, None
        if row and row["size"] == size:
            try:
                listed = self.api("GET", f"/api/ingest/multipart/{item_id}/{kind}", params={"uploadId": row["upload_id"]})["parts"]
                upload_id, part_size = row["upload_id"], row["part_size"]
                done = {p["n"]: p for p in listed}
                if done:
                    self.log(f"   resuming {Path(path).name}: {len(done)} part(s) already stored")
            except ServerError as err:
                if err.status != 404:
                    raise
                ledger.upload_clear(item_uuid, kind)
        if upload_id is None:
            started = self.api("POST", "/api/ingest/multipart/start", json={"id": item_id, "kind": kind, "size": size, "contentType": mime})
            upload_id, part_size = started["uploadId"], started["partSize"]
            urls = {p["n"]: p["url"] for p in started["parts"]}
            ledger.upload_set(item_uuid, kind, upload_id, part_size, size)
        count = -(-size // part_size)
        etags = {n: p["etag"] for n, p in done.items()}
        sent = sum(p.get("size", 0) for p in done.values())
        with open(path, "rb") as fh:
            for n in range(1, count + 1):
                expected = part_size if n < count else size - part_size * (count - 1)
                if n in done and done[n].get("size") == expected:
                    continue
                fh.seek((n - 1) * part_size)
                chunk = fh.read(expected)
                if n not in urls:
                    urls.update({p["n"]: p["url"] for p in self.api("POST", "/api/ingest/multipart/resign", json={"id": item_id, "kind": kind, "uploadId": upload_id, "parts": [n]})["parts"]})
                def go(n=n, chunk=chunk):
                    r = requests.put(urls[n], data=chunk, timeout=600)
                    if r.status_code == 403:  # signed link expired: sign this part again
                        urls[n] = self.api("POST", "/api/ingest/multipart/resign", json={"id": item_id, "kind": kind, "uploadId": upload_id, "parts": [n]})["parts"][0]["url"]
                        raise ServerError(503, "link expired, re-signed")
                    if r.status_code >= 400:
                        raise ServerError(r.status_code, r.text[:200])
                    return r.headers.get("ETag")
                etags[n] = self._retry(go, what=f"part {n}/{count} of {Path(path).name}")
                self._throttle(len(chunk))
                sent += len(chunk)
                if progress:
                    progress(sent, size)
        res = self.api("POST", "/api/ingest/multipart/complete", json={
            "id": item_id, "kind": kind, "uploadId": upload_id, "parts": [{"n": n, "etag": e} for n, e in sorted(etags.items())]})
        if not res.get("ok") or res.get("bytes") != size:
            raise ServerError(500, f"{kind} for {item_uuid} stored {res.get('bytes')} bytes, expected {size}")
        ledger.upload_clear(item_uuid, kind)
