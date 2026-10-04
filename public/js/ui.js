// The DOM's replaceChildren, append and prepend turn null and false into the
// literal text "null" or "false". Conditional children (cond ? node : null)
// are everywhere in these views, so drop them once here instead of at every
// call site (the same trap bit the produce panel and the Reel to Short page).
for (const name of ['replaceChildren', 'append', 'prepend']) {
  const original = Element.prototype[name];
  Element.prototype[name] = function patched(...nodes) {
    return original.apply(this, nodes.flat(Infinity).filter((n) => n != null && n !== false));
  };
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

export function toast(message, kind = 'ok') {
  const t = el('div', { class: `toast toast-${kind}` }, message);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

export async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} ✓`);
  } catch {
    const ta = el('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(`${label} ✓`);
  }
}

export function copyBtn(getText, label = 'Copy') {
  return el('button', { class: 'btn btn-ghost btn-xs', onclick: () => copyText(typeof getText === 'function' ? getText() : getText) }, label);
}

// Copies real rich text: the clipboard carries an HTML flavor alongside the
// plain one, so a composer that understands formatting (a LinkedIn article,
// a newsletter editor) keeps the heading hierarchy, bold, and lists instead
// of receiving literal markdown characters. Falls back to plain text
// wherever the richer clipboard API is unavailable.
export async function copyRich(html, plain, label = 'Copied with formatting') {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' }),
    })]);
    toast(`${label} ✓`);
  } catch {
    await copyText(plain, 'Copied as plain text');
  }
}

export function field(labelText, input, hint) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' }, labelText),
    input,
    hint ? el('span', { class: 'field-hint' }, hint) : null);
}

export function textInput(props = {}) {
  return el('input', { class: 'input', type: 'text', ...props });
}

export function textArea(props = {}) {
  return el('textarea', { class: 'input textarea', rows: props.rows || 3, ...props });
}

export function download(filename, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export function spinner(text = 'Working…') {
  return el('div', { class: 'spinner-row' }, el('span', { class: 'spinner' }), el('span', {}, text));
}

export function scoreBadge(score, grade) {
  const cls = score >= 90 ? 'score-a' : score >= 75 ? 'score-b' : score >= 55 ? 'score-c' : 'score-d';
  return el('span', { class: `score-badge ${cls}` }, `${score ?? '–'} · ${grade || 'unscored'}`);
}

export function emptyState(title, body, action) {
  return el('div', { class: 'empty' }, el('h3', {}, title), el('p', {}, body), action || null);
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsText(file);
  });
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// What a plain, non-JavaScript bot sees at a registered URL (see
// lib/crawl.js). Shown beside the published-URL box so a page that looks
// fine in a browser but serves crawlers an empty shell is caught at once.
export function crawlerAuditView(audit) {
  if (!audit) return null;
  if (audit.skipped) return el('p', { class: 'muted', style: 'margin:6px 0 0' }, audit.skipped);
  if (audit.error) return el('p', { class: 'muted', style: 'margin:6px 0 0' }, `Crawler-view audit could not run: ${audit.error}`);
  return el('details', { class: 'asset-field', style: 'margin-top:6px', open: audit.passed ? null : true },
    el('summary', { class: 'field-label', style: 'cursor:pointer' },
      `${audit.passed ? '✅' : '⚠️'} Crawler view: ${audit.summary}`),
    el('ul', { style: 'margin:8px 0 0;padding-left:18px' },
      (audit.checks || []).map((c) => el('li', {}, `${c.pass ? '✓' : '✗'} ${c.label}: `, el('span', { class: 'muted' }, c.detail)))),
    el('p', { class: 'muted', style: 'margin:8px 0 0' },
      'This is what AI crawlers fetch: plain HTML, no JavaScript. Fix anything marked ✗ on the site, then re-save the URL to re-check.'));
}
