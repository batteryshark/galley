import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const source = await fs.readFile(new URL('../staged/continuous-web/app.js', import.meta.url), 'utf8');
function harness() {
  class Element {
    constructor() { this.children = []; this.value = ''; this.hidden = true; this.style = {}; this.listeners = {}; this.offsetHeight = 100; this.offsetWidth = 342; }
    append(...n) { this.children.push(...n); } replaceChildren(...n) { this.children = n; }
    addEventListener(name, fn) { this.listeners[name] = fn; } setAttribute() {} contains() { return false; }
    querySelectorAll() { return []; } focus() {} blur() {} getBoundingClientRect() { return { top: 0, bottom: 0 }; }
  }
  const elements = Object.fromEntries(['document', 'comment', 'composer', 'highlights', 'notes-toggle', 'notes', 'note-list', 'state', 'compose-state', 'send'].map(id => [id, new Element()]));
  const saved = new Map(), calls = [], doc = { revision: 'r1', presentationRevision: 'p1', text: 'Alpha\nBeta', html: '', notes: [], batches: [] };
  let fail, offline = false;
  const context = vm.createContext({
    location: { hash: '', pathname: '/galley/' }, history: { replaceState() {} },
    document: { getElementById: id => elements[id], addEventListener() {}, createElement: () => new Element(), createTreeWalker: () => ({ nextNode: () => false }) },
    window: { addEventListener() {} }, visualViewport: undefined, scrollX: 0, scrollY: 0, innerWidth: 390, innerHeight: 844,
    NodeFilter: { SHOW_TEXT: 4 }, getSelection: () => ({ isCollapsed: true }), scrollBy() {}, scrollTo() {},
    crypto: { randomUUID }, structuredClone, AbortSignal, confirm: () => true, setTimeout, clearTimeout,
    async fetch(url, options) {
      const route = url.split('/galley/')[1], data = options.body && JSON.parse(options.body); calls.push({ route, data });
      if (offline) throw new Error('Offline');
      const response = (payload, status = 200) => ({ ok: status === 200, status, json: async () => structuredClone(payload) });
      if (route === 'api/document') return response({ ...doc, notes: [...saved.values()] });
      if (route === 'api/notes') {
        if (fail === 'before') throw new Error('Response lost');
        const n = saved.get(data.id);
        if (n?.lastOperation === data.operationId) return response(n);
        if (fail === 'invalid') return response({ error: 'Invalid note' }, 400);
        if (fail === 'server') return response({ error: 'Server failure' }, 500);
        if (fail === 'reject' || n && data.expectedVersion !== n.version) return response({ error: 'Conflict' }, 409);
        const next = { ...data, version: (n?.version || 0) + 1, lastOperation: data.operationId, status: 'pending', located: data.anchor }; saved.set(data.id, next);
        if (fail === 'after') throw new Error('Response lost');
        return response(next);
      }
      if (route === 'api/batches') {
        if (fail === 'batch') throw new Error('Send reply lost');
        return response({ id: data.id, status: 'uncertain' });
      }
      return response({});
    },
  });
  vm.runInContext(source, context); context.doc = doc;
  const run = js => vm.runInContext(js, context);
  run('current = structuredClone(doc)');
  return { elements, saved, calls, doc, run,
    set fail(v) { fail = v; }, set offline(v) { offline = v; },
    compose(text = 'My comment') { context.testText = text; run('{ const d = { id: crypto.randomUUID(), anchor: { kind: "continuous", revision: "r1", offset: 0, quote: "Alpha", prefix: "", suffix: "\\nBeta" }, text: testText, savedText: "", version: 0 }; drafts.set(d.id, d); open(d); }'); },
    commit() { return run('commit(active || [...drafts.values()][0])'); },
  };
}
test('accepted client has only top Send + count, contextual accessible textarea, no browser note storage', async () => {
  const html = await fs.readFile(new URL('../staged/continuous-web/index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/<button /g) || []).length, 2); assert.match(html, /id="send"/); assert.match(html, /aria-label="Comment on selected passage"/);
  assert.doesNotMatch(html, /footer|select |id="save"|id="cancel"/); assert.doesNotMatch(source, /localStorage|sessionStorage|api\/comments/);
});
for (const loss of ['before', 'after']) test(`automatic collect reconciles ${loss}-commit response loss with same operation and retains later typing`, async () => {
  const h = harness(); h.compose(); h.fail = loss; await h.commit();
  assert.match(h.elements['compose-state'].textContent, /kept/); const op = h.calls.find(c => c.route === 'api/notes').data.operationId;
  h.run('active.text = "Later typing"'); h.fail = null; await h.commit();
  assert.equal(h.calls.filter(c => c.route === 'api/notes')[1].data.operationId, op);
  assert.equal(h.saved.size, 1); assert.equal([...h.saved.values()][0].message, 'My comment');
  assert.equal(h.run('active.text'), 'Later typing'); assert.equal(h.elements.send.disabled, true);
  await h.commit(); assert.equal([...h.saved.values()][0].message, 'Later typing'); assert.equal([...h.saved.values()][0].version, 2);
});
test('conflict/revision/expiry rejection keeps original quote and typed text; polling cannot label it saved', async () => {
  const h = harness(); h.compose(); h.fail = 'reject'; await h.commit(); await h.run('refresh()');
  assert.equal(h.run('active.text'), 'My comment'); assert.equal(h.run('active.anchor.quote'), 'Alpha');
  assert.match(h.elements['compose-state'].textContent, /Conflict/); assert.equal(h.elements.send.disabled, true);
  h.offline = true; await h.run('refresh()'); assert.match(h.elements.state.textContent, /not synced/);
});
test('service count excludes unacknowledged local text; IME never commits partial composition', async () => {
  const h = harness(); h.compose(); h.run('composing = true; close()');
  assert.equal(h.calls.length, 0); assert.equal(h.run('!!active'), true); assert.match(h.elements['notes-toggle'].textContent, /^0 notes/);
  h.elements.comment.value = 'Complete café'; h.elements.comment.listeners.compositionend();
  await new Promise(r => setImmediate(r)); assert.equal(h.saved.size, 1); assert.equal([...h.saved.values()][0].message, 'Complete café');
});
test('send errors survive polls; exact batch identity survives response loss; uncertain never labeled Connected', async () => {
  const h = harness(); h.run('batchAttempt = { id: crypto.randomUUID(), revision: "r1" }'); h.fail = 'batch'; await h.run('attemptBatch()');
  const id = h.run('batchAttempt.id'); await h.run('refresh()'); assert.match(h.elements.state.textContent, /Send reply lost/);
  h.fail = null; await h.run('attemptBatch()'); assert.equal(h.calls.filter(c => c.route === 'api/batches')[1].data.id, id);
  assert.match(h.elements.state.textContent, /uncertain/); assert.doesNotMatch(h.elements.state.textContent, /Connected/);
});
test('refresh defers DOM replacement during active composition without replacing draft or ignoring shared notes', async () => {
  const h = harness(); h.compose(); h.doc.presentationRevision = 'p2'; h.doc.revision = 'r2'; await h.run('refresh()');
  assert.equal(h.run('current.revision'), 'r1'); assert.equal(h.run('active.text'), 'My comment');
});
test('refresh carries unchanged decoded image dimensions before scroll restoration without overriding authored sizes', async () => {
  const h = harness();
  const old = { dataset: { image: 'same' }, naturalWidth: 1200, naturalHeight: 400, width: 32, height: 32 };
  const fresh = { dataset: { image: 'same' }, hasAttribute: () => false };
  const authored = { dataset: { image: 'same' }, width: 32, height: 32, hasAttribute: () => true };
  const changed = { dataset: { image: 'different' }, hasAttribute: () => false };
  let replaced = false;
  Object.defineProperty(h.elements.document, 'innerHTML', { set() { replaced = true; } });
  h.elements.document.querySelectorAll = selector => selector === 'img[data-image]' ? replaced ? [fresh, authored, changed] : [old] : [];
  h.doc.presentationRevision = 'p2'; await h.run('refresh()');
  assert.deepEqual([fresh.width, fresh.height], [1200, 400]);
  assert.deepEqual([authored.width, authored.height], [32, 32]);
  assert.equal(changed.width, undefined);
});
test('definitive validation rejection permits corrected text to make a real request and unlock Send', async () => {
  const h = harness(); h.compose('x'.repeat(8001)); h.fail = 'invalid'; await h.commit();
  assert.match(h.elements['compose-state'].textContent, /Invalid note/);
  h.fail = null; await h.commit(); assert.equal(h.calls.filter(c => c.route === 'api/notes').length, 1);
  h.elements.comment.value = 'Corrected'; h.elements.comment.listeners.input();
  await h.commit();
  const calls = h.calls.filter(c => c.route === 'api/notes');
  assert.equal(calls.length, 2); assert.notEqual(calls[0].data.operationId, calls[1].data.operationId);
  assert.equal([...h.saved.values()][0].message, 'Corrected'); assert.equal(h.elements.send.disabled, false);
});
test('stale local new note can be explicitly discarded and replaced without an orphan dirty Send lock', async () => {
  const h = harness(); h.compose(); h.fail = 'reject'; await h.commit();
  assert.match(h.elements['note-list'].children[0].children[2].textContent, /discard.*reselect/);
  h.elements['note-list'].children[1].onclick();
  assert.equal(h.run('drafts.size'), 0); assert.equal(h.run('active'), null); assert.equal(h.saved.size, 0);
  h.run('current = structuredClone(doc)'); h.compose('Replacement'); h.fail = null; await h.commit();
  assert.equal(h.saved.size, 1); assert.equal(h.elements.send.disabled, false); assert.equal(h.run('drafts.size'), 1);
});
test('conflicting shared edit stays blocked until explicit latest-version review; local discard keeps server note', async () => {
  const h = harness(); h.compose(); await h.commit();
  const id = h.run('active.id'); h.saved.get(id).version = 2; h.saved.get(id).message = 'Other device';
  h.elements.comment.value = 'My conflicting correction'; h.elements.comment.listeners.input(); await h.commit();
  await h.run('refresh()'); await h.commit();
  assert.equal(h.saved.get(id).message, 'Other device'); assert.equal(h.run('active.errorKind'), 'conflict');
  h.elements['note-list'].children[0].onclick(); await h.commit();
  assert.equal(h.saved.get(id).message, 'My conflicting correction'); assert.equal(h.saved.get(id).version, 3);
  h.saved.get(id).version = 4; h.saved.get(id).message = 'Keep this server note';
  h.elements.comment.value = 'Discard this local edit'; h.elements.comment.listeners.input(); await h.commit(); await h.run('refresh()');
  h.elements['note-list'].children[1].onclick();
  assert.equal(h.saved.get(id).message, 'Keep this server note'); assert.equal(h.run('drafts.size'), 0); assert.equal(h.elements.send.disabled, false);
});
test('uncertain operation cannot be discarded or replaced via latest-version confirmation, including HTTP 5xx', async () => {
  for (const loss of ['after', 'server']) {
    const h = harness(); h.compose(); h.fail = loss; await h.commit(); await h.run('refresh()');
    const op = h.run('active.attempt.operationId');
    assert.equal(h.elements['note-list'].children.length, 1);
    h.elements['note-list'].children[0].onclick();
    await new Promise(r => setImmediate(r));
    if (h.run('!!active.attempt')) {
      assert.equal(h.run('active.attempt.operationId'), op);
      h.fail = null; await h.commit();
    }
    assert.ok(h.calls.filter(c => c.route === 'api/notes').every(c => c.data.operationId === op)); assert.equal(h.saved.size, 1);
  }
});
test('selection equality guard reports an anchoring failure visibly instead of silently refusing', async () => {
  const h = harness(); await h.run('refresh()');
  h.run(`article.contains = () => true;
    document.createRange = () => ({ selectNodeContents() {}, setEnd() {}, toString: () => '' });
    getSelection = () => ({ rangeCount: 1, isCollapsed: false, toString: () => 'Alpha', getRangeAt: () => ({ startContainer: {}, endContainer: {}, startOffset: 0 }) });
    current.text = 'Different'; takeSelection();`);
  assert.match(h.elements.state.textContent, /Selection could not be anchored safely/);
  assert.equal(h.run('drafts.size'), 0);
});
