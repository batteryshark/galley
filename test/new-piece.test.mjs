import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openPieceManager, validatePieceConfig, initializePieceLocation } from '../src/new-piece.mjs';
import { piecePlugin, observationalMetadata } from '../src/piece-native.mjs';
import { openPieceControl } from '../src/piece-control.mjs';
import { preparePackWriter } from '../src/pack-writer.mjs';
import { roles, sha256 } from '../src/writing-pack.mjs';
import { readPrivate, writePrivate } from '../src/private.mjs';
import { newPieceCLI } from '../bin/galley-new.mjs';
import { startServer } from '../src/server.mjs';
import { openStore } from '../src/store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'n-'));
  const packDirectory = path.join(root, 'pack'), skillsRoot = path.join(root, 'skills');
  const manifest = { schema_version: 1, id: 'synthetic', visibility: 'private', version: '1.0.0', entry: 'SYSTEM.md',
    documents: { workflow: 'workflow.md', 'long-form': 'long.md', 'short-form': 'short.md', editor: 'editor.md', 'adapter-contract': 'README.md' },
    voice_memory: { path: 'voice/learned.md', contract: 'voice/README.md', write_policy: 'explicit-scoped-only' },
    sources: [{ id: 'start', path: 'start.md', load_when: 'start' }], phases: ['design-piece', 'design-visuals', 'draft', 'edit'], artifact_roles: roles, candidate_check: 'scripts/check.py' };
  for (const d of ['pack', 'skills', 'p', 's', 'c']) await fs.mkdir(path.join(root, d), { mode: 0o700 });
  for (const file of ['SYSTEM.md', ...Object.values(manifest.documents), 'voice/learned.md', 'voice/README.md', 'scripts/check.py', 'scripts/resolve_pack.py']) {
    await fs.mkdir(path.dirname(path.join(packDirectory, file)), { recursive: true });
    await fs.writeFile(path.join(packDirectory, file), `Synthetic guidance: ${file}\n`);
  }
  await fs.writeFile(path.join(skillsRoot, 'start.md'), 'Synthetic source\n');
  await fs.writeFile(path.join(packDirectory, 'pack.json'), JSON.stringify(manifest));
  const config = { version: 1, piecesDirectory: path.join(root, 'p'), stateDirectory: path.join(root, 's'), controlDirectory: path.join(root, 'c'), publicOrigin: 'https://review.example.invalid', pack: { packDirectory, skillsRoot, expectedVersion: '1.0.0' }, model: { providerID: 'synthetic', id: 'none' }, runtime: { version: '2.0.32', executable: await fs.realpath(process.execPath), server: 'http://127.0.0.1:12345' } };
  const sessions = new Map(), prompts = [], tools = new Map(), hooks = new Map(), cleanups = [], pluginStops = new Map();
  let creates = 0, failure;
  const initialize = async (_c, directory) => {
    if (failure === 'initialize') throw Error('Pre-startup activation failed');
    // Existing-host location initialization does not load a second plugin owner.
    // Model a watcher replacement by unloading this fixture's previous instance.
    await pluginStops.get(directory)?.();
    const r = await readPrivate(path.join(config.stateDirectory, sha256(path.basename(directory)).slice(0, 12), 'piece.json'));
    const p = await preparePackWriter(config.pack, r.enrollment);
    const ctx = { app: { version: '2.0.32' }, location: { directory }, agent: { get: async () => ({ location: { directory }, data: { id: 'writer', ...p.profile } }) },
      session: {
        hook: async (kind, fn) => hooks.set(`${directory}:${kind}`, fn),
        get: async ({ sessionID }) => { if (!sessions.has(sessionID)) throw Error('Missing'); return structuredClone(sessions.get(sessionID)); },
        create: async input => {
          assert.equal((await readPrivate(path.join(config.stateDirectory, sha256(path.basename(directory)).slice(0, 12), 'piece.json'))).status, 'startup-uncertain', 'durable fence precedes native create');
          creates++; const s = { ...input, id: `ses_fixture${creates}` }; sessions.set(s.id, s);
          if (failure === 'startup-metadata') s.metadata = { openchamber: { work: { state: 'open', openedBy: 'auto', openedAt: 123 } } };
          if (failure === 'create') throw Error('Lost create acknowledgment'); return s;
        },
        prompt: async input => { prompts.push(input); if (failure === 'prompt') throw Error('Lost prompt acknowledgment'); return { id: input.id, sessionID: input.sessionID, type: 'user', delivery: 'queue', payload: { text: input.text }, time: { created: Date.now() } }; },
        context: async () => [{ id: 'msg_ownedanswer', type: 'assistant' }],
      }, tool: { hook: async () => {}, transform: async fn => fn({ add: tool => tools.set(`${directory}:${tool.name}`, tool) }) },
      permission: { assert: async () => {} } };
    const plugin = (await import(pathToFileURL(path.join(directory, '.opencode/plugins/galley-piece/index.mjs')).href + `?fixture=${cleanups.length}`)).default;
    const stop = await plugin.setup(ctx); pluginStops.set(directory, stop); cleanups.push(stop);
  };
  let manager = await openPieceManager(config, { initialize });
  let control, app;
  t.after(async () => { await control?.close(); await app?.close(); for (const cleanup of cleanups) await cleanup?.(); await manager.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, config, get manager() { return manager; }, sessions, prompts, tools, hooks, initialize, cleanups,
    get creates() { return creates; }, set failure(v) { failure = v; },
    async control() { control = await openPieceControl({ directory: config.controlDirectory, manager }); return control; },
    async server(options = {}) { app = await startServer({ resolveReview: token => manager.resolveReview(token), ...options }); return app; },
    async restart() {
      for (const cleanup of cleanups.splice(0)) await cleanup?.();
      await manager.close(); manager = await openPieceManager(config, { initialize }); return manager.restore();
    },
  };
}
const newInput = { id: 'one', title: 'A synthetic beginning', format: 'long-form' };

