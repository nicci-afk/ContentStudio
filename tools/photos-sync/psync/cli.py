from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

from .ledger import Ledger
from .pipeline import Options, Pipeline, human
from .screening import NudeNetDetector, Screener
from .sources import DEFAULT_SKIP_LABELS, FixtureSource, OsxPhotosSource
from .uploader import ServerError, Uploader

DEFAULT_SERVER = "https://contentstudio-zc9j.onrender.com"


def csv_list(v):
    return [x.strip() for x in v.split(",") if x.strip()] if v else None


def common(p: argparse.ArgumentParser):
    p.add_argument("--library", help="path to a .photoslibrary (default: the system Photos library)")
    p.add_argument("--fixture", help="JSON manifest instead of the real library (dry runs and tests)")
    p.add_argument("--state-dir", default=str(Path.home() / ".contentstudio-photos"), help="ledger, working copies and reports")
    p.add_argument("--albums", help="only these albums (comma separated names). Everything else, and the names of albums you leave out, stays on this Mac")
    p.add_argument("--exclude-albums", help="albums to skip (comma separated names)")
    p.add_argument("--include-unfiled", action="store_true", help="also import photos that are in no album (only with no --albums filter)")
    p.add_argument("--since", help="only items captured on or after YYYY-MM-DD")
    p.add_argument("--skip-labels", default=",".join(DEFAULT_SKIP_LABELS), help="Apple scene labels that mean 'a picture of paper'")
    p.add_argument("--use-edited", action="store_true", help="use the edited version instead of the original")
    p.add_argument("--shared-albums", action="store_true", help="include shared albums")
    p.add_argument("--max-items", type=int, default=0, help="stop after this many items (testing)")
    p.add_argument("--mbps", type=float, default=0, help="your upload speed, only to print time estimates")
    p.add_argument("--ffmpeg", default="ffmpeg")
    p.add_argument("--ffprobe", default="ffprobe")


def build_source(a):
    if a.fixture:
        return FixtureSource(a.fixture)
    return OsxPhotosSource(a.library, include_shared=a.shared_albums, use_edited=a.use_edited)


def build_options(a, phase="analysis") -> Options:
    return Options(
        state_dir=Path(a.state_dir), albums=csv_list(a.albums), exclude_albums=csv_list(a.exclude_albums) or [],
        batch_albums=getattr(a, "batch_albums", 3), phase=phase, since=a.since, max_items=a.max_items,
        dry_run=getattr(a, "dry_run", False), include_unfiled=a.include_unfiled, skip_labels=csv_list(a.skip_labels) or [],
        start_analysis=not getattr(a, "no_start_analysis", False), mbps=a.mbps, ffmpeg=a.ffmpeg, ffprobe=a.ffprobe,
    )


def build_screener(a) -> Screener:
    if getattr(a, "no_local_screen", False):
        if not getattr(a, "i_accept_server_only_screening", False):
            sys.exit("Refusing to run without the local nudity screen. The screen is what keeps flagged files on this Mac.\n"
                     "If you really want the server's check only, add --no-local-screen --i-accept-server-only-screening.")
        return Screener(None)
    try:
        detector = NudeNetDetector()
    except Exception as err:
        sys.exit(f"The local nudity screen is not available ({err}).\nInstall it with: pip install -r requirements.txt\n"
                 "Nothing is uploaded without it.")
    return Screener(detector, threshold=a.threshold, hold_covered=a.hold_covered, ffmpeg=a.ffmpeg)


def build_uploader(a) -> Uploader:
    password = os.environ.get("CONTENTSTUDIO_PASSWORD") or getpass.getpass("ContentStudio studio password: ")
    up = Uploader(a.server, password, max_mbps=getattr(a, "max_upload_mbps", 0))
    ws = up.workspaces()
    items = ws["items"]
    want = (a.workspace or "").lower()
    match = [w for w in items if w["id"] == a.workspace] or [w for w in items if want and want in w["name"].lower()]
    if len(match) != 1:
        names = "\n".join(f"  {w['id']}  {w['name']}  (library: {w.get('library')})" for w in items)
        sys.exit(f"Pick the workspace to upload into with --workspace (id or part of its name). Found {len(match)} match(es). Choices:\n{names}")
    up.workspace = match[0]["id"]
    print(f"Uploading into workspace '{match[0]['name']}', library '{match[0].get('library')}'.")
    if not a.yes and input("Continue? [y/N] ").strip().lower() != "y":
        sys.exit("Cancelled.")
    return up


