import { api, appState } from './api.js';
import { el, field, textInput, textArea, toast, spinner, readFileAsText, emptyState } from './ui.js';

// Hints may be functions of the answers so far, letting examples follow the
// industry declared in section 1 instead of showing cross-industry samples.
const byIndustry = (variants, fallback) => (answers) => {
  for (const source of [answers.industry, answers.niche]) {
    const hay = (source || '').toLowerCase();
    if (!hay) continue;
    for (const [keyword, text] of variants) {
      if (hay.includes(keyword)) return text;
    }
  }
  return fallback;
};

const SECTIONS = [
  {
    id: 'identity', title: 'Who you are',
    intro: 'Entity clarity is the foundation of AI visibility — assistants can only recommend what they can unambiguously identify.',
    business: true,
    questions: [
      { key: 'name', label: 'Business name', input: 'text' },
      { key: 'tagline', label: 'One-line tagline', input: 'text' },
      { key: 'personName', label: 'Your name (the face of the content)', input: 'text' },
      { key: 'personTitle', label: 'Your title', input: 'text', hint: 'e.g. Founder & Luxury Travel Advisor' },
      { key: 'credentials', label: 'Credentials & lived experience', input: 'area', hint: 'Years, certifications, places been, results delivered — real and verifiable only' },
      { key: 'industry', label: 'Industry', input: 'text' },
      { key: 'niche', label: 'Specific niche', input: 'text', hint: 'The narrower the niche, the easier to become THE cited answer' },
      { key: 'location', label: 'City / region', input: 'text', hint: 'Feeds local AI answers (Google, Copilot, Maps)' },
      { key: 'phone', label: 'Business phone', input: 'text', hint: 'Must read identically here, on GBP, and on Bing Places — inconsistent NAP data undermines local ranking' },
      { key: 'audience', label: 'Who you serve', input: 'area' },
      { key: 'offers', label: 'What you sell / offer', input: 'area' },
      { key: 'website', label: 'Website URL', input: 'text' },
      { key: 'youtube', label: 'YouTube URL', input: 'text' },
      { key: 'instagram', label: 'Instagram URL', input: 'text' },
      { key: 'gbp', label: 'Google Business Profile URL', input: 'text' },
      { key: 'legalName', label: 'Registered legal name (optional)', input: 'text', hint: 'Exactly as filed, for example "Travel GHR LLC". Google reads this as the registered name when it differs from the name above.' },
      { key: 'alternateNames', label: 'Trade names / DBAs (optional)', input: 'text', hint: 'Comma separated, exactly as filed. A DBA is another name the same company goes by.' },
      { key: 'parentOrgName', label: 'Parent company (only if this brand is a DBA or division)', input: 'text', hint: 'The legal entity this brand operates under.' },
      { key: 'parentOrgUrl', label: 'Parent company website', input: 'text', hint: 'Full URL. Needed together with the parent name.' },
      { key: 'personHomeUrl', label: 'Canonical home for your personal profile (optional)', input: 'text', hint: 'One site hosts your Person entity so every brand points to the same one, never a second copy per site. Example: your main business site.' },
      { key: 'metaPixelId', label: 'Meta Pixel ID (optional)', input: 'text', hint: 'Digits only, from Events Manager. One pixel per brand keeps audiences separate. Used by the Site setup kit; nothing is installed until you paste that kit into your site.' },
      { key: 'neverMention', label: 'Never mention (hard blocklist)', input: 'text', hint: 'Comma-separated names/terms that must NEVER appear in any generated content — enforced in every generation and checked by the visibility score' },
    ],
  },
  {
    id: 'goals', title: 'Storytelling goals',
    intro: 'What should the machines say about you when you are not in the room?',
    questions: [
      { key: 'goal_known_for', label: 'When someone asks ChatGPT or Gemini about your field, what do you want the answer to say about you?', input: 'area' },
      { key: 'goal_outcomes', label: 'What business outcome should this content drive in the next 90 days?', input: 'area', hint: 'Calls booked, listings won, trips sold — be specific' },
      { key: 'goal_feeling', label: 'When someone binges 5 of your posts, what should they feel about you?', input: 'area' },
    ],
  },
  {
    id: 'story', title: 'Your signature story',
    intro: 'Every piece of content will ladder back to one core arc. Let\'s find it.',
    questions: [
      { key: 'story_turning_point', label: 'The turning point: what moment put you on this path?', input: 'area', hint: 'A scene, not a summary — where were you, what changed' },
      { key: 'story_hardest_win', label: 'The hardest problem you ever solved for a client (and what it took)', input: 'area' },
      { key: 'story_misunderstood', label: 'What does everyone get wrong about your industry?', input: 'area', hint: 'This becomes your contrarian content engine' },
      { key: 'story_moment', label: 'A sensory moment you keep coming back to', input: 'area',
        hint: byIndustry([
          ['travel', 'The 6 a.m. coffee on deck as the fjord turns pink, the client\'s face at the gate…'],
          ['real estate', 'The keys in a first-time buyer\'s hand, the sold sign going up at dusk…'],
          ['food', 'The first table of the night, the sauce coming together at the last second…'],
        ], 'A specific scene you can see, hear, and feel when you close your eyes') },
    ],
  },
  {
    id: 'proof', title: 'Proof & experience inventory',
    intro: 'The first E in E-E-A-T is Experience. AI engines reward verifiable, first-person proof.',
    questions: [
      { key: 'proof_numbers', label: 'Your numbers', input: 'area',
        hint: byIndustry([
          ['travel', 'Years planning travel, trips sold, countries visited, ships sailed, clients served — anything countable'],
          ['real estate', 'Years licensed, homes closed, volume sold, average days on market — anything countable'],
        ], 'Years in the field, clients served, results delivered — anything countable') },
      { key: 'proof_places', label: 'Where you\'ve actually been / what you\'ve actually done first-hand', input: 'area' },
      { key: 'proof_results', label: '2-3 client results you can tell as stories', input: 'area' },
      { key: 'proof_access', label: 'Access others don\'t have', input: 'area', hint: 'Supplier relationships, data, communities, tools' },
    ],
  },
  {
    id: 'audience', title: 'Audience truth',
    intro: 'Content that ranks is content that answers what people actually ask.',
    questions: [
      { key: 'audience_dream', label: 'Describe your dream client as a person', input: 'area' },
      { key: 'audience_fear', label: 'What do they fear more than spending money?', input: 'area' },
      { key: 'audience_questions', label: 'The 5+ questions they ALWAYS ask you', input: 'area', hint: 'Write them exactly as people say them — these become FAQ schema and AI-answer targets' },
      { key: 'audience_objection', label: 'The #1 objection before they buy', input: 'area' },
    ],
  },
  {
    id: 'voice', title: 'Voice fingerprint',
    intro: 'The Voice DNA page can learn from your writing; these answers calibrate it.',
    questions: [
      { key: 'voice_adjectives', label: '3-5 adjectives for how you talk', input: 'text' },
      { key: 'voice_phrases', label: 'Phrases you actually say all the time', input: 'area' },
      { key: 'voice_never', label: 'Words / vibes you would never use', input: 'area' },
    ],
  },
  {
    id: 'reality', title: 'Production reality',
    intro: 'The best system is the one you\'ll actually sustain.',
    questions: [
      { key: 'reality_time', label: 'Hours per week you can give content', input: 'text' },
      { key: 'reality_camera', label: 'Comfort on camera (1-10) and preferred formats', input: 'text' },
      { key: 'reality_channels', label: 'Channels already active + roughly how they perform', input: 'area' },
    ],
  },
];

