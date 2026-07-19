import { api, appState } from './api.js';
import { el, field, textInput, textArea, toast, spinner, copyBtn, copyText, download, scoreBadge, emptyState } from './ui.js';

const fieldText = (v) => (v == null ? '' : Array.isArray(v) ? v.join('\n') : String(v));

export function renderCreate(root, openPackageId = null) {
  const container = el('div', { class: 'view' });
  const profile = appState.profile;
  const form = { topic: '', angle: '', ctaUrl: '', pillarId: profile.pillars?.[0]?.id || null, seriesId: null, platforms: new Set(appState.platforms.map((p) => p.id)), mediaIds: new Set() };
  let media = [];

  const formCard = el('div', { class: 'card form-card' });
  const listWrap = el('div', {});
  const detailWrap = el('div', {});

  const drawForm = () => {
    formCard.replaceChildren(
      el('h2', {}, 'New content package'),
      field('Topic', textInput({
        placeholder: 'e.g. Is an Antarctica cruise worth the money?',
        value: form.topic, oninput: (e) => { form.topic = e.target.value; },
      }), 'Phrase it the way your audience would ask an AI assistant — that phrasing becomes your ranking target.'),
      field('Angle (optional)', textInput({
        placeholder: 'e.g. Contrarian: the cheapest cabin is the wrong buy',
        value: form.angle, oninput: (e) => { form.angle = e.target.value; },
      })),
      field('CTA link (optional)', textInput({
        placeholder: 'https://your-apply-or-booking-page.com',
        value: form.ctaUrl, oninput: (e) => { form.ctaUrl = e.target.value; },
      }), 'Every platform gets its own tracked version (utm_source per platform) so you can see exactly which channel converts.'),
      el('div', { class: 'row gap wrap' },
        field('Pillar', el('select', { class: 'input select', onchange: (e) => { form.pillarId = e.target.value || null; } },
          el('option', { value: '' }, '— none —'),
          (profile.pillars || []).map((p) => {
            const o = el('option', { value: p.id }, p.name);
            if (p.id === form.pillarId) o.selected = true;
            return o;
          }))),
        field('Series', el('select', { class: 'input select', onchange: (e) => { form.seriesId = e.target.value || null; } },
          el('option', { value: '' }, '— standalone —'),
          (profile.series || []).map((s) => el('option', { value: s.id }, s.name))))),
      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, 'Platforms'),
        el('div', { class: 'chip-row' }, appState.platforms.map((p) => {
          const chip = el('button', {
            class: `chip chip-toggle ${form.platforms.has(p.id) ? 'on' : ''}`,
            onclick: () => {
              form.platforms.has(p.id) ? form.platforms.delete(p.id) : form.platforms.add(p.id);
              chip.classList.toggle('on');
            },
          }, p.label);
          return chip;
        }))),
      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, `Attach media (${media.length} in library)`),
        media.length
          ? el('div', { class: 'mini-media-row' }, media.slice(0, 40).map((m) => {
              const img = el('img', {
                class: 'mini-thumb', src: `/api/media/${m.id}/thumb`, alt: m.alt || m.name, title: m.caption || m.name,
                onclick: () => { form.mediaIds.has(m.id) ? form.mediaIds.delete(m.id) : form.mediaIds.add(m.id); img.classList.toggle('on'); },
              });
              return img;
            }))
          : el('span', { class: 'muted' }, 'Import photos/videos in the Library and they appear here for b-roll and carousel matching.')),
      el('button', {
        class: 'btn btn-primary btn-lg', onclick: async () => {
          if (!form.topic.trim()) return toast('Give the package a topic', 'err');
          if (!form.platforms.size) return toast('Pick at least one platform', 'err');
          await runGeneration();
        },
      }, '✦ Generate package'),
    );
  };

  const runGeneration = async () => {
    const progress = el('div', {});
    formCard.append(progress);
    progress.replaceChildren(spinner('Queueing generation…'));
    try {
      const { jobId } = await api.generate({
        topic: form.topic.trim(), angle: form.angle.trim() || null,
        ctaUrl: form.ctaUrl.trim() || null,
        pillarId: form.pillarId, seriesId: form.seriesId,
        platforms: [...form.platforms], mediaIds: [...form.mediaIds],
      });
      while (true) {
        await new Promise((r) => setTimeout(r, 1800));
        const job = await api.job(jobId);
        if (job.status === 'done') {
          progress.remove();
          toast('Package ready');
          await drawList();
          openDetail(job.package.id);
          return;
        }
        if (job.status === 'error') throw new Error(job.error || 'generation failed');
        const p = job.progress || {};
        progress.replaceChildren(spinner(`Writing ${p.done || 0}/${p.total || '…'} assets — ${p.platform ? p.platform.replace(/_/g, ' ') : 'starting'}`));
      }
    } catch (err) {
      progress.remove();
      toast(err.message, 'err');
    }
  };

  const drawList = async () => {
    const { items } = await api.packages();
    listWrap.replaceChildren(
      el('div', { class: 'card' },
        el('h2', {}, 'Packages'),
        items.length
          ? el('div', { class: 'pkg-list' }, items.map((p) => el('button', { class: 'pkg-row', onclick: () => openDetail(p.id) },
              el('span', { class: 'pkg-topic' }, p.topic),
              el('span', { class: 'muted' }, `${p.platforms.length} platforms · ${new Date(p.createdAt).toLocaleDateString()}${p.mode === 'template' ? ' · template mode' : ''}`),
              scoreBadge(p.score, p.grade))))
          : emptyState('No packages yet', 'Generate your first package above — every platform, every asset, one topic.')));
  };

  const openDetail = async (id) => {
    const { package: pkg } = await api.pkg(id);
    detailWrap.replaceChildren(renderPackage(pkg, async () => {
      await api.deletePackage(pkg.id);
      detailWrap.replaceChildren();
      await drawList();
    }));
    detailWrap.scrollIntoView({ behavior: 'smooth' });
  };

  container.append(
    el('div', { class: 'view-head' },
      el('div', {},
        el('h1', {}, 'Create'),
        el('p', { class: 'sub' }, 'One topic in — a complete, platform-native, AI-visible content package out.'))),
    formCard, listWrap, detailWrap,
  );

  api.media().then(({ items }) => { media = items; drawForm(); });
  drawForm();
  drawList().then(() => { if (openPackageId) openDetail(openPackageId); });
  root.replaceChildren(container);
}