def cmd_inventory(a):
    source = build_source(a)
    opts = build_options(a)
    pipe = Pipeline(source, Ledger(opts.state_dir), None, None, opts)
    albums, _, eligible = pipe.select()
    plan = pipe.batches(albums, eligible)
    total = sum(x.size for x in eligible.values())
    videos = sum(1 for x in eligible.values() if x.kind == "video")
    print(f"\n{len(albums)} album(s) selected; {len(eligible)} item(s) eligible ({len(eligible) - videos} photos, {videos} videos), {human(total)} of originals.")
    print("Left out:", ", ".join(f"{n} {why}" for why, n in sorted(pipe.stats["excluded"].items(), key=lambda x: -x[1])) or "nothing")
    if a.mbps:
        print(f"Originals at {a.mbps:g} Mbps upload: about {total * 8 / (a.mbps * 1e6) / 3600:.1f} hours of uploading.")
    print(f"\nBatches (newest first, {opts.batch_albums} album(s) each):")
    for i, (titles, items) in enumerate(plan[:15], 1):
        print(f"  {i:>3}. {', '.join(titles[:4])}{' ...' if len(titles) > 4 else ''}  ({len(items)} items, {human(sum(x.size for x in items))})")
    if len(plan) > 15:
        print(f"  ... and {len(plan) - 15} more batch(es)")


def cmd_run(a):
    opts = build_options(a, a.phase)
    source = build_source(a)
    ledger = Ledger(opts.state_dir)
    screener = build_screener(a)
    up = None if a.dry_run else build_uploader(a)
    Pipeline(source, ledger, screener, up, opts).run()


def cmd_status(a):
    ledger = Ledger(Path(a.state_dir))
    print("Ledger:", ledger.counts() or "empty")
    print(f"Held on this Mac: {len(ledger.held())}")
    if a.workspace:
        up = build_uploader(a)
        print("Server:", up.status()["counts"])


def main(argv=None):
    p = argparse.ArgumentParser(prog="photos_sync", description="Screen, shrink and upload a Photos library to ContentStudio.")
    sub = p.add_subparsers(dest="cmd", required=True)

    inv = sub.add_parser("inventory", help="what would be imported (no uploads, no network)")
    common(inv)
    inv.add_argument("--batch-albums", type=int, default=3)
    inv.set_defaults(fn=cmd_inventory)

    run = sub.add_parser("run", help="screen, shrink and upload, a few albums at a time, newest first")
    common(run)
    run.add_argument("--phase", choices=["analysis", "originals", "both"], default="analysis",
                     help="analysis = small copies (fast, search and AI work right away); originals = full-quality files; both = per batch")
    run.add_argument("--batch-albums", type=int, default=3, help="albums per batch")
    run.add_argument("--dry-run", action="store_true", help="screen and measure everything, upload nothing")
    run.add_argument("--server", default=os.environ.get("CONTENTSTUDIO_URL", DEFAULT_SERVER))
    run.add_argument("--workspace", help="workspace id or part of its name (its photo library is where files land)")
    run.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    run.add_argument("--max-upload-mbps", type=float, default=0, help="cap upload speed so the Wi-Fi stays usable")
    run.add_argument("--threshold", type=float, default=0.25, help="detector confidence that holds an item (lower is stricter)")
    run.add_argument("--hold-covered", action="store_true", help="also hold items showing covered body areas (swimwear), stricter still")
    run.add_argument("--no-local-screen", action="store_true")
    run.add_argument("--i-accept-server-only-screening", action="store_true")
    run.add_argument("--no-start-analysis", action="store_true", help="do not start the server's AI analysis after each batch")
    run.set_defaults(fn=cmd_run)

    st = sub.add_parser("status", help="ledger summary (and the server's counts with --workspace)")
    st.add_argument("--state-dir", default=str(Path.home() / ".contentstudio-photos"))
    st.add_argument("--server", default=os.environ.get("CONTENTSTUDIO_URL", DEFAULT_SERVER))
    st.add_argument("--workspace")
    st.add_argument("--yes", action="store_true")
    st.set_defaults(fn=cmd_status)

    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
