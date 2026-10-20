import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
// HISTORICAL FAKE-HOST TEST FIXTURE ONLY. Unsafe singleton auth is not operational.
import { boundedRead } from '../../src/files.mjs';
import { readPrivate, privateDirectory } from '../../src/private.mjs';
import { hash } from '../../src/renderer.mjs';

export const settingsFile = path.join(os.homedir(), '.config/openchamber/settings.json');
export const credentialDirectory = path.join(os.homedir(), '.local/share/galley-client');
export const installedServerId = 'fake-installed-server';
export async function discoverPort(file = settingsFile) {
  const { desktopLocalPort } = JSON.parse(await boundedRead(file, 65536));
  if (!Number.isInteger(desktopLocalPort) || desktopLocalPort < 1 || desktopLocalPort > 65535) throw new Error('Invalid desktop port');
  return desktopLocalPort;
}
// Direct sockets only: no environment proxy, redirects, cookies, retries or alternate host.
export function localJSON(port, method, route, { token, body, signal, timeout = 5000, max = 2 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !route.startsWith('/') || route.startsWith('//')) throw new Error('Invalid local request');
  const bytes = body === undefined ? undefined : JSON.stringify(body);
  if (bytes && Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error('Request limit');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => req.destroy(new Error('Desktop deadline')), timeout);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, agent: false, signal,
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) } : {}) } }, res => {
      let n = 0; const chunks = [];
      res.on('data', chunk => { n += chunk.length; if (n > max) req.destroy(new Error('Desktop response limit')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300 || !/^application\/json\b/i.test(res.headers['content-type'] || '')) return reject(Object.assign(new Error('Desktop HTTP failure'), { status: res.statusCode }));
        try { resolve(JSON.parse(Buffer.concat(chunks))); } catch { reject(new Error('Desktop schema failure')); }
      });
    });
    req.once('close', () => clearTimeout(timer)); req.once('error', reject); req.end(bytes);
  });
}
export function identity(serverId, clientId) { return `galley:${hash(JSON.stringify([serverId, clientId]))}`; }
export function verifyClient(client, expected) {
  if (!client || client.id !== expected.clientId || client.clientKind !== 'desktop' || client.authMethod !== 'pairing' || client.pairingId !== expected.pairingId || client.usesRelay !== false || client.revokedAt !== null || !(client.expiresAt === null || (typeof client.expiresAt === 'string' && Date.parse(client.expiresAt) > Date.now()))) throw new Error('Galley client invalid or revoked');
}
export async function verifyHealth(port, serverId, signal) {
  const health = await localJSON(port, 'GET', '/health', { signal, max: 65536 });
  if (health.status !== 'ok' || health.serverId !== serverId) throw new Error('Desktop server identity changed');
}
export function exactAdmission(ack, sessionId, prompt) {
  return ack?.id === prompt.id && ack.sessionID === sessionId && ack.type === 'user' && ack.delivery === 'queue' &&
    ack.payload?.text === prompt.text && Object.keys(ack.payload).length === 1 && Number.isFinite(ack.time?.created) && ack.time.created > 0;
}
export function desktopTransport({ binding, credentials = credentialDirectory, settings = settingsFile }) {
  if (!credentials.includes('/.test-galley-')) throw new Error('Retired: synthetic test fixture only');
  if (!binding.agent || !path.isAbsolute(binding.sessionDirectory)) throw new Error('Exact writer agent/directory required');
  async function connection(signal) {
    await privateDirectory(credentials, binding.sessionDirectory);
    const c = await readPrivate(path.join(credentials, 'credential.json'));
    if (!c || typeof c.token !== 'string' || !/^[\w-]{20,512}$/.test(c.token) || typeof c.serverId !== 'string' || !c.clientId || !c.pairingId || !Number.isInteger(c.port) || identity(c.serverId, c.clientId) !== binding.upstreamIdentity) throw new Error('Invalid Galley credential');
    const port = await discoverPort(settings);
    if (port !== c.port) throw new Error('Desktop port changed; operator review required');
    await verifyHealth(port, c.serverId, signal);
    const own = await localJSON(port, 'GET', '/api/client-auth/clients', { token: c.token, signal, max: 65536 });
    if (!Array.isArray(own.clients) || own.clients.length !== 1) throw new Error('Not own-client authentication');
    verifyClient(own.clients[0], c);
    return { port, token: c.token };
  }
  async function request(method, route, body, signal) {
    const c = await connection(signal);
    return localJSON(c.port, method, route, { token: c.token, body, signal });
  }
  async function inspect(id, { signal } = {}) {
    if (!/^ses_[\w-]+$/.test(id) || id !== binding.sessionId) throw new Error('Session not enrolled');
    const { data: s } = await request('GET', `/api/session/${id}`, undefined, signal);
    if (s?.id !== id || s.location?.directory !== binding.sessionDirectory || s.agent !== binding.agent) throw new Error('Writer identity changed');
    return { id, directory: s.location.directory, agent: s.agent, upstreamIdentity: binding.upstreamIdentity };
  }
  return {
    inspect,
    async submit(p) {
      if (p.sessionId !== binding.sessionId || p.directory !== binding.sessionDirectory || p.upstreamIdentity !== binding.upstreamIdentity || !/^msg_[\w-]+$/.test(p.messageId) || typeof p.text !== 'string') throw new Error('Submission binding mismatch');
      await inspect(p.sessionId, { signal: p.signal });
      const prompt = { id: p.messageId, text: p.text, delivery: 'queue', resume: true };
      const { data } = await request('POST', `/api/session/${p.sessionId}/prompt`, prompt, p.signal);
      if (!exactAdmission(data, p.sessionId, prompt)) throw new Error('Uncertain durable admission');
      return { accepted: true, messageId: p.messageId };
    },
    async reconcile(comment) {
      await inspect(binding.sessionId);
      if (!/^msg_[\w-]+$/.test(comment.messageId) || typeof comment.payload?.text !== 'string') throw new Error('No immutable attempt');
      const { data: inbox } = await request('GET', `/api/session/${binding.sessionId}/inbox`);
      if (!Array.isArray(inbox)) throw new Error('Invalid inbox');
      const item = inbox.find(x => x.id === comment.messageId);
      if (item) return { status: exactAdmission(item, binding.sessionId, { id: comment.messageId, text: comment.payload.text }) ? 'admitted-inbox' : 'conflict' };
      try {
        const { data: message } = await request('GET', `/api/session/${binding.sessionId}/message/${comment.messageId}`);
        return { status: message?.id === comment.messageId && message.type === 'user' && message.text === comment.payload.text && ['files', 'agents', 'skills'].every(k => message[k] === undefined || (Array.isArray(message[k]) && message[k].length === 0)) ? 'observed-message' : 'conflict' };
      } catch (e) { if (e.status === 404) return { status: 'absent-not-retryable' }; throw e; }
    },
    request, // Startup helper only, never exposed to browser routes.
  };
}
