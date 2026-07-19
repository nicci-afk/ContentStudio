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