test('only exact observational host work metadata accepted after strict empty startup', async t => {
  const f = await fixture(t), r = await f.manager.newPiece(newInput), session = f.sessions.get(r.conversation.sessionId);
  const benign = { openchamber: { work: { state: 'open', openedBy: 'auto', openedAt: 123 } } };
  assert(observationalMetadata({})); assert(observationalMetadata(benign));
  const invalid = [null, [], { goal: {} }, { ...benign, unknown: true }, { openchamber: { ...benign.openchamber, goal: {} } },
    ...[{ goal: {} }, { state: 'closed' }, { openedBy: 'user' }, { openedAt: Infinity }, { openedAt: NaN }, { openedAt: -1 }, { openedAt: 1.5 }, { openedAt: Number.MAX_SAFE_INTEGER + 1 }].map(change => ({ openchamber: { work: { ...benign.openchamber.work, ...change } } }))];
  for (const metadata of invalid) assert(!observationalMetadata(metadata));
  session.metadata = benign;
  await f.manager.resume('one');
  for (const change of [{ metadata: { goal: {} } }, { parentID: 'ses_foreign' }, { permissions: [] }, { model: { id: 'foreign', providerID: 'synthetic' } }]) {
    const old = { ...session }; Object.assign(session, change);
    await assert.rejects(f.manager.resume('one'));
    for (const k of Object.keys(session)) delete session[k]; Object.assign(session, old);
  }
});
test('observational metadata is still forbidden on original startup readback', async t => {
  const f = await fixture(t); f.failure = 'startup-metadata';
  await assert.rejects(f.manager.newPiece(newInput));
  assert.equal(f.creates, 1); assert.equal(f.prompts.length, 0);
  assert.equal((await readPrivate(path.join(f.config.stateDirectory, sha256('one').slice(0, 12), 'piece.json'))).status, 'startup-uncertain');
});
test('advisory UI metadata requires exact bounded shape and message ownership, never grants automation', async t => {
  const f = await fixture(t), r = await f.manager.newPiece(newInput), s = f.sessions.get(r.conversation.sessionId);
  const work = { state: 'open', openedBy: 'auto', openedAt: 123 };
  const assist = { recap: 'Untrusted recap', suggestion: 'Do not execute this suggestion', forMessageID: 'msg_ownedanswer', generatedAt: 456 };
  const metadata = a => ({ openchamber: { work, assist: a } });
  s.metadata = metadata(assist); await f.manager.resume('one');
  assert.equal(f.prompts.length, 1, 'Resume does not act on suggestion');
  const invalid = [{ ...assist, goal: {} }, { ...assist, recap: { goal: 'nested' } }, { ...assist, recap: 'x'.repeat(321) }, { ...assist, suggestion: 'x'.repeat(501) }, { ...assist, generatedAt: Infinity }, { ...assist, generatedAt: -1 }, { ...assist, generatedAt: 1.1 }, { ...assist, forMessageID: 'bad' }, { ...assist, forMessageID: 'msg_' + 'x'.repeat(129) }, { ...assist, forMessageID: 'msg_foreignanswer' }];
  for (const a of invalid) { s.metadata = metadata(a); await assert.rejects(f.manager.resume('one')); }
  assert.equal(f.prompts.length, 1);
});

