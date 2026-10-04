# Photos sync

Loads a whole Photos library into ContentStudio: albums kept as albums, every
item screened for nudity **on your Mac before it uploads**, small AI-ready
copies first (fast, even on hotel Wi-Fi), full-quality originals after, newest
albums first, a few albums at a time. Stops and resumes safely.

## What it does, in order

1. **Reads your Photos library** (via [osxphotos](https://github.com/RhetTbull/osxphotos)): every album and folder, titles, captions, keywords, place names, GPS, favorites, Apple's scene labels, and Apple's own quality score. People names are never read.
2. **Leaves out, always:** the Hidden album, Recently Deleted, screenshots, items Apple labels as documents or receipts, and anything not yet downloaded from iCloud. There is no option to include Hidden.
3. **Screens every photo and video on this Mac** with a local detector ([NudeNet](https://github.com/notAI-tech/NudeNet), runs offline). Videos are checked every two seconds. Anything flagged, **or anything that could not be checked** (unreadable file, detector error, no frames), is held: it never uploads, and only its file name and reason are reported to the studio.
4. **Makes small working copies** on this Mac: a 480px card image, a 1024px analysis copy (a six-frame contact sheet for video; HDR video is converted to standard color first so the frames are not washed out), and a full-quality JPEG still for HEIC or RAW originals.
5. **Marks near-duplicates** (bursts, near-identical shots seconds apart) so the AI is not asked to describe the same moment five times.
6. **Uploads, in two phases**, straight to storage through signed links (large files never pass through the app server, and a dropped connection resumes mid-file):
   - `analysis`: the small copies plus all the metadata. The library becomes searchable and describable right away.
   - `originals`: full-quality files, 4K video included. Each file uploads only after the server's own AI safety check has cleared it.
7. **Records everything in a ledger** (`~/.contentstudio-photos/ledger.db`), so nothing uploads twice and a stopped run picks up where it left off.

Only albums you name (or all of them, if you name none) are imported. If a photo is also in an album you left out, that album's name never leaves this Mac.

## One-time setup

```bash
brew install python@3.12 ffmpeg
python3.12 -m venv ~/.venvs/photos-sync && source ~/.venvs/photos-sync/bin/activate
pip install -r tools/photos-sync/requirements.txt
```

- **System Settings > Privacy & Security > Full Disk Access**: allow Terminal (osxphotos reads the Photos database).
- **Photos > Settings > iCloud**: choose **Download Originals to this Mac**, and let it finish. Items still in iCloud only are skipped and counted.
- Export the studio password for the session (it is never written to disk): `export CONTENTSTUDIO_PASSWORD='...'`
- Keep the Mac awake while it runs: prefix commands with `caffeinate -dims`.

## Use it

```bash
cd tools/photos-sync

# 1. What would be imported? No network, nothing uploaded.
python photos_sync.py inventory --mbps 18

# 2. Screen and measure one small album, upload nothing.
python photos_sync.py run --dry-run --albums "Colosseum"

# 3. Upload that one album for real (analysis phase), into a workspace.
python photos_sync.py run --albums "Colosseum" --workspace "Conscious Creator" --phase analysis

# 4. Check the result in the app: Media Library > Albums, and the Held tab.
#    Then go in batches, newest albums first (resumes if stopped):
caffeinate -dims python photos_sync.py run --workspace "Conscious Creator" --phase analysis --batch-albums 3

# 5. On a faster connection, send the full-quality originals the same way:
caffeinate -dims python photos_sync.py run --workspace "Conscious Creator" --phase originals

python photos_sync.py status
```

`--workspace` picks the workspace whose photo library receives the files; the
tool prints it and asks you to confirm. GHR Egress Windows has its own library,
so uploads into a travel workspace never reach it. Useful options:
`--albums "A,B"`, `--exclude-albums "A,B"`, `--since 2025-01-01`,
`--max-upload-mbps 10` (leave Wi-Fi for other things), `--max-spend 2` (pilot guard: stop before the next batch once AI analysis has cost $2; every batch prints tokens and an estimated cost, tune with `--price-in`/`--price-out`), `--threshold 0.15`
(lower holds more), `--hold-covered` (also hold swimwear-level exposure).

## When something is held

- On this Mac: listed in `~/.contentstudio-photos/held-on-mac.csv` (file name, capture date, reason, Photos id). Open Photos and search by date to find it. It was never uploaded.
- By the server's AI check: its stored files are deleted, and it appears under **Media Library > Held** with the reason.
- To bring one back: **Held > Approve for next sync**, then run the tool again. It uploads as a deliberate owner override. Nothing releases on its own.

## What this does not guarantee

No detector is perfect. This is two independent checks (a local model, then the
AI check on the server) that must both pass, and anything uncertain is held. It
will hold some innocent photos (artwork, strong sun glare on skin) and, rarely,
could still miss one. Skim the Held list and the first album of each batch.

## Tests

`python tests/e2e.py` runs the whole pipeline against a running studio and a
mock bucket with synthetic images (a solid magenta frame stands in for "flagged"
so no sensitive image is ever needed): selection and exclusions, private album
names, dry run, interrupted multipart upload and resume, local and server
holds, duplicates, HEIC, byte-for-byte verification, re-run, and fail-closed
behavior. It has not been run against a real Photos library; do step 2 above on
one small album first.
