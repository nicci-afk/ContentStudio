import { api, appState } from './api.js';
import { el, field, textInput, textArea, toast, spinner, download, emptyState, readFileAsDataURL } from './ui.js';

const keyMissing = (name, provider, url) =>
  emptyState(`${name} is not connected`,
    `Add ${provider} to the server .env and restart — the studio unlocks this room automatically. Get a key at ${url}.`);

export function renderVoiceStudio(root) {
  const container = el('div', { class: 'view' });
  container.append(el('div', { class: 'view-head' },
    el('div', {},
      el('h1', {}, 'Voice Studio'),
      el('p', { class: 'sub' }, 'Clone your real voice with ElevenLabs and narrate any script the studio writes.'))));

  if (!appState.health?.providers?.elevenlabs) {
    container.append(keyMissing('Voice Studio', 'ELEVENLABS_API_KEY', 'elevenlabs.io'));
    root.replaceChildren(container);
    return;
  }

  let voices = [];
  let voiceId = null;
  const script = sessionStorage.getItem('cs-script') || '';
  sessionStorage.removeItem('cs-script');

  const voiceSelect = el('select', { class: 'input select', onchange: (e) => { voiceId = e.target.value; } });
  const ttsText = textArea({ rows: 8, value: script, placeholder: 'Paste a script, or send one here from any package with “Narrate in Voice Studio”.' });
  const player = el('div', {});

  const cloneCard = el('div', { class: 'card' },
    el('h2', {}, 'Clone your voice'),
    el('p', { class: 'intro' }, 'Upload 1-3 clean voice recordings (1-3 minutes total: talk naturally, no music, no echo). Only clone a voice you own or have written permission to use.'),
    (() => {
      const name = textInput({ placeholder: 'Voice name (e.g. "Nicci — natural")' });
      const picker = el('input', { class: 'file-input', type: 'file', multiple: true, accept: 'audio/*' });
      return el('div', {},
        field('Voice name', name),
        field('Samples', picker),
        el('button', {
          class: 'btn btn-primary', onclick: async (e) => {
            const files = [...picker.files];
            if (!name.value.trim() || !files.length) return toast('Name + at least one sample required', 'err');
            const btn = e.target;
            btn.replaceWith(spinner('Cloning voice…'));
            try {
              const samples = await Promise.all(files.map(async (f) => ({
                name: f.name, mime: f.type || 'audio/mpeg',
                b64: (await readFileAsDataURL(f)).split(',')[1],
              })));
              await api.cloneVoice({ name: name.value.trim(), description: 'Cloned in ContentStudio', samples });
              toast('Voice cloned — it now appears in your voice list');
              renderVoiceStudio(root);
            } catch (err) {
              toast(err.message, 'err');
              renderVoiceStudio(root);
            }
          },
        }, '⧉ Clone voice'));
    })());

  const ttsCard = el('div', { class: 'card' },
    el('h2', {}, 'Narrate a script'),
    field('Voice', voiceSelect),
    field('Script', ttsText),
    el('button', {
      class: 'btn btn-primary', onclick: async () => {
        if (!voiceId || !ttsText.value.trim()) return toast('Pick a voice and add a script', 'err');
        player.replaceChildren(spinner('Rendering narration…'));
        try {
          const blob = await api.tts({ voiceId, text: ttsText.value });
          const url = URL.createObjectURL(blob);
          player.replaceChildren(
            el('audio', { controls: true, src: url, class: 'audio-player' }),
            el('button', { class: 'btn btn-ghost btn-xs', onclick: () => download('narration.mp3', blob) }, '⬇ Download mp3'));
        } catch (err) {
          player.replaceChildren();
          toast(err.message, 'err');
        }
      },
    }, '🎙 Generate narration'),
    player);

  container.append(cloneCard, ttsCard);
  root.replaceChildren(container);

  api.voices().then(({ voices: v }) => {
    voices = v;
    voiceSelect.replaceChildren(...voices.map((vc) => el('option', { value: vc.id }, `${vc.name}${vc.category === 'cloned' ? ' · your clone' : ''}`)));
    voiceId = voices.find((vc) => vc.category === 'cloned')?.id || voices[0]?.id || null;
    if (voiceId) voiceSelect.value = voiceId;
  }).catch((err) => toast(err.message, 'err'));
}