function businessFromAnswers(a) {
  return {
    name: a.name || '', tagline: a.tagline || '', industry: a.industry || '',
    niche: a.niche || '', location: a.location || '', phone: a.phone || '', audience: a.audience || '',
    offers: a.offers || '', localBusiness: true,
    metaPixelId: String(a.metaPixelId || '').replace(/\D/g, ''),
    legalName: (a.legalName || '').trim(),
    alternateNames: String(a.alternateNames || '').split(',').map((x) => x.trim()).filter(Boolean),
    parentOrgName: (a.parentOrgName || '').trim(), parentOrgUrl: (a.parentOrgUrl || '').trim(),
    personHomeUrl: (a.personHomeUrl || '').trim(),
    neverMention: (a.neverMention || '').split(',').map((s) => s.trim()).filter(Boolean),
    person: { name: a.personName || '', title: a.personTitle || '', credentials: a.credentials || '', sameAs: [a.youtube, a.instagram, a.gbp].filter(Boolean) },
    links: { website: a.website || '', youtube: a.youtube || '', instagram: a.instagram || '', gbp: a.gbp || '' },
  };
}

export function renderInterview(root) {
  const answers = { ...(appState.profile.interview?.answers || {}) };
  const biz = appState.profile.business || {};
  Object.assign(answers, {
    name: answers.name ?? biz.name, tagline: answers.tagline ?? biz.tagline,
    personName: answers.personName ?? biz.person?.name, personTitle: answers.personTitle ?? biz.person?.title,
    credentials: answers.credentials ?? biz.person?.credentials,
    industry: answers.industry ?? biz.industry, niche: answers.niche ?? biz.niche,
    location: answers.location ?? biz.location, phone: answers.phone ?? biz.phone, audience: answers.audience ?? biz.audience,
    offers: answers.offers ?? biz.offers, metaPixelId: answers.metaPixelId ?? biz.metaPixelId,
    legalName: answers.legalName ?? biz.legalName, alternateNames: answers.alternateNames ?? (biz.alternateNames || []).join(', '),
    parentOrgName: answers.parentOrgName ?? biz.parentOrgName, parentOrgUrl: answers.parentOrgUrl ?? biz.parentOrgUrl,
    personHomeUrl: answers.personHomeUrl ?? biz.personHomeUrl,
    website: answers.website ?? biz.links?.website, youtube: answers.youtube ?? biz.links?.youtube,
    instagram: answers.instagram ?? biz.links?.instagram, gbp: answers.gbp ?? biz.links?.gbp,
    neverMention: answers.neverMention ?? (biz.neverMention || []).join(', '),
  });

  let step = 0;
  const container = el('div', { class: 'view' });

  const persist = async () => {
    // Merge rather than replace: fields this form never asks about
    // (schemaType, areaServed, and anything else set outside the
    // interview) must survive a save here, not get silently wiped because
    // businessFromAnswers only knows about its own questions.
    appState.state.profile.business = { ...appState.state.profile.business, ...businessFromAnswers(answers) };
    appState.state.profile.interview = { ...(appState.state.profile.interview || {}), answers };
    await appState.save();
  };

  const render = () => {
    container.replaceChildren();
    const section = SECTIONS[step];

    container.append(
      el('div', { class: 'view-head' },
        el('div', {},
          el('h1', {}, 'Story Interview'),
          el('p', { class: 'sub' }, 'Every question is optional — skip anything your Voice DNA files already cover; the Story Brief reads those too. Spend your typing on what no document has: specific scenes, numbers, and moments.')),
        el('div', { class: 'stepper' },
          SECTIONS.map((s, i) => el('button', {
            class: `step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`,
            onclick: () => { step = i; render(); },
          }, `${i + 1}. ${s.title}`)))),
    );

    const form = el('div', { class: 'card form-card' },
      el('h2', {}, section.title),
      el('p', { class: 'intro' }, section.intro),
      section.questions.map((q) => {
        const input = q.input === 'area'
          ? textArea({ value: answers[q.key] || '', rows: 3, oninput: (e) => { answers[q.key] = e.target.value; } })
          : textInput({ value: answers[q.key] || '', oninput: (e) => { answers[q.key] = e.target.value; } });
        return field(q.label, input, typeof q.hint === 'function' ? q.hint(answers) : q.hint);
      }),
      el('div', { class: 'row gap' },
        step > 0 ? el('button', { class: 'btn btn-ghost', onclick: async () => { await persist(); step -= 1; render(); } }, '← Back') : null,
        step < SECTIONS.length - 1
          ? el('button', { class: 'btn btn-primary', onclick: async () => { await persist(); step += 1; render(); toast('Saved'); } }, 'Save & continue →')
          : el('button', {
              class: 'btn btn-primary', onclick: async () => {
                await persist();
                const btnRow = form.querySelector('.row.gap');
                btnRow.replaceChildren(spinner('Synthesizing your Story Brief…'));
                try {
                  const { brief } = await api.interviewBrief(answers);
                  appState.state.profile.interview.brief = brief;
                  toast('Story Brief ready');
                  render();
                } catch (err) {
                  toast(err.message, 'err');
                  render();
                }
              },
            }, '✦ Synthesize Story Brief')),
    );
    container.append(form);

    const brief = appState.profile.interview?.brief;
    if (brief) container.append(renderBrief(brief));
  };

  render();
  root.replaceChildren(container);
}

