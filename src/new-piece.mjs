import path from 'node:path';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { execFile } from 'node:child_process';
import { canonical, sha256 } from './writing-pack.mjs';
import { preparePackWriter, guidance, advanceWriterState } from './pack-writer.mjs';
import { noLinks, inside } from './files.mjs';
import { privateDirectory, readPrivate, writePrivate } from './private.mjs';
import { openStore } from './store.mjs';
import { openNative } from './native-ipc.mjs';

const run = promisify(execFile);
const validID = id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
const stateEntry = id => /^[a-f0-9]{12}$/.test(id);
export function pieceID(title) {
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 46).replace(/-+$/, '') || 'piece'}-${sha256(title).slice(0, 12)}`;
}
export async function validatePieceConfig(c) {
  if (c?.version !== 1) throw new Error('Piece configuration version required');
  for (const key of ['piecesDirectory', 'stateDirectory', 'controlDirectory']) canonical(c[key]);
  if (inside(c.piecesDirectory, c.controlDirectory) || inside(c.controlDirectory, c.piecesDirectory)) throw new Error('Control must be separate from writer projects');
  if (inside(c.piecesDirectory, c.stateDirectory) || inside(c.stateDirectory, c.piecesDirectory)) throw new Error('Separate piece and control roots required');
  if (Buffer.byteLength(path.join(c.stateDirectory, '000000000000', 'native', 'ipc.sock')) > 100) throw new Error('Use a shorter private stateDirectory for Unix IPC');
  const u = new URL(c.publicOrigin);
  if (u.origin !== c.publicOrigin || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))) throw new Error('Exact review origin required');
  if (!c.model || !['id', 'providerID'].every(k => typeof c.model[k] === 'string' && c.model[k].length > 0 && c.model[k].length <= 240) || (c.model.variant !== undefined && (typeof c.model.variant !== 'string' || !c.model.variant)) || Object.keys(c.model).some(k => !['id', 'providerID', 'variant'].includes(k))) throw new Error('Explicit writer model required');
  if (!c.runtime || c.runtime.version !== '2.0.32') throw new Error('Verified native runtime version required');
  const server = new URL(c.runtime.server);
  if (server.origin !== c.runtime.server || server.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname)) throw new Error('Explicit existing loopback native server required');
  canonical(c.runtime.executable); await noLinks(c.runtime.executable);
  await preparePackWriter(c.pack);
  for (const root of [c.piecesDirectory, c.stateDirectory, c.controlDirectory]) {
    if ([c.pack.packDirectory, c.pack.skillsRoot].some(packRoot => inside(packRoot, root) || inside(root, packRoot))) throw new Error('Managed roots overlap pack/skills');
    await privateDirectory(root);
  }
  return c;
}

// The CLI owns discovery/auth. No registry/bearer reads or per-piece server.
// Read-only agent resolution initializes the location; the IPC owner handshake
// is the actual activation proof. An incompatible/cold runtime fails closed.
export async function initializePieceLocation(c, directory) {
  const { stdout: version } = await run(c.runtime.executable, ['--version'], { timeout: 10000, maxBuffer: 65536 });
  if (version.trim().replace(/^opencode v/, '') !== c.runtime.version) throw new Error('Discovery CLI differs from verified host; configure matching executable');
  const query = `?location[directory]=${encodeURIComponent(directory)}`;
  const api = route => run(c.runtime.executable, ['api', '--server', c.runtime.server, 'get', `${route}${query}`], { cwd: directory, timeout: 15000, maxBuffer: 65536 });
  // The pinned server's model.default handler awaits location plugin activation;
  // agent.get alone does not. Neither operation creates a session or prompt.
  await api('/api/model/default');
  await api('/api/agent/writer');
}

export async function installPieceDomain(n, p) {
  const domain = path.join(n.directory, '.opencode'); await fs.mkdir(domain, { mode: 0o700 });
  const pluginDirectory = path.join(domain, 'plugins', 'galley-piece'); await fs.mkdir(path.dirname(pluginDirectory), { mode: 0o700 }); await fs.mkdir(pluginDirectory, { mode: 0o700 });
  const wrapper = pathToFileURL(new URL('./piece-native.mjs', import.meta.url).pathname).href;
  await fs.writeFile(path.join(domain, 'opencode.json'), JSON.stringify(p.config), { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(pluginDirectory, 'index.mjs'), `import { piecePlugin } from ${JSON.stringify(wrapper)};\nexport default piecePlugin(${JSON.stringify(path.join(n.state, 'native', 'binding.json'))}, ${JSON.stringify({ pack: p.pack.options, enrollment: p.enrollment, expectedFingerprint: p.fingerprint })}, ${JSON.stringify(n.sessionFile)});\n`, { flag: 'wx', mode: 0o600 });
}

export async function openPieceManager(config, { connect = openNative, initialize = initializePieceLocation } = {}) {
  const c = await validatePieceConfig(structuredClone(config));
  const lease = await fs.open(path.join(c.stateDirectory, 'manager.lock'), 'wx', 0o600);
  const active = new Map(); let tail = Promise.resolve(), closed = false;
  const serial = fn => { const p = tail.then(() => { if (closed) throw new Error('Piece manager closed'); return fn(); }); tail = p.catch(() => {}); return p; };
  const names = id => {
    if (!validID(id)) throw new Error('Invalid piece id');
    const directory = path.join(c.piecesDirectory, id), state = path.join(c.stateDirectory, sha256(id).slice(0, 12));
    return { directory, state, journal: path.join(state, 'piece.json'), sessionFile: path.join(state, 'session.json') };
  };
  const result = record => ({ piece: record.id, reviewLink: record.reviewLink, conversation: { sessionId: record.sessionId, directory: record.directory, agent: 'writer' } });
  async function readyResult(a) {
    const token = new URL(a.record.reviewLink).hash.slice('#review='.length);
    if (!a.store.authorized(token)) {
      a.record.reviewLink = `${c.publicOrigin}/galley/#review=${await a.store.issue(86400000)}`;
      await writePrivate(names(a.record.id).journal, a.record);
    }
    return result(a.record);
  }
  async function attach(record, p, n, fresh) {
    let connector, store;
    try {
      const binding = { protocol: 'pack-writer-v1', agent: 'writer', sessionId: record.sessionId, sessionDirectory: n.directory, draft: p.enrollment.artifacts.draft, assetRoots: p.enrollment.assetDirectories, pack: c.pack, enrollment: p.enrollment, fingerprint: p.fingerprint, enrollmentDigest: p.enrollmentDigest, model: c.model, title: record.title };
      connector = await connect({ directory: path.join(n.state, 'native'), binding });
      await initialize(c, n.directory);
      await connector.waitOwner(15000);
      if (fresh) {
        // Durable fence before create; timeout/response loss never permits replay.
        record.status = 'startup-uncertain'; await writePrivate(n.journal, record);
        const s = await connector.startup({ ...p, directory: n.directory, draft: binding.draft }, c.model);
        record.sessionId = s.id;
        await writePrivate(n.sessionFile, { sessionId: s.id }, { exclusive: true });
        const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
        record.kickoff = { messageId, text: `Let's work on this piece together. Title and format are starting points, not a template: ${JSON.stringify({ title: record.title, format: record.format })}. Start with a short conversational kickoff about the reader and the point worth making; ask only what's missing before prose.` };
        record.status = 'kickoff-uncertain'; await writePrivate(n.journal, record);
        await connector.submit({ sessionId: s.id, directory: n.directory, upstreamIdentity: connector.identity, ...record.kickoff });
        record.status = 'enrolling'; await writePrivate(n.journal, record);
        store = await openStore(path.join(n.directory, 'store'), { ...binding, sessionId: s.id, upstreamIdentity: connector.identity });
        const token = await store.issue(86400000);
        record.reviewLink = `${c.publicOrigin}/galley/#review=${token}`;
        record.status = 'ready'; await writePrivate(n.journal, record);
      } else {
        await connector.inspect(record.sessionId);
        store = await openStore(path.join(n.directory, 'store'));
        if (store.state.binding.sessionId !== record.sessionId || store.state.binding.fingerprint !== p.fingerprint || store.state.binding.sessionDirectory !== n.directory) throw new Error('Stored piece affinity changed');
        await store.transaction(s => { s.binding.upstreamIdentity = connector.identity; });
      }
      const entry = { store, upstream: connector, record }, output = await readyResult(entry);
      active.set(record.id, entry);
      return output;
    } catch (e) { await store?.close(); await connector?.close(); throw e; }
  }
  async function resume(id) {
    if (active.has(id)) {
      const a = active.get(id); await advanceWriterState(await preparePackWriter(c.pack, a.record.enrollment), { resume: true });
      await a.upstream.inspect(a.record.sessionId); return readyResult(a);
    }
    const n = names(id), record = await readPrivate(n.journal);
    if (record.status !== 'ready' || record.id !== id || record.directory !== n.directory) throw new Error('Piece incomplete/uncertain; reconcile privately, never reset or replay');
    const p = await preparePackWriter(c.pack, record.enrollment);
    if (record.fingerprint !== p.fingerprint || record.enrollmentDigest !== p.enrollmentDigest) throw new Error('Pack/body/enrollment changed; explicit refresh required');
    await advanceWriterState(p, { resume: true });
    return attach(record, p, n, false);
  }
  return {
    newPiece(input) { return serial(async () => {
      const { title, format, sources = [], learnMemory = false } = input;
      if (typeof title !== 'string' || !title.trim() || title.length > 240 || /[\x00-\x1f]/.test(title) || !['long-form', 'short-form', 'linkedin'].includes(format)) throw new Error('Short title and supported format required');
      const id = input.id ?? pieceID(title), n = names(id);
      if ((await fs.readdir(c.stateDirectory)).filter(stateEntry).length >= 64) throw new Error('Managed piece limit reached');
      await fs.mkdir(n.directory, { mode: 0o700 }); // Exclusive: duplicate new never resumes or overwrites.
      await fs.mkdir(n.state, { mode: 0o700 });
      const artifacts = {};
      for (const role of ['brief', 'beats', 'visual-plan', 'draft', 'continuation']) {
        artifacts[role] = path.join(n.directory, `${role}.md`);
        const h = await fs.open(artifacts[role], 'wx', 0o600);
        try { await h.writeFile(role === 'draft' ? `# ${title}\n` : role === 'brief' ? `Title: ${title}\nFormat: ${format}\n` : ''); await h.sync(); } finally { await h.close(); }
      }
      const assets = path.join(n.directory, 'assets'); await fs.mkdir(assets, { mode: 0o700 });
      const enrollment = { directory: n.directory, artifacts, sources, assetDirectories: [assets], learnMemory, phase: 'design-piece', format: format === 'linkedin' ? 'short-form' : format, resume: false };
      const p = await preparePackWriter(c.pack, enrollment);
      const record = { version: 1, id, directory: n.directory, title, format, enrollment, fingerprint: p.fingerprint, enrollmentDigest: p.enrollmentDigest, status: 'allocated' };
      await writePrivate(n.journal, record, { exclusive: true });
      await installPieceDomain(n, p);
      return attach(record, p, n, true);
    }); },
    resume(id) { return serial(() => resume(id)); },
    // Explicit operator recovery ONLY before any startup job could be issued.
    // manager.lock + serial owns this state; recheck identity immediately before attach.
    resumeAllocated(id, expected) { return serial(async () => {
      const n = names(id), record = await readPrivate(n.journal);
      const keys = ['version', 'id', 'directory', 'title', 'format', 'enrollment', 'fingerprint', 'enrollmentDigest', 'status'];
      if (record.status !== 'allocated' || record.version !== 1 || record.id !== id || record.directory !== n.directory || Object.keys(record).some(k => !keys.includes(k)) || !isDeepStrictEqual(expected, { directory: n.directory, fingerprint: record.fingerprint, enrollmentDigest: record.enrollmentDigest })) throw new Error('Allocated recovery identity/fence mismatch');
      // Unknown state, even an empty session record or owner/claim evidence, refuses.
      const entries = await fs.readdir(n.state);
      if (entries.some(k => !['piece.json', 'native'].includes(k))) throw new Error('Allocated recovery has startup evidence');
      try {
        const nativeEntries = await fs.readdir(path.join(n.state, 'native'));
        if (nativeEntries.some(k => k !== 'binding.json')) throw new Error('Allocated recovery has native ownership evidence');
        if (nativeEntries.length) {
          const old = await readPrivate(path.join(n.state, 'native', 'binding.json'));
          if (!old.retired || old.sessionDirectory !== n.directory) throw new Error('Allocated native generation not retired');
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const p = await preparePackWriter(c.pack, record.enrollment);
      if (record.fingerprint !== p.fingerprint || record.enrollmentDigest !== p.enrollmentDigest || record.enrollment.directory !== n.directory) throw new Error('Allocated pack/enrollment changed');
      if (!isDeepStrictEqual(await readPrivate(n.journal), record)) throw new Error('Allocated journal conflict');
      // attach fsyncs startup-uncertain BEFORE connector.startup can enqueue create.
      return attach(record, p, n, true);
    }); },
    async restore() {
      // Ready entries only; uncertain histories are never retried automatically.
      // One unavailable piece must not take the existing legacy review offline.
      const unavailable = [];
      for (const entry of (await fs.readdir(c.stateDirectory)).filter(stateEntry)) {
        try {
          const r = await readPrivate(path.join(c.stateDirectory, entry, 'piece.json'));
          if (r.status === 'ready') await this.resume(r.id);
        } catch { unavailable.push(entry); }
      }
      return { unavailable };
    },
    resolveReview(token) {
      const matches = [...active.values()].filter(a => a.store.authorized(token));
      if (matches.length > 1) throw new Error('Ambiguous review capability');
      return matches[0];
    },
    async close() { await tail; closed = true; for (const a of active.values()) { await a.store.close(); await a.upstream.close(); } await lease.close(); await fs.unlink(path.join(c.stateDirectory, 'manager.lock')); },
  };
}