export function renderAvatarStudio(root) {
  const container = el('div', { class: 'view' });
  container.append(el('div', { class: 'view-head' },
    el('div', {},
      el('h1', {}, 'Avatar Studio'),
      el('p', { class: 'sub' }, 'Photoreal talking-head video via HeyGen — including custom avatars trained on your own footage.'))));

  if (!appState.health?.providers?.heygen) {
    container.append(keyMissing('Avatar Studio', 'HEYGEN_API_KEY', 'heygen.com'),
      el('div', { class: 'card' },
        el('h2', {}, 'While you wait'),
        el('p', { class: 'intro' }, 'Tip: a custom "photo avatar" or studio avatar trained on 2 minutes of your real footage (recorded in HeyGen) is what makes avatars look genuinely human. Once the key is added, your custom avatars appear here automatically.')));
    root.replaceChildren(container);
    return;
  }

  const script = sessionStorage.getItem('cs-script') || '';
  sessionStorage.removeItem('cs-script');

  let avatarId = null;
  let avatarList = [];
  let voiceId = null;
  const avatarSelect = el('select', { class: 'input select', onchange: (e) => { avatarId = e.target.value; } });
  const avatarNote = el('p', { class: 'muted', style: 'margin:6px 0 0;font-size:0.85em' });
  const voiceSelect = el('select', { class: 'input select', onchange: (e) => { voiceId = e.target.value; } });
  const orientation = el('select', { class: 'input select' },
    el('option', { value: 'portrait' }, 'Portrait 9:16 (Reels / Shorts / TikTok)'),
    el('option', { value: 'landscape' }, 'Landscape 16:9 (YouTube)'));
  const text = textArea({ rows: 8, value: script, placeholder: 'Script for your avatar to speak.' });
  const result = el('div', {});

  container.append(el('div', { class: 'card' },
    el('h2', {}, 'Film with your avatar'),
    field('Avatar', el('div', {}, avatarSelect, avatarNote), 'Custom avatars trained on your footage appear here alongside stock avatars.'),
    field('Voice', voiceSelect, 'Pair with your ElevenLabs clone inside HeyGen for full realism.'),
    field('Orientation', orientation),
    field('Script', text),
    el('button', {
      class: 'btn btn-primary', onclick: async () => {
        if (!avatarId || !voiceId || !text.value.trim()) return toast('Avatar, voice, and script required', 'err');
        result.replaceChildren(spinner('Rendering avatar video — this takes a few minutes…'));
        try {
          const { videoId } = await api.avatarGenerate({
            avatarId, avatarKind: avatarList.find((a) => a.id === avatarId)?.kind || 'avatar',
            voiceId, text: text.value,
            title: text.value.slice(0, 60), orientation: orientation.value,
          });
          const poll = async () => {
            const s = await api.avatarStatus(videoId);
            if (s.status === 'completed' && s.url) {
              result.replaceChildren(
                el('video', { controls: true, src: s.url, class: 'video-player', poster: s.thumbnail || undefined }),
                el('a', { class: 'btn btn-ghost btn-xs', href: s.url, target: '_blank' }, '⬇ Open / download'));
              toast('Avatar video ready');
              return;
            }
            if (s.status === 'failed') {
              result.replaceChildren();
              return toast(`Render failed: ${s.error || 'unknown error'}`, 'err');
            }
            result.replaceChildren(spinner(`Rendering… (${s.status})`));
            setTimeout(poll, 8000);
          };
          poll();
        } catch (err) {
          result.replaceChildren();
          toast(err.message, 'err');
        }
      },
    }, '🎬 Render avatar video'),
    result));

  root.replaceChildren(container);

  // Avatar list problems stay visible under the dropdown (a toast vanishes
  // before anyone can read it) and are always retryable in place.
  const loadAvatars = async () => {
    avatarNote.textContent = 'Loading your avatars…';
    try {
      const { avatars } = await api.avatars();
      avatarList = avatars;
      avatarSelect.replaceChildren(...avatars.map((a) => el('option', { value: a.id },
        a.kind === 'talking_photo' ? `${a.name} (your photo avatar)` : a.name)));
      avatarId = avatars[0]?.id || null;
      if (avatars.length) avatarNote.textContent = '';
      else {
        avatarNote.replaceChildren(
          'No avatars are visible in your HeyGen account yet. Create one at heygen.com (Avatars, then Photo Avatar or Video Avatar), give it a minute, then ',
          el('button', { class: 'btn btn-ghost btn-xs', onclick: loadAvatars }, '↻ check again'));
      }
    } catch (err) {
      avatarNote.replaceChildren(
        `The avatar list could not load: ${err.message}. `,
        el('button', { class: 'btn btn-ghost btn-xs', onclick: loadAvatars }, '↻ Try again'));
    }
  };
  loadAvatars();
  api.avatarVoices().then(({ voices }) => {
    voiceSelect.replaceChildren(...voices.map((v) => el('option', { value: v.id }, `${v.name} (${v.language || '—'})`)));
    voiceId = voices[0]?.id || null;
  }).catch(() => {});
}