function renderBrief(brief) {
  const rows = [
    ['Positioning', brief.positioning],
    ['Core story', brief.coreStory],
    ['Audience truth', brief.audienceTruth],
    ['Proof assets', (brief.proofAssets || []).join(' · ')],
    ['Story themes', (brief.storyThemes || []).join(' · ')],
    ['Goals', (brief.contentGoals || []).join(' · ')],
    ['Only you can say', (brief.differentiators || []).join(' · ')],
  ].filter(([, v]) => v);
  return el('div', { class: 'card brief-card' },
    el('h2', {}, '✦ Your Story Brief'),
    rows.map(([k, v]) => el('div', { class: 'brief-row' }, el('span', { class: 'brief-key' }, k), el('span', {}, v))));
}

// ---- Voice DNA -----------------------------------------------------------

export function renderVoice(root) {
  const container = el('div', { class: 'view' });
  const dna = appState.profile.voiceDna;

  const drop = el('div', { class: 'card drop-zone' },
    el('h2', {}, 'Feed the studio your voice'),
    el('p', { class: 'intro' },
      'Upload your MD profile files — brand voice docs, bios, past posts, newsletters, anything written in your voice (.md or .txt, several at once). Files ADD to the fingerprint: upload new material anytime as the brand grows, and the voice re-synthesizes from everything combined. Re-uploading a filename replaces that file.'),
    el('input', {
      class: 'file-input', type: 'file', multiple: true, accept: '.md,.markdown,.txt,text/markdown,text/plain',
      onchange: async (e) => {
        const files = [...e.target.files];
        if (!files.length) return;
        drop.append(spinner(`Reading ${files.length} file(s) and synthesizing voice DNA…`));
        try {
          const payload = await Promise.all(files.map(async (f) => ({ name: f.name, text: await readFileAsText(f) })));
          const { voiceDna } = await api.voiceDna(payload);
          appState.state.profile.voiceDna = voiceDna;
          toast('Voice DNA updated');
          renderVoice(root);
        } catch (err) {
          toast(err.message, 'err');
          renderVoice(root);
        }
      },
    }));

  container.append(
    el('div', { class: 'view-head' },
      el('div', {},
        el('h1', {}, 'Voice DNA'),
        el('p', { class: 'sub' }, 'Your writing, fingerprinted — so every caption sounds like you, not like AI.'))),
    drop,
  );

  const s = dna?.summary;
  if (s && (s.voiceSummary || s.note)) {
    container.append(el('div', { class: 'card' },
      el('h2', {}, 'Current fingerprint'),
      s.note ? el('p', { class: 'intro' }, s.note) : null,
      s.voiceSummary ? el('p', { class: 'intro' }, s.voiceSummary) : null,
      s.tone ? el('div', { class: 'chip-row' }, s.tone.map((t) => el('span', { class: 'chip' }, t))) : null,
      s.rhythm ? el('div', { class: 'brief-row' }, el('span', { class: 'brief-key' }, 'Rhythm'), el('span', {}, s.rhythm)) : null,
      s.stance ? el('div', { class: 'brief-row' }, el('span', { class: 'brief-key' }, 'Stance'), el('span', {}, s.stance)) : null,
      s.signaturePhrases?.length ? el('div', { class: 'brief-row' }, el('span', { class: 'brief-key' }, 'Signature phrases'), el('span', {}, s.signaturePhrases.join(' · '))) : null,
      s.neverDo?.length ? el('div', { class: 'brief-row' }, el('span', { class: 'brief-key' }, 'Never'), el('span', {}, s.neverDo.join(' · '))) : null,
      s.sampleParagraph ? el('blockquote', { class: 'sample' }, s.sampleParagraph) : null,
    ));
  }

  if (dna?.sources?.length) {
    container.append(el('div', { class: 'card' },
      el('h2', {}, 'Sources in the fingerprint'),
      el('ul', { class: 'plain-list' }, dna.sources.map((f) => el('li', { class: 'row gap' },
        el('span', {}, `${f.name} — ${Math.round((f.chars || 0) / 1000)}k chars`),
        el('button', {
          class: 'btn btn-danger btn-xs', onclick: async () => {
            const { voiceDna } = await api.removeVoiceSource(f.name);
            appState.state.profile.voiceDna = voiceDna;
            toast(`${f.name} removed — fingerprint re-synthesized`);
            renderVoice(root);
          },
        }, '×'))))));
  } else if (!s) {
    container.append(emptyState('No voice sources yet', 'Upload 2-5 files of your real writing for the strongest fingerprint.'));
  }

  root.replaceChildren(container);
}

