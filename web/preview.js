// Synthetic, browser-only prototype. No fetch, API, auth, delivery or app imports.
const article = document.querySelector('#document');
const composer = document.querySelector('#composer');
const field = document.querySelector('#comment');
const overlays = document.querySelector('#highlights');
const toggle = document.querySelector('#notes-toggle');
const notesPanel = document.querySelector('#notes');
const storageKey = 'galley-continuous-preview-v1';
const demo = /^#demo=(compose|collected)$/.exec(location.hash)?.[1];
window.addEventListener('hashchange', () => location.reload());
let entries = [], active = null, pointerDown = false, timer;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="420" viewBox="0 0 960 420"><rect width="960" height="420" fill="#e4e9e7"/><path d="M0 170 Q240 150 470 175 T960 150 V420 H0Z" fill="#9aafb3"/><path d="M0 238 Q170 178 290 250 T630 259 Q800 210 960 310 V420 H0Z" fill="#788778"/><path d="M0 320 Q220 225 420 335 T960 348 V420 H0Z" fill="#a5ad8d"/><path d="M110 420 Q220 300 355 315 T550 281" fill="none" stroke="#ded8bf" stroke-width="19"/><path d="M0 205 Q165 175 252 200" fill="none" stroke="#dbe4e1" stroke-width="3"/><circle cx="754" cy="88" r="27" fill="#f3eee0"/></svg>`;
const imageURL = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
document.querySelector('#coast').src = imageURL;
window.addEventListener('pagehide', () => URL.revokeObjectURL(imageURL), { once: true });

function nodes() {
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const result = []; while (walker.nextNode()) result.push(walker.currentNode);
  return result;
}
function toRange(entry) {
  const all = nodes(); let offset = 0, start, end;
  for (const node of all) {
    const next = offset + node.length;
    if (!start && entry.start >= offset && entry.start < next) start = [node, entry.start - offset];
    if (!end && entry.end > offset && entry.end <= next) end = [node, entry.end - offset];
    offset = next;
  }
  if (!start || !end) return null;
  const range = document.createRange(); range.setStart(...start); range.setEnd(...end);
  return range.toString() === entry.quote ? range : null;
}
function fromRange(range) {
  const before = document.createRange(); before.selectNodeContents(article); before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end: start + range.toString().length, quote: range.toString(), text: '' };
}
function persist() {
  // Separate preview namespace; demo URLs never read or overwrite local notes.
  if (!demo) try { sessionStorage.setItem(storageKey, JSON.stringify({ entries, active })); } catch { /* memory-only when storage denied */ }
}
function paint() {
  overlays.replaceChildren();
  for (const entry of [...entries.filter(e => e !== active), ...(active ? [active] : [])]) {
    const range = toRange(entry); if (!range) continue;
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      const mark = document.createElement('span'); mark.className = `range-rect${entry === active ? '' : ' collected'}`;
      Object.assign(mark.style, { left: `${rect.left + scrollX}px`, top: `${rect.top + scrollY}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      overlays.append(mark);
    }
  }
  if (active) position();
}
function position() {
  const range = toRange(active); if (!range) return;
  const rects = [...range.getClientRects()].filter(r => r.width);
  const rect = rects.at(-1); if (!rect) return;
  const vv = window.visualViewport;
  const top = vv?.offsetTop || 0, bottom = top + (vv?.height || innerHeight);
  const height = composer.offsetHeight;
  // Follow the range endpoint; flip if needed, clamp to the visible viewport.
  let y = rect.bottom + 12;
  if (y + height > bottom - 12) y = rect.top - height - 12;
  y = Math.max(top + 12, Math.min(y, bottom - height - 12));
  composer.style.top = `${scrollY + y}px`;
  composer.style.left = `${Math.max(16, Math.min(rect.left, innerWidth - composer.offsetWidth - 16)) + scrollX}px`;
}
function updateNotes() {
  toggle.hidden = entries.length === 0;
  toggle.textContent = `${entries.length} ${entries.length === 1 ? 'note' : 'notes'} · local`;
  const list = document.querySelector('#note-list'); list.replaceChildren();
  for (const entry of entries) {
    const button = document.createElement('button'); button.className = 'note';
    const quote = document.createElement('q'); quote.textContent = entry.quote;
    const text = document.createElement('span'); text.textContent = entry.text;
    button.append(quote, text);
    button.addEventListener('click', () => { close(); notesPanel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); open(entry); toRange(entry)?.startContainer.parentElement.scrollIntoView({ block: 'center' }); paint(); field.focus({ preventScroll: true }); });
    list.append(button);
  }
}
function open(entry) {
  active = entry; composer.hidden = false; field.value = entry.text;
  paint(); persist();
  // Touch selection never assumes a software keyboard can be summoned.
}
function close() {
  if (!active) return;
  active.text = field.value;
  if (active.text.trim() && !entries.includes(active)) entries.push(active);
  if (!active.text.trim()) entries = entries.filter(e => e !== active);
  active = null; composer.hidden = true; field.blur();
  updateNotes(); paint(); persist();
  document.querySelector('#announcement').textContent = entries.length ? 'Note collected locally. Nothing sent.' : '';
}
function takeSelection() {
  if (pointerDown || document.activeElement === field) return;
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return;
  const range = selection.getRangeAt(0);
  if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return;
  const entry = fromRange(range.cloneRange());
  if (active?.start === entry.start && active?.end === entry.end) return;
  close(); open(entries.find(e => e.start === entry.start && e.end === entry.end) || entry);
}
document.addEventListener('selectionchange', () => { clearTimeout(timer); timer = setTimeout(takeSelection, 250); });
document.addEventListener('pointerdown', event => {
  if (composer.contains(event.target) || notesPanel.contains(event.target) || toggle.contains(event.target)) return;
  pointerDown = true; close(); notesPanel.hidden = true; toggle.setAttribute('aria-expanded', 'false');
});
document.addEventListener('pointerup', () => { pointerDown = false; clearTimeout(timer); timer = setTimeout(takeSelection, 100); });
document.addEventListener('pointercancel', () => { pointerDown = false; });
field.addEventListener('focus', () => { window.getSelection()?.removeAllRanges(); paint(); });
field.addEventListener('input', () => { if (active) { active.text = field.value; persist(); } });
field.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); close(); }
  if (event.key === 'Escape') { event.preventDefault(); close(); }
});
field.addEventListener('blur', () => { if (active) close(); });
document.addEventListener('keydown', event => {
  if (!active || document.activeElement === field || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return;
  if (event.target.closest('button, input, textarea, select, [contenteditable]')) return;
  if (Array.from(event.key).length === 1 && !/\s/.test(event.key)) {
    event.preventDefault(); field.focus({ preventScroll: true }); field.value += event.key;
    active.text = field.value; persist();
  }
});
toggle.addEventListener('click', () => { close(); notesPanel.hidden = !notesPanel.hidden; toggle.setAttribute('aria-expanded', String(!notesPanel.hidden)); });
window.addEventListener('scroll', paint, { passive: true });
window.addEventListener('resize', paint);
window.visualViewport?.addEventListener('resize', paint);
window.visualViewport?.addEventListener('scroll', paint);
document.querySelector('#coast').addEventListener('load', paint);

if (demo) {
  // Deterministic illustrative states, not evidence of native touch selection.
  const node = document.querySelector('#opening').firstChild;
  const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 75);
  const entry = fromRange(range);
  if (demo === 'compose') {
    // Exercise the same selectionchange path as a real selection, without
    // pretending the programmatic Range is an iPhone long-press gesture.
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  else { entry.text = 'Keep this quiet opening. Could we linger here a little longer?'; entries.push(entry); updateNotes(); paint(); }
} else {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (saved && Array.isArray(saved.entries)) {
      entries = saved.entries.filter(e => typeof e.text === 'string' && toRange(e));
      updateNotes();
      if (saved.active && typeof saved.active.text === 'string' && toRange(saved.active)) open(entries.find(e => e.start === saved.active.start && e.end === saved.active.end) || saved.active);
      paint();
    }
  } catch { /* Invalid or unavailable storage starts an empty preview. */ }
}