test('explicit allocated recovery preserves allocation and refuses all create/fence/identity evidence', async t => {
  const f = await fixture(t); f.failure = 'initialize';
  await assert.rejects(f.manager.newPiece(newInput));
  assert.equal(f.creates, 0); assert.equal(f.prompts.length, 0);
  const state = path.join(f.config.stateDirectory, sha256('one').slice(0, 12));
  const file = path.join(state, 'piece.json'), record = await readPrivate(file);
  const expected = { directory: record.directory, fingerprint: record.fingerprint, enrollmentDigest: record.enrollmentDigest };
  f.failure = undefined;
  await assert.rejects(f.manager.resumeAllocated('one', { ...expected, fingerprint: 'wrong' }));
  for (const status of ['startup-uncertain', 'kickoff-uncertain', 'ready']) {
    await writePrivate(file, { ...record, status });
    await assert.rejects(f.manager.resumeAllocated('one', expected));
  }
  await writePrivate(file, { ...record, kickoff: {} });
  await assert.rejects(f.manager.resumeAllocated('one', expected));
  await writePrivate(file, record);
  await writePrivate(path.join(state, 'session.json'), {});
  await assert.rejects(f.manager.resumeAllocated('one', expected));
  await fs.unlink(path.join(state, 'session.json'));
  await writePrivate(path.join(state, 'native', 'owner.json'), {});
  await assert.rejects(f.manager.resumeAllocated('one', expected));
  await fs.unlink(path.join(state, 'native', 'owner.json'));
  const result = await f.manager.resumeAllocated('one', expected);
  assert.equal(result.conversation.directory, record.directory);
  assert.equal(f.creates, 1); assert.equal(f.prompts.length, 1);
  await assert.rejects(f.manager.resumeAllocated('one', expected));
});

