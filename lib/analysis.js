// Library-wide analysis queue: reads each item's analysis copy (a small
// image, or a contact sheet of frames for video), asks Claude for alt text,
// keywords, place, quality, story ideas and the safety verdict, and applies
// the result. Newest captures first; bounded concurrency; stops by itself if
// the provider keeps failing so a bad key cannot burn through the library.

import { catalog, albumStore } from './store.js';
import { readMedia, hasStored } from './media.js';
import { analyzeMedia, checkSafety } from './engine.js';
import { applyAnalysis, holdItem } from './moderation.js';
import { providerStatus, ProviderError } from './providers.js';

export const analysisState = {
  running: false, total: 0, done: 0, held: 0, failed: 0, stopped: null,
  startedAt: null, finishedAt: null, errors: [],
};

const analyzable = (i, includeDuplicates = false) =>
  i.moderation?.status !== 'held' && !i.analyzed && (includeDuplicates || !i.dupOf) && (hasStored(i, 'analysis') || hasStored(i, 'thumb'));

// Rough size of the job before it runs: counts plus an order-of-magnitude
// token figure (about 1.6k input and 0.4k output tokens per item). It states
// tokens and not dollars because pricing is the provider's to publish.
export function estimateAnalysis(library, includeDuplicates = false) {
  const todo = catalog.inLibrary(library).filter((i) => analyzable(i, includeDuplicates));
  return { items: todo.length, approxInputTokens: todo.length * 1600, approxOutputTokens: todo.length * 400 };
}

export async function runAnalysis({ profile, library, limit = Infinity, concurrency = 3, includeDuplicates = false }) {
  if (analysisState.running) throw new Error('analysis is already running');
  if (!providerStatus().anthropic) throw new Error('no Claude key configured');
  Object.assign(analysisState, {
    running: true, total: 0, done: 0, held: 0, failed: 0, stopped: null, errors: [],
    startedAt: new Date().toISOString(), finishedAt: null,
  });
  const albumNames = new Map(albumStore.inLibrary(library).map((a) => [a.id, a.name]));
  try {
    const todo = catalog.inLibrary(library).filter((i) => analyzable(i, includeDuplicates))
      .sort((a, b) => (b.takenAt || '').localeCompare(a.takenAt || ''))
      .slice(0, limit);
    analysisState.total = todo.length;
    let next = 0;
    let consecutiveFailures = 0;
    const worker = async () => {
      while (next < todo.length && !analysisState.stopped) {
        const item = todo[next++];
        try {
          const buf = (await readMedia(item, 'analysis')) || (await readMedia(item, 'thumb'));
          if (!buf) throw new Error('no analysis image stored');
          const result = await analyzeMedia({
            b64: buf.toString('base64'), name: item.name, kind: item.kind, takenAt: item.takenAt,
            profile, frames: item.videoMeta?.frames || null,
            context: {
              albums: (item.albums || []).map((id) => albumNames.get(id)).filter(Boolean),
              title: item.apple?.title, description: item.apple?.description,
              place: item.apple?.place, labels: item.apple?.labels, keywords: item.apple?.keywords,
            },
          });
          const out = await applyAnalysis(item, result);
          if (out.held) analysisState.held += 1;
          consecutiveFailures = 0;
        } catch (err) {
          analysisState.failed += 1;
          consecutiveFailures += 1;
          if (analysisState.errors.length < 20) analysisState.errors.push({ id: item.id, error: String(err.message || err).slice(0, 160) });
          if (err instanceof ProviderError && err.status === 401) analysisState.stopped = 'Claude rejected the key (401)';
          else if (consecutiveFailures >= 8) analysisState.stopped = 'stopped after 8 failures in a row';
          else if (err instanceof ProviderError && err.status === 429) await new Promise((r) => setTimeout(r, 15000));
        }
        analysisState.done += 1;
        if (analysisState.done % 50 === 0) catalog.flush();
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    catalog.flush();
  } finally {
    analysisState.running = false;
    analysisState.finishedAt = new Date().toISOString();
  }
  return { ...analysisState };
}

// Safety-only pass over items that predate screening (no moderation record).
// A clean verdict stamps them 'clear'; a flag holds them like any other item;
// an inconclusive reply leaves them exactly as they were.
export const scanState = { running: false, total: 0, done: 0, held: 0, cleared: 0, failed: 0, startedAt: null, finishedAt: null };

export async function runSafetyScan({ library, limit = Infinity, concurrency = 3 }) {
  if (scanState.running) throw new Error('a safety scan is already running');
  if (!providerStatus().anthropic) throw new Error('no Claude key configured');
  Object.assign(scanState, { running: true, total: 0, done: 0, held: 0, cleared: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null });
  try {
    const todo = catalog.inLibrary(library)
      .filter((i) => !i.moderation && (hasStored(i, 'analysis') || hasStored(i, 'thumb')))
      .slice(0, limit);
    scanState.total = todo.length;
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const item = todo[next++];
        try {
          const buf = (await readMedia(item, 'analysis')) || (await readMedia(item, 'thumb'));
          const verdict = await checkSafety({ b64: buf.toString('base64'), name: item.name });
          if (verdict.status === 'held') { await holdItem(item, { reason: verdict.reason, source: 'claude-scan' }); scanState.held += 1; }
          else if (verdict.status === 'clear') {
            catalog.patch(item.id, { moderation: { status: 'clear', by: ['claude-scan'], at: new Date().toISOString() } });
            scanState.cleared += 1;
          }
        } catch { scanState.failed += 1; }
        scanState.done += 1;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    catalog.flush();
  } finally {
    scanState.running = false;
    scanState.finishedAt = new Date().toISOString();
  }
  return { ...scanState };
}