// ---- package viewer ------------------------------------------------------

function renderPackage(pkg, onDelete) {
  const specs = Object.fromEntries(appState.platforms.map((p) => [p.id, p]));
  const tabs = [
    ...Object.keys(pkg.platforms || {}).map((id) => ({ id, label: specs[id]?.label || id })),
    { id: '_visibility', label: `Visibility ${pkg.visibility ? `· ${pkg.visibility.score}` : ''}` },
    { id: '_metadata', label: 'AI Metadata' },
  ];
  let active = tabs[0]?.id;
  const body = el('div', { class: 'pkg-body' });
  const tabRow = el('div', { class: 'tab-row' });

  const drawTabs = () => {
    tabRow.replaceChildren(...tabs.map((t) => el('button', {
      class: `tab ${t.id === active ? 'active' : ''}`,
      onclick: () => { active = t.id; drawTabs(); drawBody(); },
    }, t.label)));
  };

  const drawBody = () => {
    body.replaceChildren();
    if (active === '_visibility') return body.append(visibilityTab(pkg));
    if (active === '_metadata') return body.append(metadataTab(pkg));
    const spec = specs[active];
    const asset = pkg.platforms[active];
    if (!asset) return;
    if (asset.error) body.append(el('p', { class: 'warn' }, `Fell back to template for this platform: ${asset.error}`));
    body.append(el('p', { class: 'algo-note' }, spec?.algo || ''));
    if (pkg.links?.[active]) {
      body.append(el('div', { class: 'asset-field' },
        el('div', { class: 'row spread' },
          el('span', { class: 'field-label' }, 'Tracked CTA link (replace [LINK] with this)'),
          copyBtn(pkg.links[active])),
        el('pre', { class: 'asset-value code' }, pkg.links[active])));
    }
    for (const f of spec?.fields || Object.keys(asset.fields).map((k) => ({ key: k, label: k }))) {
      const value = fieldText(asset.fields[f.key]);
      if (!value) continue;
      body.append(el('div', { class: 'asset-field' },
        el('div', { class: 'row spread' },
          el('span', { class: 'field-label' }, f.label),
          el('div', { class: 'row gap' },
            el('span', { class: 'muted char-count' }, `${value.length} chars`),
            copyBtn(value))),
        el('pre', { class: 'asset-value' }, value)));
    }
    const script = fieldText(asset.fields.script || asset.fields.article || asset.fields.post);
    if (script.length > 100) {
      body.append(el('div', { class: 'row gap' },
        el('button', {
          class: 'btn btn-ghost btn-xs',
          onclick: () => { sessionStorage.setItem('cs-script', script); location.hash = '#/voice-studio'; },
        }, '🎙 Narrate in Voice Studio'),
        el('button', {
          class: 'btn btn-ghost btn-xs',
          onclick: () => { sessionStorage.setItem('cs-script', script); location.hash = '#/avatar-studio'; },
        }, '🧑‍💻 Film with Avatar')));
    }
  };

  drawTabs();
  drawBody();

  return el('div', { class: 'card pkg-detail' },
    el('div', { class: 'row spread' },
      el('div', {},
        el('h2', {}, pkg.topic),
        el('p', { class: 'muted' }, `${new Date(pkg.createdAt).toLocaleString()}${pkg.mode === 'template' ? ' · template mode (add Claude key for full AI writing)' : ''}`)),
      el('div', { class: 'row gap' },
        pkg.visibility ? scoreBadge(pkg.visibility.score, pkg.visibility.grade) : null,
        el('button', { class: 'btn btn-ghost btn-xs', onclick: () => download(`package-${pkg.id}.md`, packageMarkdown(pkg), 'text/markdown') }, '⬇ Publish kit (.md)'),
        el('button', { class: 'btn btn-ghost btn-xs', onclick: () => download(`website-kit-${pkg.id}.md`, websiteKit(pkg), 'text/markdown') }, '⬇ Website kit (Lovable)'),
        el('button', { class: 'btn btn-ghost btn-xs', onclick: () => download(`package-${pkg.id}.json`, JSON.stringify(pkg, null, 2), 'application/json') }, '⬇ JSON'),
        el('button', { class: 'btn btn-danger btn-xs', onclick: onDelete }, 'Delete'))),
    pkg.quotable ? el('blockquote', { class: 'sample' }, `“${pkg.quotable}”`) : null,
    tabRow, body);
}

