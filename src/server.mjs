import http from 'node:http';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readImage, validateBinding } from './files.mjs';
import { presentationReader, validateAnchor, hash } from './renderer.mjs';
import { checkSession, disconnected, feedbackPrompt } from './upstream.mjs';
import { reviewState, collectNote, sendBatch } from './review.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const continuousWeb = fileURLToPath(new URL('../staged/continuous-web/', import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), { status });
const deadline = (promise, milliseconds = 6000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Upstream timeout')), milliseconds); })]).finally(() => clearTimeout(timer));
};
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'JSON required');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 32768) throw fail(413, 'Request too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, 'Invalid JSON'); }
}

export async function startServer({ store: defaultStore, prefix = '/galley', port = 0, publicOrigin, upstream: defaultUpstream = disconnected, resolveReview, deliveryTimeout = 6000, webDirectory = continuousWeb, historicalTestMode = false }) {
  if (!['', '/galley'].includes(prefix)) throw new Error('Unsupported prefix');
  if (defaultStore) await validateBinding(defaultStore.state.binding);
  if (!defaultStore && !resolveReview) throw new Error('Review enrollment required');
  let origin;
  const snapshot = async (store, document) => {
    const doc = await document();
    await store.transaction(s => {
      if (s.observations.at(-1)?.presentationRevision !== doc.presentationRevision) {
        s.observations.push({ revision: doc.revision, presentationRevision: doc.presentationRevision, observedAt: new Date().toISOString() });
        s.observations = s.observations.slice(-256);
      }
    });
    return { revision: doc.revision, presentationRevision: doc.presentationRevision, html: doc.html, text: doc.text, ...reviewState(store.state, doc), sections: doc.sections, blocks: doc.blocks.map(({ id, text }) => ({ id, text })), comments: store.state.comments, observations: store.state.observations };
  };
  const requests = new Set();
  const server = http.createServer((req, res) => {
    const work = handle(req, res); requests.add(work);
    void work.then(() => requests.delete(work), () => requests.delete(work));
  });
  async function handle(req, res) {
    const security = {
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    };
    for (const [key, value] of Object.entries(security)) res.setHeader(key, value);
    const send = (status, payload, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(type === 'application/json' ? JSON.stringify(payload) : payload);
    };
    try {
      // No URL/query/request logging. Do not trust forwarded-host/origin headers.
      // Fleet's fixed loopback probe carries no review/native authority. Only
      // this exact inert GET may bypass the configured public Host gate.
      if (prefix === '/galley' && req.method === 'GET' && req.url === '/galley/health' && req.headers.host === '127.0.0.1:4177') return send(200, { ok: true });
      if (req.headers.host !== new URL(origin).host) throw fail(403, 'Host denied');
      const url = new URL(req.url, origin);
      if (url.search || /%|\\/.test(url.pathname)) throw fail(400, 'Invalid URL');
      const route = url.pathname.slice(prefix.length);
      if (!url.pathname.startsWith(`${prefix}/`)) throw fail(404, 'Not found');
      if (prefix === '/galley' && req.method === 'GET' && route === '/health') return send(200, { ok: true });
      // Isolated synthetic interaction preview. Exact static allowlist only;
      // no document reader, store transaction, credentials or native API.
      const previewFiles = { '/preview': ['preview.html', 'text/html'], '/preview.js': ['preview.js', 'text/javascript'], '/preview.css': ['preview.css', 'text/css'] };
      if (req.method === 'GET' && Object.hasOwn(previewFiles, route)) {
        const [name, type] = previewFiles[route];
        return send(200, await fs.readFile(web + name), `${type}; charset=utf-8`);
      }
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(route)) {
        const name = route === '/' ? 'index.html' : route.slice(1);
        // Preserve old asset URLs for an old HTML response in flight at restart.
        // Its mutation routes refuse safely; never pair old DOM with new JS.
        const directory = route === '/' ? webDirectory : web;
        return send(200, await fs.readFile(new URL(name, `file://${directory.endsWith('/') ? directory : directory + '/'}`)), route === '/' ? 'text/html; charset=utf-8' : route.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      }
      if (req.method === 'GET' && ['/continuous-v2/app.js', '/continuous-v2/style.css'].includes(route)) {
        const name = route.split('/').at(-1);
        return send(200, await fs.readFile(new URL(name, `file://${webDirectory.endsWith('/') ? webDirectory : webDirectory + '/'}`)), route.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      }
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      // Operator-owned registry only. Browser tokens can select solely an already
      // enrolled capability, never a directory, pack, session or native method.
      const selected = resolveReview ? await resolveReview(token) : undefined;
      const store = selected?.store || defaultStore;
      const upstream = selected?.upstream || defaultUpstream;
      if (!store) throw fail(401, 'Review link expired or revoked');
      const document = presentationReader(store.state.binding);
      const authorize = () => { if (!store.authorized(token)) throw fail(401, 'Review link expired or revoked'); };
      authorize();
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin)) throw fail(403, 'Origin denied');
      if (req.method !== 'GET' && (req.headers.origin !== origin || req.headers['x-galley'] !== '1')) throw fail(403, 'CSRF guard');
      if (req.method === 'GET' && route === '/api/document') return send(200, await snapshot(store, document));
      if (req.method === 'POST' && route === '/api/notes') return send(200, await collectNote({ store, document, authorize, data: await body(req) }));
      if (req.method === 'POST' && route === '/api/batches') {
        const result = await sendBatch({ store, document, authorize, data: await body(req), upstream, deliveryTimeout });
        const { payload, ...visible } = result;
        return send(200, visible);
      }
      const image = /^\/image\/([a-f0-9]{32})$/.exec(route);
      if (req.method === 'GET' && image) {
        const doc = await document();
        const file = doc.images[image[1]];
        if (!file) throw fail(404, 'Image not in current document');
        const { data, type } = await readImage(file);
        if (hash(data) !== doc.assetDigests[file]) throw fail(409, 'Image changed; refresh the draft');
        return send(200, data, type);
      }
      if (req.method === 'POST' && route === '/api/revoke') {
        await body(req);
        await store.transaction(s => { authorize(); s.capabilities.find(c => c.digest === hash(token)).revoked = true; });
        return send(200, { revoked: true });
      }
      if (req.method === 'POST' && ['/api/comments', '/api/comments/reconcile'].includes(route)) {
        if (!historicalTestMode) throw fail(409, 'This review client is retired. Reload for continuous review; historical comments retained without replay');
        const data = await body(req);
        if (!data || !/^[a-f\d-]{36}$/i.test(data.id) || typeof data.message !== 'string' || !data.message.trim() || data.message.length > 8000) throw fail(400, 'Invalid comment');
        const comment = await store.transaction(async s => {
          authorize();
          const existing = s.comments.find(c => c.id === data.id);
          const fingerprint = hash(JSON.stringify({ anchor: data.anchor, message: data.message }));
          if (existing) {
            if (existing.fingerprint !== fingerprint) throw fail(409, 'Comment ID already used');
            return route.endsWith('/reconcile') ? { comment: existing } : existing;
          }
          s.closedSaves ||= [];
          if (route.endsWith('/reconcile')) {
            // Serialized with saves: fence a delayed request before reporting absence.
            if (!s.closedSaves.includes(data.id)) {
              if (s.closedSaves.length >= 1000) throw fail(409, 'Save reconciliation history full; archive locally');
              s.closedSaves.push(data.id);
            }
            return { comment: null };
          }
          if (s.closedSaves.includes(data.id)) throw fail(409, 'Save attempt closed; reconcile before retrying');
          if (s.comments.length >= 1000) throw fail(409, 'Review history full; archive locally');
          const anchor = validateAnchor(data.anchor, await document());
          const comment = { id: data.id, message: data.message, anchor, fingerprint, status: 'saved', savedAt: new Date().toISOString(), messageId: `msg_${randomUUID().replaceAll('-', '')}` };
          if (Buffer.byteLength(JSON.stringify(s)) + Buffer.byteLength(JSON.stringify(comment)) > 12 * 1024 * 1024) throw fail(409, 'Review storage full; archive locally');
          s.comments.push(comment); return comment;
        });
        return send(200, comment);
      }
      const delivery = /^\/api\/comments\/([a-f\d-]{36})\/send$/i.exec(route);
      if (req.method === 'POST' && delivery) {
        if (!historicalTestMode) throw fail(409, 'Individual delivery is retired. Historical comments are not replayed');
        await body(req);
        const comment = await store.transaction(async (s, persist) => {
          authorize();
          const c = s.comments.find(c => c.id === delivery[1]);
          if (!c) throw fail(404, 'Comment not found');
          if (c.status !== 'saved') return c; // Idempotent, never blindly resubmit.
          validateAnchor(c.anchor, await document());
          try { await deadline(checkSession(upstream, s.binding), deliveryTimeout); }
          catch { throw fail(409, 'Upstream unavailable or binding changed; comment remains saved'); }
          authorize();
          validateAnchor(c.anchor, await document());
          c.payload ||= { id: c.messageId, text: feedbackPrompt(c), delivery: 'queue', resume: true };
          c.status = 'sending'; c.attemptedAt = new Date().toISOString();
          await persist(); // Crash from here onward is uncertain, not retryable.
          try {
            const receipt = await deadline(upstream.submit({ sessionId: s.binding.sessionId, directory: s.binding.sessionDirectory, upstreamIdentity: s.binding.upstreamIdentity, messageId: c.messageId, text: c.payload.text, signal: AbortSignal.timeout(deliveryTimeout) }), deliveryTimeout);
            if (!receipt || receipt.accepted !== true || receipt.messageId !== c.messageId) throw new Error('No exact acknowledgment');
            c.status = 'accepted'; c.acceptedAt = new Date().toISOString();
          } catch { c.status = 'uncertain'; }
          return c;
        });
        return send(200, comment);
      }
      throw fail(404, 'Not found');
    } catch (error) {
      // Internal exceptions may contain paths/credentials. Never expose them.
      if (!res.headersSent && !res.destroyed) send(error.status || 500, { error: error.status ? error.message : 'Local review unavailable; check enrolled files and private state' });
      else res.destroy();
    }
  }
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 32;
  server.maxConnections = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = publicOrigin || `http://127.0.0.1:${server.address().port}`;
  try {
    const u = new URL(origin);
    if (u.origin !== origin || (!['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol !== 'https:')) throw new Error('Exact origin required');
  } catch (error) { server.close(); throw error; }
  return { server, origin, async close() {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // A disconnected HTTP response cannot cancel an already-journaled native
    // admission. Drain bounded handlers BEFORE the owner releases its store lock.
    await Promise.allSettled([...requests]);
  } };
}
