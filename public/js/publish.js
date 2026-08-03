// Publish Run: one page per package listing ONLY the approved platform
// assets, in posting order, each with its composer deep link, the exact
// final field text, the media files to attach, and a live-URL capture box
// that writes the published registry (llms.txt, JSON-LD, cross_surface)
// the moment a post goes live. Designed to be read by Claude in Chrome as
// a work order: the instruction block tells it to fill composers verbatim
// and always stop short of posting, so the creator keeps the final click.

import { api, appState } from './api.js';
import { el, toast, spinner, copyBtn, emptyState } from './ui.js';

const fieldText = (v) => (v == null ? '' : Array.isArray(v) ? v.join('\n') : String(v));

// Day-one posting order: the long-form anchor first, the fast social
// surfaces next, local and owned surfaces after.
const POST_ORDER = ['youtube_long', 'linkedin', 'instagram_reel', 'youtube_shorts', 'tiktok',
  'instagram_carousel', 'facebook', 'x_thread', 'pinterest', 'gbp', 'bing', 'alignable', 'newsletter', 'reddit'];

const COMPOSERS = {
  youtube_long: 'https://studio.youtube.com',
  youtube_shorts: 'https://studio.youtube.com',
  instagram_reel: 'https://www.instagram.com/create/select/',
  instagram_carousel: 'https://www.instagram.com/create/select/',
  tiktok: 'https://www.tiktok.com/tiktokstudio/upload',
  facebook: 'https://www.facebook.com/',
  x_thread: 'https://x.com/compose/post',
  linkedin: 'https://www.linkedin.com/feed/?shareActive=true',
  gbp: 'https://business.google.com/',
  alignable: 'https://www.alignable.com/',
  pinterest: 'https://www.pinterest.com/pin-creation-tool/',
  reddit: 'https://www.reddit.com/submit',
  bing: 'https://www.bingplaces.com/',
  newsletter: null,
};

const EXTENSION_INSTRUCTION = `You are helping me publish approved content from my ContentStudio Publish Run page (the tab this instruction came from). Work one platform card at a time, top to bottom, skipping any card marked posted.

For the current card:
1. Open its composer link in a new tab.
2. Fill every field exactly as written on the card: titles, descriptions, captions, tags, alt text. Copy verbatim. Never rewrite, shorten, or add hashtags. Fields map by their labels.
3. If the card lists a media file, tell me the exact file name to attach from my Downloads and wait while I attach it. Do not try to operate the file picker.
4. NEVER click Post, Publish, Share, or Schedule. When the post is fully prepared, stop and tell me it is ready for my review.
5. After I post it myself, I will paste the live URL into the card. Then move to the next card.`;

export function renderPublish(root, params = null) {
  const pkgId = params?.get?.('pkg') || sessionStorage.getItem('cs-last-pkg') || null;
  const container = el('div', { class: 'view' });
  root.replaceChildren(container);
  if (!pkgId) {
    container.append(emptyState('No package selected', 'Open a package in Create, approve its platforms, then come back here.'));
    return;
  }
  container.append(spinner('Loading the publish run…'));
  draw(container, pkgId).catch((err) => {
    container.replaceChildren(emptyState('Could not load the package', err.message));
  });
}

async function draw(container, pkgId) {
  const [{ package: pkg }, renders] = await Promise.all([
    api.pkg(pkgId),
    api.packageRenders(pkgId).then((r) => r.items).catch(() => []),
  ]);
  const specs = Object.fromEntries(appState.platforms.map((p) => [p.id, p]));
  const brand = appState.profile?.business?.name || 'this brand';
  const approvedIds = POST_ORDER.filter((id) => pkg.approvals?.[id]?.approved && pkg.platforms?.[id]);
  const extras = Object.keys(pkg.platforms || {}).filter((id) => pkg.approvals?.[id]?.approved && !POST_ORDER.includes(id));
  const ordered = [...approvedIds, ...extras];

  const cards = el('div', {});
  const drawCards = () => {
    cards.replaceChildren(...ordered.map((id) => platformCard(pkg, id, specs[id], renders, drawCards)));
  };

  container.replaceChildren(
    el('div', { class: 'view-head' },
      el('div', {},
        el('h1', {}, 'Publish Run'),
        el('p', { class: 'sub' }, `${pkg.topic} · ${brand} · ${ordered.length} approved platform${ordered.length === 1 ? '' : 's'}`)),
      el('a', { class: 'btn btn-ghost btn-xs', href: `#/create?pkg=${pkg.id}` }, '← Back to the package')),
    el('div', { class: 'card' },
      el('div', { class: 'row spread' },
        el('span', { class: 'field-label' }, 'Instruction for Claude in Chrome (copy once per session)'),
        copyBtn(EXTENSION_INSTRUCTION)),
      el('p', { class: 'muted', style: 'margin:6px 0 0' },
        'Paste this into the Claude browser extension with this page open. It fills each composer verbatim and always stops before posting, so every post ships only after your click.')),
    ordered.length ? cards : el('div', { class: 'card' },
      emptyState('Nothing approved yet', 'Approve platforms on the package (the Approve toggle on each tab) and they appear here in posting order.')),
  );
  drawCards();
}

