// Quarantine for unsafe or unscreened media. The design rule is fail-closed:
//   - a new item is 'pending' and invisible to selection, rendering and
//     publishing until a clean safety verdict arrives ('clear')
//   - a flagged item is 'held': every stored byte (thumb, analysis frame,
//     render still, original, preview) is deleted from the bucket, the disk
//     and the cache, and the record keeps only a tombstone (id, filename,
//     capture date, reason) so a re-sync never re-uploads it
//   - nothing ever releases itself: only an explicit release by the owner,
//     and a release only marks the tombstone approved so the next sync
//     uploads it again as a deliberate override
// Items that predate screening carry no moderation record and stay usable
// (they were curated by hand before this existed); POST /api/moderation/scan
// can safety-check them in bulk.

import { catalog } from './store.js';
import { removeMedia } from './media.js';
import { parseSafety } from './engine.js';

const now = () => new Date().toISOString();

export function pendingModeration(local = null) {
  return { status: 'pending', ...(local ? { local } : {}), at: now() };
}

export async function holdItem(item, { reason, source }) {
  await removeMedia(item);
  catalog.patch(item.id, {
    moderation: { status: 'held', reason: String(reason || 'flagged').slice(0, 200), source, at: now() },
    alt: null, caption: null, keywords: [], place: null, storyIdeas: [], quality: null,
    gps: null, albums: [], apple: null, r2: {}, hasOriginal: false, analyzed: false,
  });
  return catalog.byId(item.id);
}

// Applies a parsed analysis result to an item. Returns {held, status}.
export async function applyAnalysis(item, result, { source = 'claude' } = {}) {
  const verdict = parseSafety(result);
  const overridden = item.moderation?.override === true;
  if (verdict.status === 'held' && !overridden) {
    await holdItem(item, { reason: verdict.reason, source });
    return { held: true, status: 'held', reason: verdict.reason };
  }
  const patch = {
    alt: result.alt || item.alt,
    caption: result.caption || item.caption,
    keywords: result.keywords || [],
    place: item.place || result.place || null,
    quality: result.quality || null,
    storyIdeas: result.storyIdeas || [],
    analyzed: true,
  };
  if (verdict.status === 'clear' || overridden) {
    const by = [item.moderation?.local ? 'local' : null, overridden ? 'owner-release' : source].filter(Boolean);
    patch.moderation = { status: 'clear', by, at: now() };
  }
  // 'unknown' (no usable safety field) deliberately leaves a pending item
  // pending, and leaves a legacy item exactly as it was.
  catalog.patch(item.id, patch);
  return { held: false, status: patch.moderation?.status || item.moderation?.status || 'legacy' };
}

export function moderationCounts(library) {
  let held = 0; let pending = 0;
  for (const i of catalog.inLibrary(library)) {
    if (i.moderation?.status === 'held') held += 1;
    else if (i.moderation?.status === 'pending') pending += 1;
  }
  return { held, pending };
}

// The owner's private review list: metadata only, never an image.
export function heldList() {
  return catalog.inLibrary().filter((i) => i.moderation?.status === 'held').map((i) => ({
    id: i.id, name: i.name, kind: i.kind, takenAt: i.takenAt || null, photosUuid: i.photosUuid || null,
    reason: i.moderation.reason, source: i.moderation.source, at: i.moderation.at,
    releaseApproved: i.moderation.release === 'approved',
  }));
}

// A release cannot restore bytes that were deleted, so it marks the tombstone
// approved: the next sync run uploads the file again and the item comes back
// as 'clear' with the owner's override recorded.
export function approveRelease(id) {
  const item = catalog.mine(id);
  if (!item || item.moderation?.status !== 'held') return null;
  catalog.patch(id, { moderation: { ...item.moderation, release: 'approved', releasedAt: now() } });
  return catalog.byId(id);
}

export function revokeRelease(id) {
  const item = catalog.mine(id);
  if (!item || item.moderation?.status !== 'held') return null;
  const { release, releasedAt, ...rest } = item.moderation;
  catalog.patch(id, { moderation: rest });
  return catalog.byId(id);
}

// Status of each attached media id for a package: 'clear' (screened),
// 'legacy' (predates screening), 'pending', 'held', or 'missing' (deleted).
// Publishing only ever treats 'clear' and 'legacy' as usable.
export function mediaStatusFor(ids) {
  const out = {};
  for (const id of ids || []) {
    const item = catalog.byId(id);
    out[id] = !item ? 'missing' : (item.moderation?.status || 'legacy');
  }
  return out;
}