function visibilityTab(pkg) {
  const v = pkg.visibility;
  if (!v) return el('p', {}, 'Not scored.');
  return el('div', {},
    el('div', { class: 'score-hero' },
      el('div', { class: 'score-num' }, String(v.score)),
      el('div', {},
        el('strong', {}, v.grade),
        el('p', { class: 'muted' }, 'E-E-A-T-V rubric: experience, expertise, authority, trust + AI-answer readiness.'))),
    el('div', { class: 'check-list' }, v.checks.map((c) => el('div', { class: `check ${c.pass ? 'pass' : 'fail'}` },
      el('span', { class: 'check-mark' }, c.pass ? '✓' : '✗'),
      el('div', {},
        el('span', {}, c.label),
        c.fix ? el('p', { class: 'fix' }, c.fix) : null)))));
}

function metadataTab(pkg) {
  const jsonldText = Object.entries(pkg.jsonld || {})
    .map(([k, v]) => `<!-- ${k} -->\n<script type="application/ld+json">\n${JSON.stringify(v, null, 2)}\n</script>`)
    .join('\n\n');
  return el('div', {},
    pkg.definition ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'Your definition (own the answer)'), copyBtn(pkg.definition)),
      el('blockquote', { class: 'sample' }, pkg.definition)) : null,
    (pkg.citeLines || []).length ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'Attribution-ready claim lines'), copyBtn(pkg.citeLines.join('\n'))),
      el('ul', { class: 'plain-list' }, pkg.citeLines.map((c) => el('li', {}, c)))) : null,
    (pkg.queryMap || []).length ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'Query map (phrasings this package should win)'), copyBtn(pkg.queryMap.join('\n'))),
      el('div', { class: 'chip-row' }, pkg.queryMap.map((q) => el('span', { class: 'chip' }, q)))) : null,
    Object.keys(pkg.links || {}).length ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'Tracked CTA links (one per platform)'), copyBtn(Object.entries(pkg.links).map(([k, v]) => `${k}: ${v}`).join('\n'))),
      el('ul', { class: 'plain-list' }, Object.entries(pkg.links).map(([k, v]) => el('li', {}, `${k} → ${v}`)))) : null,
    (pkg.faq || []).length ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'FAQ (AI-answer layer)'), copyBtn(pkg.faq.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n\n'))),
      pkg.faq.map((f) => el('div', { class: 'faq-pair' }, el('strong', {}, f.q), el('p', {}, f.a)))) : null,
    pkg.keywords?.length ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'Keywords & retrieval phrases'), copyBtn(pkg.keywords.join(', '))),
      el('div', { class: 'chip-row' }, pkg.keywords.map((k) => el('span', { class: 'chip' }, k)))) : null,
    pkg.entities?.length ? el('div', { class: 'asset-field' },
      el('span', { class: 'field-label' }, 'Entities to reinforce'),
      el('div', { class: 'chip-row' }, pkg.entities.map((k) => el('span', { class: 'chip chip-entity' }, k)))) : null,
    Object.keys(pkg.altTexts || {}).length ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' }, el('span', { class: 'field-label' }, 'Alt text for attached media'), copyBtn(Object.values(pkg.altTexts).join('\n'))),
      el('ul', { class: 'plain-list' }, Object.entries(pkg.altTexts).map(([id, alt]) => el('li', {}, alt)))) : null,
    jsonldText ? el('div', { class: 'asset-field' },
      el('div', { class: 'row spread' },
        el('span', { class: 'field-label' }, 'Schema.org JSON-LD (paste into your site <head>)'),
        el('div', { class: 'row gap' },
          copyBtn(jsonldText, 'Copy'),
          el('button', { class: 'btn btn-ghost btn-xs', onclick: () => download(`jsonld-${pkg.id}.html`, jsonldText, 'text/html') }, '⬇'))),
      el('pre', { class: 'asset-value code' }, jsonldText)) : null,
    el('div', { class: 'asset-field' },
      el('span', { class: 'field-label' }, 'llms.txt'),
      el('p', { class: 'muted' }, 'Your studio serves a live llms.txt for AI crawlers — publish its contents at yourdomain.com/llms.txt.'),
      el('a', { class: 'btn btn-ghost btn-xs', href: '/llms.txt', target: '_blank' }, 'Open /llms.txt')));
}

