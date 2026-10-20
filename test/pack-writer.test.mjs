import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveWritingPack, phaseFiles, sha256 } from '../src/writing-pack.mjs';
import { preparePackWriter, guidance, writerPlugin, generatePackArtifacts, compareWrite, conversationAdapter, advanceWriterState, writerState } from '../src/pack-writer.mjs';
import { fixture } from './fixtures/writing-pack.mjs';

test('current manifest, source phases and mutable-memory freshness', async t => {
  const f = await fixture(t), p = await resolveWritingPack(f.options);
  assert.equal(p.sources.length, 3);
  assert(!phaseFiles(p).includes(p.sources[1].path));
  assert(phaseFiles(p, { phase: 'edit', resume: true, format: 'short-form' }).includes(p.sources[2].path));
  await fs.appendFile(p.memoryPath, 'A new synthetic preference');
  assert.equal((await resolveWritingPack(f.options)).instructionFingerprint, p.instructionFingerprint);
  await fs.appendFile(p.sources[0].path, 'Changed source');
  assert.notEqual((await resolveWritingPack(f.options)).instructionFingerprint, p.instructionFingerprint);
});
test('version, schema, metadata, missing and escaping references fail closed', async t => {
  const f = await fixture(t);
  for (const [key, value, code] of [['version', '2.0.0', 'version'], ['schema_version', 2, 'schema'], ['entry', '../outside.md', 'path'], ['entry', '/outside.md', 'path'], ['entry', 'missing.md', 'missing']]) {
    const old = f.manifest[key]; f.manifest[key] = value; await f.save();
    await assert.rejects(resolveWritingPack(f.options), e => e.code === code); f.manifest[key] = old;
  }
  await f.save();
  await f.put(f.options.skillsRoot, 'edit.md', '---\nversion: 3.1.0\n---\nnot nested');
  await assert.rejects(resolveWritingPack(f.options), e => e.code === 'source-version');
  await assert.rejects(resolveWritingPack({ ...f.options, expectedVersion: undefined }));
});
test('all symlinks, aliases, oversized and invalid UTF-8 files denied', async t => {
  const f = await fixture(t), file = path.join(f.options.packDirectory, 'SYSTEM.md');
  await fs.unlink(file); await fs.symlink('README.md', file);
  await assert.rejects(resolveWritingPack(f.options));
  await fs.unlink(file); await fs.writeFile(file, Buffer.alloc(256 * 1024 + 1));
  await assert.rejects(resolveWritingPack(f.options));
  await fs.writeFile(file, Buffer.from([255])); await assert.rejects(resolveWritingPack(f.options));
});
test('missing pack, symlink root, duplicate sources and permission-path metacharacters refuse', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveWritingPack({ ...f.options, packDirectory: path.join(f.root, 'missing') }), e => e.code === 'missing');
  const alias = path.join(f.root, 'linked-pack'); await fs.symlink(f.options.packDirectory, alias);
  await assert.rejects(resolveWritingPack({ ...f.options, packDirectory: alias }), e => e.code === 'path');
  f.manifest.sources.push(f.manifest.sources[0]); await f.save();
  await assert.rejects(resolveWritingPack(f.options), e => e.code === 'manifest');
  f.manifest.sources.pop(); f.manifest.entry = 'wild*.md'; await f.save();
  await assert.rejects(resolveWritingPack(f.options), e => e.code === 'path');
});
test('global is fail-closed; enrollment exact roles and read-only scopes', async t => {
  const f = await fixture(t), global = await preparePackWriter(f.options);
  assert.deepEqual(global.profile.permissions[0], { action: '*', resource: '*', effect: 'deny' });
  assert(global.profile.permissions.every(r => ['*','read','external_directory'].includes(r.action)));
  assert(!global.profile.permissions.some(r => r.action.startsWith('writer_')));
  const p = await preparePackWriter(f.options, f.enrollment);
  assert.equal(p.agent, 'writer');
  const writes = p.profile.permissions.filter(r => r.action === 'writer_write').map(r => r.resource);
  assert.deepEqual(writes, Object.values(f.enrollment.artifacts));
  assert(!p.profile.permissions.some(r => r.action === 'edit'));
  assert(!p.profile.permissions.some(r => r.resource.endsWith('*') && r.effect === 'allow'));
  assert((await guidance(p)).includes('Synthetic SYSTEM'));
  const artifacts = generatePackArtifacts(p); assert(artifacts['writer-plugin.mjs'].includes('writerPlugin'));
  assert(!artifacts['writer-plugin.mjs'].includes('Synthetic SYSTEM'));
  assert(!Object.keys(JSON.parse(artifacts['opencode.json'])).includes('default_agent'));
  await assert.rejects(preparePackWriter(f.options, { ...f.enrollment, artifacts: { draft: f.enrollment.artifacts.draft } }));
  await assert.rejects(preparePackWriter(f.options, { ...f.enrollment, sources: [f.enrollment.artifacts.draft] }));
  await assert.rejects(preparePackWriter(f.options, { ...f.enrollment, assetDirectories: [f.enrollment.directory] }));
});
test('exact learned-memory exception and stale instruction rejection', async t => {
  const f = await fixture(t), p = await preparePackWriter(f.options, { ...f.enrollment, learnMemory: true });
  assert(p.profile.permissions.some(r => r.action === 'writer_write' && r.resource === p.pack.memoryPath));
  await fs.appendFile(p.pack.entry, 'change'); await assert.rejects(guidance(p), e => e.code === 'stale');
});
test('piece-local full-guidance output allowance is bounded; oversized bundles refuse', async t => {
  const f = await fixture(t);
  await assert.rejects(preparePackWriter(f.options, { ...f.enrollment, resume: 'true' }));
  const p = await preparePackWriter(f.options, f.enrollment);
  assert.deepEqual(p.config.tool_output, { max_bytes: 1024 * 1024, max_lines: 20000 });
  for (const file of ['SYSTEM.md', 'workflow.md', 'README.md']) await fs.writeFile(path.join(f.options.packDirectory, file), 'x'.repeat(200 * 1024));
  const large = await preparePackWriter(f.options, f.enrollment);
  await assert.rejects(guidance(large), e => e.code === 'guidance');
});
test('four phases persist hand-offs on same enrollment, resume loads full edit and handoff sources', async t => {
  const f = await fixture(t), p = await preparePackWriter(f.options, f.enrollment);
  const identity = JSON.stringify(p.sessionPermissions), digest = p.enrollmentDigest;
  for (const phase of f.manifest.phases) {
    await advanceWriterState(p, { phase });
    const body = await guidance(p);
    assert(body.includes(`Current phase: ${phase}`));
    assert(body.includes('Synthetic start source'));
    assert.equal(body.includes('Synthetic edit guidance'), phase === 'edit');
    assert(!body.includes('Synthetic resume source'));
    const state = await writerState(p);
    await compareWrite({ target: f.enrollment.artifacts.continuation, expectedSha256: sha256(state.text), text: `${state.text}\nHand-off from ${phase}` });
  }
  await fs.appendFile(p.pack.memoryPath, '\nFresh synthetic preference');
  const reloaded = await preparePackWriter(f.options, f.enrollment);
  await advanceWriterState(reloaded, { resume: true });
  const body = await guidance(reloaded);
  for (const phase of f.manifest.phases) assert(body.includes(`Hand-off from ${phase}`));
  assert(body.includes(await fs.readFile(path.join(f.options.skillsRoot, 'edit.md'), 'utf8')));
  assert(body.includes('Synthetic resume source'));
  assert(body.includes('Fresh synthetic preference'));
  assert.equal(JSON.stringify(reloaded.sessionPermissions), identity);
  assert.equal(reloaded.enrollmentDigest, digest);
  await assert.rejects(advanceWriterState(p, { phase: 'unknown' }));
  await fs.writeFile(f.enrollment.artifacts.continuation, '<!-- galley-writer-state {"phase":"bad","resume":true} -->\n');
  await assert.rejects(guidance(p));
});
test('dedicated tool enforcement: no fallback tools, no missing session scope, CAS conflicts', async t => {
  const f = await fixture(t), p = await preparePackWriter(f.options, f.enrollment), tools = new Map();
  let session = { agent: 'writer', location: { directory: f.enrollment.directory }, permissions: p.sessionPermissions };
  let hook;
  let toolHook;
  const ctx = { location: session.location, session: { get: async () => session, hook: async (name, fn) => { assert.equal(name, 'context'); hook = fn; } }, tool: { hook: async (name, fn) => { assert.equal(name, 'execute.before'); toolHook = fn; }, transform: async fn => fn({ add: tool => tools.set(tool.name, tool) }) }, permission: { assert: async ({ action, resources }) => {
    for (const resource of resources) { let effect = 'deny'; for (const r of p.sessionPermissions) if ((r.action === '*' || r.action === action) && (r.resource === '*' || r.resource === resource)) effect = r.effect; if (effect !== 'allow') throw Error('Denied'); }
  } } };
  await writerPlugin({ pack: f.options, enrollment: f.enrollment, expectedFingerprint: p.pack.instructionFingerprint }).setup(ctx);
  const event = { agent: 'writer', sessionID: 'ses_synthetic', system: [], tools: { read: {}, shell: {}, execute: {}, arbitrary_mcp: {}, writer_read: {}, writer_write: {} } }; await hook(event);
  assert(event.system[0].text.includes('Synthetic SYSTEM'));
  assert.deepEqual(Object.keys(event.tools), ['writer_read', 'writer_write']);
  assert.throws(() => toolHook({ agent: 'writer', tool: 'shell' }));
  const other = { agent: 'lead', system: [], tools: { read: {}, unrelated_tool: {}, writer_read: {}, writer_write: {} } }; await hook(other);
  assert.deepEqual(Object.keys(other.tools), ['read','unrelated_tool']);
  assert.equal(other.system.length, 0);
  assert.throws(() => toolHook({ agent: 'lead', tool: 'writer_write' }));
  assert.deepEqual([...tools.keys()], ['writer_read', 'writer_write']);
  const context = { agent: 'writer', sessionID: 'ses_synthetic', messageID: 'msg_synthetic', id: 'tool_synthetic' };
  const read = target => tools.get('writer_read').execute({ target }, context);
  const write = (target, text, expectedSha256) => tools.get('writer_write').execute({ target, text, expectedSha256 }, context);
  for (const phase of f.manifest.phases) {
    const result = await tools.get('writer_read').execute({ target: 'guidance', phase }, context);
    assert(result.content.includes(`Current phase: ${phase}`));
  }
  await tools.get('writer_read').execute({ target: 'guidance', resume: true }, context);
  const next = { ...event, system: [], tools: { writer_read: {}, writer_write: {}, read: {} } };
  await hook(next);
  assert(next.system[0].text.includes('Synthetic edit guidance'));
  assert(next.system[0].text.includes('Synthetic resume source'));
  await assert.rejects(tools.get('writer_read').execute({ target: 'guidance', phase: 'unknown' }, context));
  await assert.rejects(tools.get('writer_read').execute({ target: f.enrollment.artifacts.draft, phase: 'edit' }, context));
  const continuation = JSON.parse((await read(f.enrollment.artifacts.continuation)).content);
  await assert.rejects(write(f.enrollment.artifacts.continuation, 'Drop state header', continuation.sha256));
  const target = f.enrollment.artifacts.draft, before = JSON.parse((await read(target)).content);
  await write(target, 'Saved synthetic draft', before.sha256);
  await assert.rejects(write(target, 'stale overwrite', before.sha256));
  await assert.rejects(read(path.join(f.root, 'unrelated.md')));
  await assert.rejects(write(f.enrollment.sources[0], 'bad', sha256('x')));
  await assert.rejects(write(p.pack.memoryPath, 'bad', sha256('x')));
  await assert.rejects(tools.get('writer_read').execute({ target: 'guidance' }, { ...context, agent: 'build' }));
  session = { ...session, permissions: [] }; await assert.rejects(read(target));
});
test('memory conflict and hardlink write protection', async t => {
  const f = await fixture(t), p = await resolveWritingPack(f.options), text = await fs.readFile(p.memoryPath, 'utf8');
  await compareWrite({ target: p.memoryPath, text: 'Confirmed synthetic observation', expectedSha256: sha256(text) });
  await assert.rejects(compareWrite({ target: p.memoryPath, text: 'stale', expectedSha256: sha256(text) }));
  const lock = path.join(await fs.realpath(os.tmpdir()), 'opencode', 'galley-writer-locks', `${sha256(p.memoryPath)}.lock`);
  await fs.writeFile(lock, '', { flag: 'wx', mode: 0o600 });
  try { await assert.rejects(compareWrite({ target: p.memoryPath, text: 'blocked', expectedSha256: sha256('Confirmed synthetic observation') }), e => e.code === 'conflict'); }
  finally { await fs.unlink(lock); }
  await fs.link(p.memoryPath, path.join(f.root, 'alias.md'));
  await assert.rejects(compareWrite({ target: p.memoryPath, text: 'no', expectedSha256: sha256('Confirmed synthetic observation') }));
});
test('maintainer CLI creates only inert private artifacts and refuses nonempty output', async t => {
  const f = await fixture(t), output = path.join(f.root, 'generated'); await fs.mkdir(output);
  const args = [path.resolve('bin/galley-pack-writer.mjs'), '--pack-directory', f.options.packDirectory, '--skills-root', f.options.skillsRoot, '--expected-version', f.options.expectedVersion, '--output', output];
  const r = await promisify(execFile)(process.execPath, args, { timeout: 10000 });
  assert(JSON.parse(r.stdout).ok);
  assert.deepEqual((await fs.readdir(output)).sort(), ['opencode.json', 'writer.md']);
  await assert.rejects(promisify(execFile)(process.execPath, args, { timeout: 10000 }));
});
test('cheap harness variants are no-tools conversation only; unsupported edits/Codex refuse', async t => {
  const f = await fixture(t), p = await preparePackWriter(f.options);
  assert((await conversationAdapter('pi', p)).args.includes('--no-tools'));
  assert((await conversationAdapter('claude', p)).args.includes('--safe-mode'));
  await assert.rejects(conversationAdapter('codex', p));
  await assert.rejects(conversationAdapter('pi', await preparePackWriter(f.options, f.enrollment)));
});
