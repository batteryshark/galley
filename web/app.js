/* Credentials exist only in this page's memory, not URLs, cookies or storage. */
const fragment = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const token = fragment.startsWith('review=') ? fragment.slice(7) : '';
const base = location.pathname.replace(/\/$/, '');
const $ = id => document.getElementById(id);
let current, anchor, captured, pendingId, pendingSave, savedOriginal = false, busy = false, refreshing = false;
let imageUrls = [];
const norm = text => text.replace(/\s+/g, ' ').trim();
function status(text) { $('state').textContent = text; }
function actionStatus(text) { $('action-state').textContent = text; }
const samePayload = (a, b) => a.message === b.message && JSON.stringify(a.anchor) === JSON.stringify(b.anchor);
function composerPayload() { return { id: pendingId, anchor, message: $('message').value }; }
function finishSave(attempt, result) {
  pendingSave = null;
  if (samePayload(attempt, composerPayload())) {
    anchor = null; pendingId = null; $('message').value = ''; $('composer').hidden = true;
    actionStatus(`Comment ${result.status} locally`);
  } else {
    pendingId = crypto.randomUUID(); savedOriginal = true;
    actionStatus('Original comment saved locally. Your edited feedback is kept but NOT saved. Saving it separately requires confirmation.');
  }
}
async function reconcileSave() {
  const attempt = pendingSave;
  if (!attempt) return;
  const result = await (await api('api/comments/reconcile', attempt)).json();
  if (pendingSave !== attempt) return;
  if (result.comment) finishSave(attempt, result.comment);
  else {
    pendingSave = null; pendingId = crypto.randomUUID();
    actionStatus('Previous attempt was not saved and is now closed. Feedback kept; choose Save comment to retry.');
  }
}
async function api(route, data) {
  const response = await fetch(`${base}/${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-Galley': '1' }) }, body: data === undefined ? undefined : JSON.stringify(data), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!response.ok) { let detail; try { detail = (await response.json()).error; } catch {} throw Object.assign(new Error(detail || `Request failed (${response.status})`), { status: response.status }); }
  return response;
}
function selectAnchor(blockId, quote, offset) {
  const block = current?.blocks.find(b => b.id === blockId);
  if (!block || !quote || offset < 0 || block.text.slice(offset, offset + quote.length) !== quote) return null;
  return { revision: current.revision, block: blockId, quote, offset, prefix: block.text.slice(Math.max(0, offset - 80), offset), suffix: block.text.slice(offset + quote.length, offset + quote.length + 80) };
}
function capture() {
  const selection = getSelection();
  if (!selection.rangeCount || selection.isCollapsed) return;
  captured = null; // An active invalid selection must never reuse an older quote.
  const range = selection.getRangeAt(0);
  const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const block = element?.closest('[data-block]');
  if (!block || !block.contains(range.endContainer) || !block.closest('#document')) return;
  const before = range.cloneRange(); before.selectNodeContents(block); before.setEnd(range.startContainer, range.startOffset);
  const rawQuote = range.toString(), quote = norm(rawQuote);
  const preceding = before.toString().replace(/\s+/g, ' ').trimStart();
  const leadingSpace = /^\s/.test(rawQuote) && preceding.length && !/\s$/.test(preceding) ? 1 : 0;
  captured = selectAnchor(block.dataset.block, quote, preceding.length + leadingSpace);
}
document.addEventListener('selectionchange', capture);
$('add').addEventListener('pointerdown', capture); // Before button focus collapses native selection.
function compose(selected) {
  if (busy || pendingSave) return actionStatus('Resolve the current save before choosing another quote. Feedback kept.');
  if (!selected) return actionStatus('Select text within one block, or use Comment on block.');
  if (anchor && $('message').value && !confirm('Replace the current quote? Your message will be kept.')) return;
  anchor = selected; pendingId = crypto.randomUUID();
  $('quote').textContent = anchor.quote; $('composer').hidden = false;
  $('selection-state').textContent = anchor.revision === current.revision ? 'Selection captured' : 'Draft changed — reselect before saving';
  // Scroll the editable controls, not a potentially viewport-tall quote, above the fixed footer.
  $('composer-controls').style.scrollMarginBottom = `${document.querySelector('footer').getBoundingClientRect().height + 16}px`;
  $('composer-controls').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('message').focus({ preventScroll: true });
}
$('add').onclick = () => compose(captured);
$('document').onclick = event => {
  const id = event.target.closest('[data-comment]')?.dataset.comment;
  if (id) { const block = current.blocks.find(b => b.id === id); compose(selectAnchor(id, block.text.slice(0, 12000), 0)); }
};
$('cancel').onclick = () => { if (busy) return; if (pendingSave) return actionStatus('Save outcome unresolved. Reconnect or choose Save to reconcile before discarding.'); if ($('message').value && !confirm('Discard this unfinished comment?')) return; anchor = null; pendingId = null; savedOriginal = false; $('message').value = ''; $('composer').hidden = true; };
$('save').onclick = async () => {
  if (busy || !anchor) return;
  busy = true; $('save').disabled = true; $('message').disabled = true; $('cancel').disabled = true;
  try {
    if (pendingSave) { await reconcileSave(); await refresh(); return; }
    if (savedOriginal && !confirm('The original comment is already saved in history. Save this edited feedback as a separate comment?')) return;
    savedOriginal = false;
    pendingSave = structuredClone(composerPayload());
    const result = await (await api('api/comments', pendingSave)).json();
    finishSave(pendingSave, result); await refresh();
  } catch (error) {
    if ([400, 413, 415].includes(error.status)) {
      // These local request-validation failures cannot have committed a comment.
      pendingSave = null; pendingId = crypto.randomUUID();
      actionStatus(`${error.message}. Comment not saved; feedback kept for correction.`);
    } else actionStatus(`${error.message}. Save outcome unresolved; feedback kept. Reconnect or choose Save to reconcile before retrying.`);
  }
  finally { busy = false; $('save').disabled = false; $('message').disabled = false; $('cancel').disabled = false; }
};
function historyView(comments) {
  $('history').replaceChildren();
  for (const comment of comments) {
    const card = document.createElement('div'); card.className = 'comment';
    const quote = document.createElement('blockquote'); quote.textContent = comment.anchor.quote;
    const message = document.createElement('p'); message.textContent = comment.message;
    const state = document.createElement('p'); state.textContent = `${comment.status} · text revision ${comment.anchor.revision.slice(0, 8)}${comment.anchor.revision !== current.revision ? ' · draft text has changed' : ''}`;
    card.append(quote, message, state);
    if (comment.status === 'saved') {
      const send = document.createElement('button'); send.textContent = 'Send to editing session';
      send.disabled = comment.anchor.revision !== current.revision;
      send.onclick = async () => { send.disabled = true; try { const result = await (await api(`api/comments/${comment.id}/send`, {})).json(); actionStatus(result.status === 'uncertain' ? 'Delivery uncertain. Check the editing session; do not resend blindly.' : 'Accepted by session — edit completion not confirmed'); } catch (error) { actionStatus(`${error.message}. Delivery not confirmed; check history/session before retrying.`); } finally { await refresh(); } };
      card.append(send);
    }
    if (comment.status === 'uncertain') { const warning = document.createElement('p'); warning.textContent = 'Check the editing session directly. No automatic retry is allowed.'; card.append(warning); }
    $('history').append(card);
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await (await api('api/document')).json();
    const changed = (next.presentationRevision || next.revision) !== (current?.presentationRevision || current?.revision);
    const textChanged = next.revision !== current?.revision;
    // Do not replace DOM while a native selection is active; retry after collapse.
    if (changed && current && !getSelection().isCollapsed) { status('Draft update waiting — finish selecting, then tap elsewhere'); return; }
    if (changed) {
      const topBlock = [...$('document').querySelectorAll('[data-block]')].find(b => b.getBoundingClientRect().bottom > 80);
      const priorY = scrollY, priorTop = topBlock?.getBoundingClientRect().top;
      for (const url of imageUrls) URL.revokeObjectURL(url); imageUrls = [];
      // HTML is produced only by the pinned server renderer/sanitizer boundary.
      $('document').innerHTML = next.html;
      $('sections').replaceChildren(new Option('Choose a section', ''), ...next.sections.map(s => new Option(s.title, s.id)));
      current = next; captured = null;
      if (anchor && textChanged) $('selection-state').textContent = 'Draft text changed — message preserved. Reselect a quote before saving.';
      const restored = topBlock && document.getElementById(topBlock.id);
      if (restored) scrollBy(0, restored.getBoundingClientRect().top - priorTop); else scrollTo(0, priorY);
      for (const img of $('document').querySelectorAll('img')) {
        const source = `image/${img.dataset.image}`;
        try { const blob = await (await api(source)).blob(); if (!img.isConnected) continue; const url = URL.createObjectURL(blob); imageUrls.push(url); img.src = url; }
        catch { img.alt = `${img.alt} (image unavailable)`; }
      }
    } else current = next;
    historyView(next.comments);
    status(`Connected · text revision ${next.revision.slice(0, 8)}`);
    if (pendingSave && !busy) {
      try { await reconcileSave(); }
      catch (error) { actionStatus(`${error.message}. Save outcome unresolved; feedback kept.`); }
    }
  } catch (error) { status(`${error.message}. Unfinished comment kept in this tab.`); }
  finally { refreshing = false; }
}
$('sections').onchange = () => document.getElementById($('sections').value)?.scrollIntoView();
$('revoke').onclick = async () => { if (!confirm('Revoke this private review link?')) return; try { await api('api/revoke', {}); status('Link revoked'); $('document').replaceChildren(); } catch (error) { status(error.message); } };
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', refresh);
window.addEventListener('beforeunload', event => { if ($('message').value) { event.preventDefault(); event.returnValue = ''; } });
if (token) { refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 3000); }
else status('Open a private review link issued on the Mac. No document is public.');