// ---- Testimonials / proof store ------------------------------------------
// Consented client outcomes: the concrete "According to [name], [result]"
// proof E-E-A-T and Google ranking both reward. Generation only ever cites
// what is stored here verbatim (never invents a testimonial), and only a
// consented one is eligible to become Review schema.
export function renderTestimonials(root) {
  const container = el('div', { class: 'view' });

  const persist = async (list) => {
    appState.state.profile.testimonials = list;
    await appState.save();
  };

  const draw = () => {
    container.replaceChildren();
    const list = appState.profile.testimonials || [];

    container.append(
      el('div', { class: 'view-head' },
        el('div', {},
          el('h1', {}, 'Testimonials & proof'),
          el('p', { class: 'sub' },
            'Real, attributed client outcomes. AI engines lift "According to [name], [result]" verbatim, and it is the same first-hand proof Google\'s own ranking guidelines reward. Generation only ever cites what is stored here, word for word, and only a testimonial marked consented can become published Review schema.'))),
    );

    const rows = list.map((t, i) => el('div', { class: 'card' },
      el('div', { class: 'row spread' },
        el('strong', {}, t.name || '(no name)'),
        el('div', { class: 'row gap' },
          t.consent ? el('span', { class: 'chip' }, 'Consented ✓') : el('span', { class: 'chip warn' }, 'Not consented'),
          el('button', {
            class: 'btn btn-danger btn-xs', onclick: async () => {
              const next = list.filter((_, idx) => idx !== i);
              await persist(next);
              draw();
              toast('Testimonial removed');
            },
          }, '×'))),
      t.context ? el('p', { class: 'muted', style: 'margin:4px 0' }, t.context) : null,
      t.quote ? el('blockquote', { class: 'sample' }, t.quote) : null,
      t.date ? el('p', { class: 'muted', style: 'margin:4px 0 0;font-size:12px' }, t.date) : null,
    ));
    if (rows.length) container.append(...rows);
    else container.append(emptyState('No testimonials yet', 'Add a real client outcome below. Nothing here is ever invented by generation, only cited when you add it.'));

    const nameInput = textInput({ placeholder: 'Client name (as they want to be credited)' });
    const contextInput = textInput({ placeholder: 'Context, e.g. "2026 Akumal retreat attendee"' });
    const quoteInput = textArea({ placeholder: 'Their words, or the specific outcome, quoted or paraphrased accurately', rows: 3 });
    const dateInput = textInput({ placeholder: 'Date (YYYY-MM-DD)', type: 'date' });
    const consentInput = el('input', { type: 'checkbox' });

    container.append(el('div', { class: 'card form-card' },
      el('h2', {}, 'Add a testimonial'),
      field('Name', nameInput),
      field('Context', contextInput),
      field('Quote / outcome', quoteInput, 'Exact words if you have them. This is what generation will cite verbatim, so make sure it is accurate.'),
      field('Date', dateInput),
      el('label', { class: 'row gap', style: 'align-items:center' },
        consentInput,
        el('span', {}, 'They have given permission to use this publicly (required before it can appear in generated content or Review schema)')),
      el('button', {
        class: 'btn btn-primary', onclick: async () => {
          if (!nameInput.value.trim() || !quoteInput.value.trim()) { toast('Name and quote/outcome are required', 'err'); return; }
          const next = [...list, {
            id: Math.random().toString(36).slice(2, 10),
            name: nameInput.value.trim(),
            context: contextInput.value.trim(),
            quote: quoteInput.value.trim(),
            date: dateInput.value || null,
            consent: consentInput.checked,
          }];
          await persist(next);
          draw();
          toast('Testimonial added');
        },
      }, '+ Add testimonial'),
    ));
  };

  draw();
  root.replaceChildren(container);
}
