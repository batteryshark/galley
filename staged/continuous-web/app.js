/* The Mac service is canonical. Unacknowledged composition lives only in memory. */
const token = location.hash.startsWith('#review=') ? location.hash.slice(8) : '';
history.replaceState(null, '', location.pathname);
const base = location.pathname.replace(/\/$/, '');
const $ = id => document.getElementById(id);
const article = $('document'), field = $('comment'), composer = $('composer');
const drafts = new Map();
let current, active, refreshing = false, pointerDown = false, composing = false, closeAfterComposition = false, selectionTimer, batchAttempt, sendBusy = false, notice = '', offline = '', images = [];
async function api(route, data) {
  const response = await fetch(`${base}/${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-Galley': '1' }) }, body: data === undefined ? undefined : JSON.stringify(data), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(9000) });
  if (!response.ok) { let error; try { error = (await response.json()).error; } catch {} throw Object.assign(new Error(error || `Request failed (${response.status})`), { status: response.status }); }
  return response;
}
function textNodes() { const w = document.createTreeWalker(article, NodeFilter.SHOW_TEXT), result = []; while (w.nextNode()) result.push(w.currentNode); return result; }
function toRange(a) {
  if (!a || a.revision !== current?.revision) return null;
  let offset = 0, start, end;
  for (const node of textNodes()) { const next = offset + node.length; if (!start && a.offset >= offset && a.offset < next) start = [node, a.offset - offset]; if (!end && a.offset + a.quote.length > offset && a.offset + a.quote.length <= next) end = [node, a.offset + a.quote.length - offset]; offset = next; }
  if (!start || !end) return null;
  const r = document.createRange(); r.setStart(...start); r.setEnd(...end); return r.toString() === a.quote ? r : null;
}
function paint() {
  $('highlights').replaceChildren();
  for (const a of [...(current?.notes || []).map(n => n.located), active?.anchor]) {
    const range = toRange(a); if (!range) continue;
    for (const rect of range.getClientRects()) { if (!rect.width || !rect.height) continue; const mark = document.createElement('span'); mark.className = `range-rect${a === active?.anchor ? '' : ' collected'}`; Object.assign(mark.style, { left: `${rect.left + scrollX}px`, top: `${rect.top + scrollY}px`, width: `${rect.width}px`, height: `${rect.height}px` }); $('highlights').append(mark); }
  }
  position();
}
function position() {
  if (!active) return;
  const rect = [...(toRange(active.anchor)?.getClientRects() || [])].filter(r => r.width).at(-1);
  const vv = visualViewport, top = vv?.offsetTop || 0, bottom = top + (vv?.height || innerHeight), height = composer.offsetHeight;
  let y = rect ? rect.bottom + 12 : top + 80;
  if (y + height > bottom - 12) y = (rect?.top || bottom) - height - 12;
  y = Math.max(top + 12, Math.min(y, bottom - height - 12));
  composer.style.top = `${scrollY + y}px`; composer.style.left = `${Math.max(16, Math.min(rect?.left || 24, innerWidth - composer.offsetWidth - 16)) + scrollX}px`;
}
function renderChrome() {
  const notes = current?.notes || [], pending = notes.filter(n => n.status === 'pending');
  for (const n of notes) {
    const d = drafts.get(n.id);
    if (d && d !== active && !d.saving && !d.attempt && !d.error && d.text === d.savedText && d.version !== n.version) {
      d.text = d.savedText = n.message; d.version = n.version; d.anchor = n.anchor;
    }
  }
  const total = notes.length + (current?.comments?.length || 0);
  $('notes-toggle').textContent = `${total} ${total === 1 ? 'note' : 'notes'}${pending.length ? ` · ${pending.length} pending` : ''}`;
  const unresolved = current?.batches.find(b => ['sending', 'uncertain'].includes(b.status));
  $('send').textContent = sendBusy || unresolved?.status === 'sending' ? 'Sending…' : unresolved ? 'Send uncertain' : 'Send';
  $('send').disabled = sendBusy || !!unresolved || !!batchAttempt || !pending.length || [...drafts.values()].some(d => d.attempt || d.text !== d.savedText && (d.version || d.text.trim()));
  const unsaved = [...drafts.values()].filter(d => d.text !== d.savedText && (d.version || d.text.trim()));
  $('state').textContent = offline || (unresolved ? unresolved.status === 'uncertain' ? 'Admission uncertain — check editor. No automatic replay.' : 'Batch admission pending…' : '') || notice || (unsaved.length ? 'Unsent text kept in this tab — not yet saved to Mac.' : '');
  const activeStatus = notes.find(n => n.id === active?.id)?.status;
  $('compose-state').textContent = active?.error || (active?.saving ? 'Saving to Mac…' : active && active.text !== active.savedText ? !active.text.trim() && active.version ? 'Empty edit not saved; existing note retained' : 'Not yet saved to Mac' : activeStatus && activeStatus !== 'pending' ? `${activeStatus} · immutable dispatch history` : active?.version ? 'Saved on Mac · not sent' : '');
  const list = $('note-list'); list.replaceChildren();
  const items = notes.map(n => ({ n, d: drafts.get(n.id) }));
  for (const d of drafts.values()) if (!notes.some(n => n.id === d.id) && d.text.trim()) items.push({ d });
  for (const { n, d } of items) {
    const button = document.createElement('button'); button.className = 'note';
    const quote = document.createElement('q'); quote.textContent = (n?.anchor || d.anchor).quote;
    const text = document.createElement('span'); text.textContent = d && d.text !== d.savedText ? d.text : n?.message || d.text;
    const state = document.createElement('small'); state.textContent = d?.error || (n ? `${n.status === 'accepted' ? 'Admitted to editor — not edit completion' : n.status}${!n.located ? ' · quote stale / ambiguous' : n.anchor.revision !== current.revision ? ' · quote relocated; review before Send' : ''}` : 'Not saved to Mac');
    button.append(quote, text, state);
    button.onclick = () => {
      close(); $('notes').hidden = true;
      if (n?.located) toRange(n.located)?.startContainer.parentElement.scrollIntoView({ block: 'center' });
      if (n && n.status !== 'pending') { paint(); return; }
      const draft = d || makeDraft(n);
      if (draft.errorKind === 'conflict' && !draft.attempt && !draft.saving && n && draft.version !== n.version && confirm('This note changed on another device. Keep your text and explicitly replace the latest version on Done?')) { draft.version = n.version; draft.error = ''; draft.errorKind = ''; }
      open(draft); field.focus({ preventScroll: true });
    };
    list.append(button);
    // Rare recovery is local-only and lives beside the failed note, not in the
    // normal collection/Send path. Never abandon an unresolved operation.
    if (d?.error && !d.attempt && !d.saving) {
      const discard = document.createElement('button'); discard.className = 'note';
      discard.textContent = 'Discard local unsaved text';
      discard.onclick = () => {
        if (d.attempt || d.saving || !confirm('Discard only this tab’s unsaved text? Copy it first if needed. Any note saved on the Mac is kept. You can then select a fresh passage.')) return;
        if (active === d) { active = null; composer.hidden = true; field.blur(); }
        drafts.delete(d.id); notice = 'Local unsaved text discarded. Notes saved on the Mac are unchanged.'; renderChrome();
      };
      list.append(discard);
    }
  }
  for (const c of current?.comments || []) {
    const entry = document.createElement('div'); entry.className = 'note';
    const quote = document.createElement('q'); quote.textContent = c.anchor?.quote || '';
    const text = document.createElement('span'); text.textContent = c.message;
    const state = document.createElement('small'); state.textContent = `Earlier individual feedback · ${c.status} · retained without replay`;
    entry.append(quote, text, state); list.append(entry);
  }
  paint();
}
function makeDraft(n) { const d = { id: n.id, anchor: n.anchor, text: n.message, savedText: n.message, version: n.version }; drafts.set(d.id, d); return d; }
function open(d) { active = d; composer.hidden = false; field.value = d.text; renderChrome(); }
function close() {
  if (composing) { closeAfterComposition = true; return; }
  if (!active) return;
  const d = active; d.text = field.value; active = null; composer.hidden = true; field.blur();
  if (d.text.trim() && d.text !== d.savedText) void commit(d);
  renderChrome();
}
async function commit(d) {
  if (d.errorKind === 'validation' && d.text !== d.rejectedText) { d.error = ''; d.errorKind = ''; }
  if (d.saving || (d.error && !d.attempt) || !d.text.trim()) return;
  d.saving = true;
  // Keep the exact operation until response loss has been reconciled. Later
  // typing is a separate versioned edit, never a replacement of that operation.
  d.attempt ||= { id: d.id, operationId: crypto.randomUUID(), expectedVersion: d.version || 0, message: d.text, anchor: d.anchor };
  const attempt = d.attempt; renderChrome();
  try {
    const n = await (await api('api/notes', attempt)).json();
    d.version = n.version; d.savedText = attempt.message; d.attempt = null; d.error = ''; d.errorKind = '';
    await refresh();
  } catch (e) {
    d.error = `${e.message}. Your text is kept, not confirmed saved.`;
    if (e.status >= 400 && e.status < 500 && e.status !== 408) {
      d.attempt = null;
      d.errorKind = [400, 413, 422].includes(e.status) ? 'validation' : e.status === 409 ? d.version ? 'conflict' : 'stale' : 'rejected';
      d.rejectedText = attempt.message;
      if (d.errorKind === 'stale') d.error += ' Use Your notes to discard local text, then reselect a current passage.';
    } else d.errorKind = 'uncertain'; // Keep immutable attempt for transport/5xx uncertainty.
  } finally { d.saving = false; renderChrome(); }
  if (!d.error && d.text !== d.savedText && active !== d) void commit(d);
}
function takeSelection() {
  if (pointerDown || document.activeElement === field || !current) return;
  const s = getSelection(); if (!s?.rangeCount || s.isCollapsed || !s.toString().trim()) return;
  const r = s.getRangeAt(0); if (!article.contains(r.startContainer) || !article.contains(r.endContainer)) return;
  const before = document.createRange(); before.selectNodeContents(article); before.setEnd(r.startContainer, r.startOffset);
  const offset = before.toString().length, quote = r.toString();
  if (current.text.slice(offset, offset + quote.length) !== quote || quote.length > 12000) {
    notice = 'Selection could not be anchored safely. Reselect a shorter passage or refresh after keeping any unsaved text.'; renderChrome(); return;
  }
  if (active?.anchor.offset === offset && active.anchor.quote === quote) return;
  close();
  const anchor = { kind: 'continuous', revision: current.revision, offset, quote, prefix: current.text.slice(Math.max(0, offset - 80), offset), suffix: current.text.slice(offset + quote.length, offset + quote.length + 80) };
  const d = { id: crypto.randomUUID(), anchor, text: '', savedText: '', version: 0 }; drafts.set(d.id, d); open(d);
}
document.addEventListener('selectionchange', () => { clearTimeout(selectionTimer); selectionTimer = setTimeout(takeSelection, 250); });
document.addEventListener('pointerdown', e => { if (composer.contains(e.target) || $('notes').contains(e.target)) return; pointerDown = true; close(); if (!$('notes-toggle').contains(e.target)) $('notes').hidden = true; });
document.addEventListener('pointerup', () => { pointerDown = false; clearTimeout(selectionTimer); selectionTimer = setTimeout(takeSelection, 100); });
document.addEventListener('pointercancel', () => { pointerDown = false; });
field.addEventListener('focus', () => { getSelection()?.removeAllRanges(); paint(); });
field.addEventListener('input', () => { if (active) { active.text = field.value; renderChrome(); } });
field.addEventListener('compositionstart', () => { composing = true; });
field.addEventListener('compositionend', () => { composing = false; if (active) active.text = field.value; if (closeAfterComposition) { closeAfterComposition = false; close(); } });
field.addEventListener('keydown', e => { if (!e.isComposing && (e.key === 'Enter' && !e.shiftKey || e.key === 'Escape')) { e.preventDefault(); close(); } });
field.addEventListener('blur', close);
document.addEventListener('keydown', e => { if (!active || document.activeElement === field || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented || e.target.closest('button, input, textarea, select, [contenteditable]')) return; if (Array.from(e.key).length === 1 && !/\s/.test(e.key)) { e.preventDefault(); field.focus({ preventScroll: true }); field.value += e.key; active.text = field.value; renderChrome(); } });
$('notes-toggle').onclick = () => { close(); $('notes').hidden = !$('notes').hidden; $('notes-toggle').setAttribute('aria-expanded', String(!$('notes').hidden)); };
$('send').onclick = async () => {
  close(); if (sendBusy || $('send').disabled) return;
  const moved = current.notes.some(n => n.status === 'pending' && n.anchor.revision !== current.revision);
  if (moved) { $('notes').hidden = false; if (!confirm('Draft text changed. Review the original quotes in Your notes. Send all pending notes against this current revision, preserving original quotes?')) return; }
  const stale = current.notes.some(n => n.status === 'pending' && !n.located);
  if (stale && !confirm('Some original passages are now stale or ambiguous and cannot be highlighted. Send their ORIGINAL quotes explicitly labeled unanchored to the editor, together with all other pending notes?')) return;
  batchAttempt = { id: crypto.randomUUID(), revision: current.revision, ...(moved ? { confirmRevision: current.revision } : {}), ...(stale ? { confirmStale: current.revision } : {}) };
  sendBusy = true; notice = 'Sending all pending notes…'; renderChrome();
  try { await attemptBatch(); } finally { sendBusy = false; renderChrome(); }
};
async function attemptBatch() {
  if (!batchAttempt) return;
  try {
    const b = await (await api('api/batches', batchAttempt)).json(); batchAttempt = null;
    notice = b.status === 'accepted' ? 'Admitted to editor — edit completion not confirmed.' : b.status === 'uncertain' ? 'Batch admission uncertain. Check editor; no replay.' : 'Batch admission pending…';
    await refresh();
  } catch (e) {
    notice = `${e.message}. Send not confirmed; notes and exact attempt kept.`;
    if (e.status) batchAttempt = null;
  }
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const next = await (await api('api/document')).json(); offline = '';
    const changed = next.presentationRevision !== current?.presentationRevision;
    // Keep native selection and live composition intact; defer only the prose,
    // never authoritative notes. A text revision mismatch cannot be committed.
    if (changed && current && (active || !getSelection().isCollapsed)) {
      current.notes = next.notes; current.batches = next.batches; renderChrome(); return;
    }
    if (changed) {
      const top = [...article.querySelectorAll('[data-block]')].find(b => b.getBoundingClientRect().bottom > 0), y = top?.getBoundingClientRect().top, priorY = scrollY;
      // Keep unchanged decoded rasters from collapsing the document (and
      // clamping scrollY) while their replacement blob URLs are loaded.
      const dimensions = new Map([...article.querySelectorAll('img[data-image]')].filter(img => img.naturalWidth > 0).map(img => [img.dataset.image, { width: img.naturalWidth, height: img.naturalHeight }]));
      for (const url of images) URL.revokeObjectURL(url); images = [];
      article.innerHTML = next.html; current = next;
      for (const img of article.querySelectorAll('img[data-image]')) {
        const size = dimensions.get(img.dataset.image);
        if (size && !img.hasAttribute('width') && !img.hasAttribute('height')) { img.width = size.width; img.height = size.height; }
      }
      const restore = () => { const node = top && document.getElementById(top.id); if (node) scrollBy(0, node.getBoundingClientRect().top - y); else scrollTo(0, priorY); paint(); };
      restore();
      for (const img of article.querySelectorAll('img[data-image]')) {
        void api(`image/${img.dataset.image}`).then(r => r.blob()).then(async blob => {
          if (!img.isConnected) return;
          const url = URL.createObjectURL(blob); images.push(url);
          const decoded = new Image(); decoded.src = url; await decoded.decode(); if (!img.isConnected) return;
          // Capture the CURRENT viewport before introducing image dimensions,
          // not the earlier refresh position (the reader may have scrolled).
          const visible = [...article.querySelectorAll('[data-block]')].find(b => b.getBoundingClientRect().bottom > 0), before = visible?.getBoundingClientRect().top;
          // Natural-size placeholders must not overwrite safe authored dimensions.
          if (!img.hasAttribute('width')) img.width = decoded.naturalWidth;
          if (!img.hasAttribute('height')) img.height = decoded.naturalHeight;
          img.src = url;
          if (visible) scrollBy(0, visible.getBoundingClientRect().top - before); paint();
        }).catch(() => { img.alt += ' (image unavailable)'; });
      }
    } else current = next;
    // Never overwrite an in-memory edit from a refreshed service snapshot.
    renderChrome();
  } catch (e) { offline = `${e.message}. Unsent text kept in this tab; not synced.`; renderChrome(); }
  finally { refreshing = false; }
}
window.addEventListener('scroll', paint, { passive: true }); window.addEventListener('resize', paint);
window.visualViewport?.addEventListener('resize', paint); window.visualViewport?.addEventListener('scroll', paint);
window.addEventListener('beforeunload', e => { if ([...drafts.values()].some(d => d.text !== d.savedText) || batchAttempt) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('online', refresh); document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
if (token) { void refresh(); setInterval(async () => { if (document.hidden) return; await refresh(); for (const d of drafts.values()) if (d.attempt && !d.saving) void commit(d); if (batchAttempt && !sendBusy) { sendBusy = true; try { await attemptBatch(); } finally { sendBusy = false; } } }, 3000); }
else { offline = 'Open a private review link issued on the Mac.'; renderChrome(); }