export function websiteKit(pkg, profile) {
  const li = pkg.platforms?.linkedin?.fields || {};
  const yt = pkg.platforms?.youtube_long?.fields || {};
  const title = fieldText(li.article_title) || pkg.topic;
  const slug = pkg.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const metaDesc = (pkg.faq?.[0]?.a || fieldText(li.article)).replace(/[#*\n]+/g, ' ').trim().slice(0, 155);
  const jsonld = Object.values(pkg.jsonld || {})
    .map((v) => `<script type="application/ld+json">\n${JSON.stringify(v, null, 2)}\n</script>`)
    .join('\n');
  const altList = Object.values(pkg.altTexts || {});
  return `# Website Kit — paste this whole prompt into Lovable

Add a new article page to my site at /${slug}

Page requirements:
- Meta title: "${title}" (trim to 60 chars if longer)
- Meta description: "${metaDesc}"
- Render the article below preserving its heading hierarchy exactly (the # line is the page H1, ## lines are H2 sections, ### are H3). Readable column width, generous spacing.
${fieldText(yt.title) ? `- Embed my YouTube video "${fieldText(yt.title)}" [FILL: paste YouTube URL after upload] above the article body.\n` : ''}- Keep the FAQ section as an accordion or clearly separated Q&A block.
- Insert the JSON-LD below into the page <head> exactly as provided — do not modify it.
- End the page with one CTA button: [FILL: CTA label + URL].
- Add the page to the sitemap and link it from the articles/blog index.
${altList.length ? `- Article images use these alt texts (match to the images I upload): ${altList.map((a) => `"${a}"`).join('; ')}\n` : ''}
---

ARTICLE (markdown — paste as page content):

${fieldText(li.article) || '[FILL: generate the LinkedIn article in this package first — it doubles as the site article]'}

---

JSON-LD for the page <head>:

\`\`\`html
${jsonld || '<!-- rescore the package to build schema -->'}
\`\`\`
`;
}

function packageMarkdown(pkg) {
  const specs = Object.fromEntries(appState.platforms.map((p) => [p.id, p]));
  const lines = [`# ${pkg.topic}`, '', `Generated ${pkg.createdAt} · Visibility ${pkg.visibility?.score ?? '–'} (${pkg.visibility?.grade ?? ''})`, ''];
  if (pkg.quotable) lines.push(`> ${pkg.quotable}`, '');
  for (const [id, asset] of Object.entries(pkg.platforms || {})) {
    lines.push(`## ${specs[id]?.label || id}`, '');
    for (const [key, value] of Object.entries(asset.fields || {})) {
      const label = specs[id]?.fields?.find((f) => f.key === key)?.label || key;
      lines.push(`### ${label}`, '', fieldText(value), '');
    }
  }
  if (pkg.faq?.length) {
    lines.push('## FAQ (AI-answer layer)', '');
    for (const f of pkg.faq) lines.push(`**${f.q}**`, '', f.a, '');
  }
  if (pkg.keywords?.length) lines.push('## Keywords', '', pkg.keywords.join(', '), '');
  if (Object.keys(pkg.altTexts || {}).length) lines.push('## Alt text', '', ...Object.values(pkg.altTexts).map((a) => `- ${a}`), '');
  if (pkg.jsonld) lines.push('## JSON-LD', '', '```html', ...Object.values(pkg.jsonld).map((v) => `<script type="application/ld+json">\n${JSON.stringify(v, null, 2)}\n</script>`), '```', '');
  return lines.join('\n');
}