test('one command: exact native startup, short kickoff, same review/direct session, resume and no overwrite', async t => {
  const f = await fixture(t); await f.control();
  const configFile = path.join(f.config.controlDirectory, 'local.json'); await writePrivate(configFile, f.config);
  const args = ['--config', configFile, '--title', newInput.title, '--format', 'linkedin', '--id', 'one'];
  const r = await newPieceCLI(args);
  assert.equal(f.creates, 1); assert.equal(f.prompts.length, 1); assert(f.prompts[0].text.length < 700);
  assert.equal(r.conversation.sessionId, f.prompts[0].sessionID);
  const s = f.sessions.get(r.conversation.sessionId);
  assert.deepEqual(s.metadata, {}); assert.equal(s.parentID, undefined); assert.equal(s.agent, 'writer');
  assert(s.permissions.every(rule => rule.effect === 'deny' || ['writer_read', 'writer_write'].includes(rule.action)));
  const draft = path.join(r.conversation.directory, 'draft.md'); assert.equal(await fs.readFile(draft, 'utf8'), `# ${newInput.title}\n`);
  for (const role of roles) await fs.stat(path.join(r.conversation.directory, `${role}.md`));
  await assert.rejects(newPieceCLI(args));
  const resumed = await newPieceCLI(['--config', configFile, '--resume', 'one']);
  assert.deepEqual(resumed, r); assert.equal(f.creates, 1); assert.equal(f.prompts.length, 1);
  const token = new URL(r.reviewLink).hash.slice('#review='.length);
  const enrolled = f.manager.resolveReview(token);
  assert.equal(enrolled.store.state.binding.sessionId, r.conversation.sessionId);
  // Exercise the actual HTTP note/batch path to the same native session.
  const app = await f.server();
  const request = (route, data) => fetch(`${app.origin}/galley/api/${route}`, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(data ? { Origin: app.origin, 'X-Galley': '1', 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
  const doc = await (await request('document')).json();
  const note = { id: randomUUID(), operationId: randomUUID(), expectedVersion: 0, message: 'One concrete question', anchor: { kind: 'continuous', revision: doc.revision, offset: 0, quote: doc.text.trimEnd(), prefix: '', suffix: '\n' } };
  assert.equal((await request('notes', note)).status, 200);
  const batch = { id: randomUUID(), revision: doc.revision };
  assert.equal((await (await request('batches', batch)).json()).status, 'accepted');
  assert.equal((await (await request('batches', batch)).json()).status, 'accepted');
  assert.equal(f.prompts.length, 2);
  assert.equal(f.prompts.at(-1).sessionID, r.conversation.sessionId);
});

test('restart reattaches exact session and keeps capability/history; expired-link resume renews without kickoff', async t => {
  const f = await fixture(t), r = await f.manager.newPiece(newInput);
  const token = new URL(r.reviewLink).hash.slice(8);
  await f.manager.resolveReview(token).store.transaction(s => { s.comments.push({ id: 'saved-history', status: 'accepted' }); });
  await f.restart();
  assert.deepEqual(await f.manager.resume('one'), r);
  const a = f.manager.resolveReview(token);
  assert.equal(a.store.state.comments[0].id, 'saved-history');
  await a.store.transaction(s => { s.capabilities[0].expires = Date.now() - 1; });
  const renewed = await f.manager.resume('one');
  assert.notEqual(renewed.reviewLink, r.reviewLink); assert.deepEqual(renewed.conversation, r.conversation);
  assert.equal(f.creates, 1); assert.equal(f.prompts.length, 1);
});

test('two pieces share one isolated listener, exact capabilities, preserved legacy default and histories', async t => {
  const f = await fixture(t), a = await f.manager.newPiece(newInput), b = await f.manager.newPiece({ id: 'two', title: 'Different piece', format: 'short-form' });
  const tokenA = new URL(a.reviewLink).hash.slice(8), tokenB = new URL(b.reviewLink).hash.slice(8);
  const legacyDir = path.join(f.root, 'legacy');
  const legacyDraft = path.join(f.root, 'legacy.md'); await fs.writeFile(legacyDraft, '# Prior piece\n');
  const legacy = await openStore(legacyDir, { sessionId: 'ses_legacy', sessionDirectory: f.root, draft: legacyDraft, assetRoots: [], upstreamIdentity: 'legacy' });
  f.cleanups.push(() => legacy.close()); const legacyToken = await legacy.issue();
  await legacy.transaction(s => { s.comments.push({ id: 'historical', status: 'accepted' }); });
  const app = await f.server({ store: legacy });
  const get = (token, route = '/api/document') => fetch(`${app.origin}/galley${route}`, { headers: { Authorization: `Bearer ${token}` } });
  const da = await (await get(tokenA)).json(), db = await (await get(tokenB)).json(), old = await (await get(legacyToken)).json();
  assert.match(da.text, /synthetic beginning/); assert.match(db.text, /Different piece/); assert.match(old.text, /Prior piece/);
  assert.equal(old.comments[0].id, 'historical'); assert.equal((await get('invalid')).status, 401);
  for (const route of ['/api/new', '/api/native', '/api/session', '/api/pack']) assert.equal((await get(tokenA, route)).status, 404);
  const beforeB = JSON.stringify(f.manager.resolveReview(tokenB).store.state);
  const revoke = await fetch(`${app.origin}/galley/api/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}`, Origin: app.origin, 'Content-Type': 'application/json', 'X-Galley': '1' }, body: '{}' });
  assert.equal(revoke.status, 200); assert.equal((await get(tokenA)).status, 401); assert.equal((await get(tokenB)).status, 200);
  // Only snapshot observations may change in B; capabilities and notes stay exact.
  const priorB = JSON.parse(beforeB), afterB = f.manager.resolveReview(tokenB).store.state;
  assert.deepEqual(afterB.capabilities, priorB.capabilities); assert.deepEqual(afterB.notes, priorB.notes);
  assert.equal((await get(legacyToken)).status, 200);
  const foreignWrite = f.tools.get(`${a.conversation.directory}:writer_write`);
  const target = path.join(b.conversation.directory, 'draft.md');
  await assert.rejects(foreignWrite.execute({ target, expectedSha256: sha256(await fs.readFile(target)), text: 'Cross-piece overwrite' }, { agent: 'writer', sessionID: a.conversation.sessionId }));
  assert.equal(await fs.readFile(target, 'utf8'), '# Different piece\n');
});

for (const stage of ['create', 'prompt']) test(`uncertain ${stage} stays fenced across retry/resume, never creates or prompts twice`, async t => {
  const f = await fixture(t); f.failure = stage;
  await assert.rejects(f.manager.newPiece(newInput));
  const file = path.join(f.config.stateDirectory, sha256('one').slice(0, 12), 'piece.json');
  const r = await readPrivate(file); assert.equal(r.status, stage === 'create' ? 'startup-uncertain' : 'kickoff-uncertain');
  if (stage === 'prompt') { assert.equal(r.sessionId, 'ses_fixture1'); assert(r.kickoff.messageId); }
  f.failure = undefined;
  await assert.rejects(f.manager.newPiece(newInput)); await assert.rejects(f.manager.resume('one'), /uncertain/);
  assert.equal(f.creates, 1); assert.equal(f.prompts.length, stage === 'prompt' ? 1 : 0);
});

test('pack drift refuses resume/review native operations, and exact-session tools reject same-rule impostors', async t => {
  const f = await fixture(t), r = await f.manager.newPiece(newInput);
  const tools = f.tools, directory = r.conversation.directory;
  const tool = tools.get(`${directory}:writer_read`);
  const context = { agent: 'writer', sessionID: r.conversation.sessionId };
  assert((await tool.execute({ target: 'guidance' }, context)).content.includes('Synthetic guidance'));
  f.sessions.set('ses_impostor', { ...f.sessions.get(context.sessionID), id: 'ses_impostor' });
  await assert.rejects(tool.execute({ target: 'guidance' }, { ...context, sessionID: 'ses_impostor' }), /not enrolled/);
  const event = { agent: 'build', tools: { unrelated: {}, writer_read: {}, writer_write: {} }, system: [] };
  await f.hooks.get(`${directory}:context`)(event); assert.deepEqual(Object.keys(event.tools), ['unrelated']);
  await fs.appendFile(path.join(f.config.pack.packDirectory, 'SYSTEM.md'), 'Changed body\n');
  await assert.rejects(f.manager.resume('one')); assert.equal(f.creates, 1); assert.equal(f.prompts.length, 1);
  await assert.rejects(tool.execute({ target: 'guidance' }, context), /changed/);
});

test('unsafe local config, pack paths, permissions, symlinks and foreign session metadata refuse', async t => {
  const f = await fixture(t);
  await assert.rejects(validatePieceConfig({ ...f.config, stateDirectory: f.config.piecesDirectory }));
  await assert.rejects(validatePieceConfig({ ...f.config, runtime: { ...f.config.runtime, version: '2.0.23' } }));
  const alias = path.join(f.root, 'alias'); await fs.symlink(f.config.pack.packDirectory, alias);
  await assert.rejects(validatePieceConfig({ ...f.config, pack: { ...f.config.pack, packDirectory: alias } }));
  await fs.chmod(f.config.piecesDirectory, 0o755); await assert.rejects(validatePieceConfig(f.config)); await fs.chmod(f.config.piecesDirectory, 0o700);
  const r = await f.manager.newPiece(newInput), token = new URL(r.reviewLink).hash.slice(8), a = f.manager.resolveReview(token);
  f.sessions.get(r.conversation.sessionId).metadata = { goal: 'forbidden' };
  await assert.rejects(a.upstream.inspect(r.conversation.sessionId));
  await assert.rejects(a.upstream.submit({ sessionId: 'ses_other', directory: r.conversation.directory, upstreamIdentity: a.upstream.identity, messageId: 'msg_no', text: 'not delivered' }));
  assert.equal(f.prompts.length, 1);
});

test('supported discovery is explicit existing-server read-only and rejects CLI version skew before any API', async t => {
  const f = await fixture(t), executable = path.join(f.root, 'fake-cli'), log = path.join(f.root, 'calls.jsonl');
  const script = version => `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2); if(args[0]==='--version') console.log(${JSON.stringify(version)}); else { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n'); console.log('{}'); }\n`;
  // .mjs extension makes the synthetic executable independent of parent package type.
  const cli = executable + '.mjs'; await fs.writeFile(cli, script('2.0.32'), { mode: 0o700 });
  const c = { ...f.config, runtime: { ...f.config.runtime, executable: cli } };
  await initializePieceLocation(c, f.config.piecesDirectory);
  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  for (const args of calls) assert.deepEqual(args.slice(0, 4), ['api', '--server', c.runtime.server, 'get']);
  assert.match(calls[0][4], /^\/api\/model\/default\?location\[directory\]=/);
  assert.match(calls[1][4], /^\/api\/agent\/writer\?location\[directory\]=/);
  await fs.writeFile(cli, script('2.0.23')); await assert.rejects(initializePieceLocation(c, f.config.piecesDirectory), /differs/);
  assert.equal((await fs.readFile(log, 'utf8')).trim().split('\n').length, 2);
});

test('no tools registered outside the exact opted-in piece location; unavailable restored pieces do not block others', async t => {
  const f = await fixture(t);
  await piecePlugin('unused', { enrollment: { directory: '/nonexistent-synthetic-piece' } }, 'unused').setup({ location: { directory: f.root }, tool: { transform() { assert.fail('Global registration'); } } });
  await f.manager.newPiece(newInput);
  await f.manager.newPiece({ id: 'two', title: 'Second', format: 'short-form' });
  f.sessions.get('ses_fixture1').metadata = { parentAutomation: true };
  const restored = await f.restart(); assert.equal(restored.unavailable.length, 1);
  await assert.rejects(f.manager.resume('one'));
  assert.equal((await f.manager.resume('two')).conversation.sessionId, 'ses_fixture2');
  assert.equal(f.creates, 2); assert.equal(f.prompts.length, 2);
});
