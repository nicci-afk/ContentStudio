"""SQLite ledger: every item's progress, so a run can stop (sleep, dropped
Wi-Fi, closed laptop) and resume exactly where it left off, and nothing is
ever uploaded twice."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path


def _locked(fn):
    def wrapper(self, *a, **k):
        with self.lock:
            return fn(self, *a, **k)
    wrapper.__name__ = fn.__name__
    return wrapper


class Ledger:
    def __init__(self, state_dir: Path):
        state_dir.mkdir(parents=True, exist_ok=True)
        self.path = state_dir / "ledger.db"
        # Autocommit plus one lock: the pipeline prepares items on several
        # threads, and one shared connection must never interleave statements.
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, timeout=30, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS items(
              uuid TEXT PRIMARY KEY, name TEXT, kind TEXT, taken TEXT, size INTEGER,
              screen TEXT, screen_reason TEXT, state TEXT, kinds TEXT, dup_of TEXT,
              override INTEGER DEFAULT 0, error TEXT, updated REAL);
            CREATE TABLE IF NOT EXISTS albums(uuid TEXT PRIMARY KEY, title TEXT, state TEXT, updated REAL);
            CREATE TABLE IF NOT EXISTS uploads(
              item_uuid TEXT, kind TEXT, upload_id TEXT, part_size INTEGER, size INTEGER,
              PRIMARY KEY(item_uuid, kind));
            """
        )

    # items ---------------------------------------------------------------
    @_locked
    def item(self, uuid: str):
        return self.db.execute("SELECT * FROM items WHERE uuid=?", (uuid,)).fetchone()

    @_locked
    def upsert(self, uuid: str, **fields):
        fields["updated"] = time.time()
        if "kinds" in fields and not isinstance(fields["kinds"], str):
            fields["kinds"] = json.dumps(sorted(fields["kinds"]))
        cols = ", ".join(fields)
        marks = ", ".join("?" for _ in fields)
        updates = ", ".join(f"{c}=excluded.{c}" for c in fields)
        self.db.execute(
            f"INSERT INTO items(uuid, {cols}) VALUES(?, {marks}) ON CONFLICT(uuid) DO UPDATE SET {updates}",
            (uuid, *fields.values()),
        )

    @_locked
    def kinds(self, uuid: str) -> set:
        row = self.item(uuid)
        return set(json.loads(row["kinds"])) if row and row["kinds"] else set()

    @_locked
    def counts(self) -> dict:
        out = {}
        for row in self.db.execute("SELECT COALESCE(state,'new') s, COUNT(*) c FROM items GROUP BY s"):
            out[row["s"]] = row["c"]
        return out

    @_locked
    def held(self):
        return self.db.execute("SELECT * FROM items WHERE screen='held' ORDER BY taken DESC").fetchall()

    # albums --------------------------------------------------------------
    @_locked
    def album_done(self, uuid: str, title: str = ""):
        self.db.execute(
            "INSERT INTO albums(uuid,title,state,updated) VALUES(?,?, 'done', ?) "
            "ON CONFLICT(uuid) DO UPDATE SET state='done', updated=excluded.updated",
            (uuid, title, time.time()),
        )

    @_locked
    def is_album_done(self, uuid: str, phase: str) -> bool:
        row = self.db.execute("SELECT state FROM albums WHERE uuid=?", (f"{phase}:{uuid}",)).fetchone()
        return bool(row and row["state"] == "done")

    @_locked
    def mark_album_phase(self, uuid: str, phase: str, title: str = ""):
        self.album_done(f"{phase}:{uuid}", title)

    # multipart resume ----------------------------------------------------
    @_locked
    def upload_get(self, item_uuid: str, kind: str):
        return self.db.execute("SELECT * FROM uploads WHERE item_uuid=? AND kind=?", (item_uuid, kind)).fetchone()

    @_locked
    def upload_set(self, item_uuid: str, kind: str, upload_id: str, part_size: int, size: int):
        self.db.execute(
            "INSERT INTO uploads VALUES(?,?,?,?,?) ON CONFLICT(item_uuid,kind) DO UPDATE SET "
            "upload_id=excluded.upload_id, part_size=excluded.part_size, size=excluded.size",
            (item_uuid, kind, upload_id, part_size, size),
        )

    @_locked
    def upload_clear(self, item_uuid: str, kind: str):
        self.db.execute("DELETE FROM uploads WHERE item_uuid=? AND kind=?", (item_uuid, kind))