function mediaLinks(pkg, platformId, spec, renders) {
  const links = [];
  const slug = (pkg.topic || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (spec?.group === 'video') {
    const done = renders.filter((r) => r.platformId === platformId && (r.status || 'done') === 'done');
    if (done[0]) {
      links.push({ label: `⬇ ${slug}-${platformId}.mp4 (upload master)`, href: `/api/render/${done[0].id}/video`, download: `${slug}-${platformId}.mp4` });
      links.push({ label: '⬇ captions .srt', href: `/api/render/${done[0].id}/srt`, download: `${slug}.srt` });
    } else {
      links.push({ label: 'No finished render yet: produce the video first', href: null });
    }
  }
  if (platformId === 'instagram_carousel' && pkg.carouselPlan?.slides?.length) {
    for (const s of pkg.carouselPlan.slides) {
      links.push({ label: `⬇ slide ${s.n} image`, href: `/api/media/${s.mediaId}/file`, download: `slide-${s.n}.jpg` });
    }
  }
  return links;
}

function platformCard(pkg, platformId, spec, renders, refresh) {
  const posted = pkg.publishedUrls?.[platformId] || null;
  const media = mediaLinks(pkg, platformId, spec, renders);
  const fields = [];
  for (const f of spec?.fields || []) {
    const value = fieldText(pkg.platforms[platformId]?.fields?.[f.key]);
    if (!value) continue;
    fields.push(el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' },
        el('span', { class: 'field-label' }, f.label),
        copyBtn(value)),
      el('pre', { class: 'asset-value' }, value)));
  }
  if (pkg.links?.[platformId]) {
    fields.push(el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' },
        el('span', { class: 'field-label' }, 'Tracked CTA link (replaces [LINK])'),
        copyBtn(pkg.links[platformId])),
      el('pre', { class: 'asset-value code' }, pkg.links[platformId])));
  }

  const urlInput = el('input', {
    class: 'input', type: 'text', style: 'flex:1;min-width:220px',
    placeholder: 'Paste the live URL here after you post', value: posted || '',
  });
  const saveBtn = el('button', {
    class: 'btn btn-primary btn-xs', onclick: async () => {
      try {
        const { package: updated } = await api.setPublishedUrl(pkg.id, platformId, urlInput.value.trim());
        Object.assign(pkg, updated);
        toast('Live URL registered · llms.txt and schema updated');
        refresh();
      } catch (err) { toast(err.message, 'err'); }
    },
  }, 'Mark posted');

  return el('div', { class: 'card' },
    el('div', { class: 'row spread' },
      el('h2', {}, `${posted ? '✅' : '◻'} ${spec?.label || platformId}`),
      el('div', { class: 'row gap' },
        COMPOSERS[platformId]
          ? el('a', { class: 'btn btn-ghost btn-xs', href: COMPOSERS[platformId], target: '_blank', rel: 'noopener' }, '↗ Open composer')
          : el('span', { class: 'muted' }, 'post from your email tool'))),
    posted ? el('p', { class: 'muted' }, `Live: ${posted}`) : null,
    media.length ? el('div', { class: 'asset-field' },
      el('span', { class: 'field-label' }, 'Media to attach (download first, then attach in the composer)'),
      el('div', { class: 'row gap wrap', style: 'margin-top:6px' },
        media.map((m) => m.href
          ? el('a', { class: 'btn btn-ghost btn-xs', href: m.href, download: m.download }, m.label)
          : el('span', { class: 'warn' }, m.label)))) : null,
    ...fields,
    el('div', { class: 'asset-field' },
      el('span', { class: 'field-label' }, posted ? 'Update the live URL' : 'After posting'),
      el('div', { class: 'row gap', style: 'margin-top:6px' }, urlInput, saveBtn)));
}
