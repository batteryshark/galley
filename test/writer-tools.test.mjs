import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareWriter, installWriter, verifyPrepared } from '../src/writer.mjs';
import { imageArguments as parseImageArguments, writerToolsPlugin } from '../src/writer-tools.mjs';
import { writerToolInputs } from './fixtures/writer-tools.mjs';
import { executeNative } from '../src/native-worker.mjs';
import { startWriter } from '../src/writer-start.mjs';
import { readPrivate } from '../src/private.mjs';
const imageCommand = await fs.realpath(process.execPath);
const imageArguments = command => parseImageArguments(command, imageCommand);

export async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'w-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const draft = path.join(project, 'draft.md'); await fs.writeFile(draft, '# Synthetic');
  const p = await prepareWriter({ draft, sessionDirectory: project, assetRoots: [], sessionId: 'ses_fixture', upstreamIdentity: 'synthetic', ...await writerToolInputs(root) });
  const policy = { agent: p.agent, directory: p.directory, permissions: p.profile.permissions, ...p.capabilities };
  const calls = [], checks = [], prompts = [];
  const tools = new Map([['shell', { execute: async () => ({ content: 'unrelated shell' }) }]]);
  const session = { id: 'ses_fixture', agent: p.agent, location: { directory: project }, permissions: p.profile.permissions };
  const ctx = { location: { directory: project }, permission: { assert: async c => { checks.push(c); } }, session: {
    get: async ({ sessionID }) => sessionID === policy.chief.session ? { id: sessionID, location: { directory: policy.chief.directory } } : session,
    prompt: async input => { prompts.push(input); return { id: input.id, sessionID: input.sessionID, type: 'user', delivery: input.delivery, payload: { text: input.text }, time: { created: Date.now() } }; },
  }, tool: { transform: async fn => fn({ get: id => tools.get(id), update: (id, fn) => fn(tools.get(id)), add: tool => tools.set(tool.name, tool) }) } };
  await writerToolsPlugin(policy, { run: async (...args) => { calls.push(args); return { stdout: 'synthetic image result' }; }, readChief: async () => policy.chief }).setup(ctx);
  const context = { sessionID: session.id, agent: p.agent, messageID: 'msg_test', id: 'call_test', signal: new AbortController().signal };
  return { root, project, p, policy, calls, checks, prompts, session, ctx, tools, context,
    shell: input => tools.get('shell').execute(input, context), chief: input => tools.get(policy.chiefTool).execute(input, context) };
}

const command = `${imageCommand} --prompt 'A cheerful robot; $HOME is literal, not an expansion' --out robot.png --size 1024x1024 --transparent`;
test('standalone image help retains session affinity and rejects mixed arguments', async t => {
  const f = await fixture(t);
  await f.shell({ command: `${imageCommand} --help` });
  assert.deepEqual(f.calls[0].slice(0, 2), [imageCommand, ['--help']]);
  assert.equal(f.checks[0].action, 'shell');
  for (const suffix of [' --out robot.png', '; true', ' --help']) {
    await assert.rejects(f.shell({ command: `${imageCommand} --help${suffix}` }));
  }
  f.session.permissions = [];
  await assert.rejects(f.shell({ command: `${imageCommand} --help` }), /permissions don't match.*galley-writer.mjs start/);
  assert.equal(f.calls.length, 1);
});
test('image execution pins binary, literal argv, cwd, clean environment and timeout', async t => {
  const f = await fixture(t);
  await f.shell({ command, timeout: 9999999 });
  const [binary, argv, options] = f.calls[0];
  assert.equal(binary, imageCommand); assert.equal(argv[1], 'A cheerful robot; $HOME is literal, not an expansion');
  assert.equal(options.cwd, path.join(f.project, '_images')); assert.equal(options.timeout, 255000);
  assert.equal(options.env.NODE_OPTIONS, undefined); assert.equal(options.env.PYTHONPATH, undefined);
  assert.equal(f.checks[0].action, 'shell');
  assert.equal((await fs.stat(options.cwd)).isDirectory(), true);
  assert.equal((await f.tools.get('shell').execute({ command: 'unrelated' }, { ...f.context, agent: 'build' })).content, 'unrelated shell');
  assert.deepEqual(imageArguments(`${imageCommand} --prompt 'robot'\\''s pencil' --out robot.png`).argv.slice(0, 2), ['--prompt', "robot's pencil"]);
});
test('shell syntax, executable aliases, output escapes, duplicate flags and arbitrary options refuse before execution', async t => {
  const f = await fixture(t);
  for (const bad of [command + '; touch other', command + ' > other', command + '\ntrue', command + ' | cat',
    command.replace(imageCommand, 'gpt-image'), command.replace(imageCommand, imageCommand + '-other'),
    command.replace("'A cheerful robot; $HOME is literal, not an expansion'", '"$(touch other)"'),
    command.replace('robot.png', '../robot.png'), command.replace('robot.png', '/tmp/robot.png'), command.replace('robot.png', '.hidden.png'),
    command.replace('robot.png', 'robot.md'), command + ' --out second.png', command + ' --model other']) {
    await assert.rejects(f.shell({ command: bad }));
  }
  await assert.rejects(f.shell({ command, workdir: f.project }));
  await assert.rejects(f.shell({ command, background: true }));
  assert.equal(f.calls.length, 0);
});
test('symlink folder, existing output and foreign session permissions are refused', async t => {
  const f = await fixture(t), folder = f.policy.imageDirectory;
  await fs.symlink(f.root, folder); await assert.rejects(f.shell({ command })); await fs.unlink(folder);
  await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'robot.png'), 'existing');
  await assert.rejects(f.shell({ command }));
  await fs.unlink(path.join(folder, 'robot.png')); f.session.permissions = [];
  await assert.rejects(f.shell({ command })); assert.equal(f.calls.length, 0);
});
test('chief tool queues only to pinned recipient, checks affinity and never exposes history/create', async t => {
  const f = await fixture(t);
  assert.equal(JSON.parse((await f.chief({ text: 'Ready for review' })).content).accepted, true);
  assert.equal(f.prompts[0].sessionID, f.policy.chief.session); assert.equal(f.prompts[0].delivery, 'queue');
  assert.match(f.prompts[0].text, /ses_fixture/); assert.equal(f.prompts[0].resume, true);
  assert.equal(f.checks[0].resources[0], f.policy.chief.session);
  for (const input of [{ text: 'x', to: 'ses_other' }, { text: 'x', create: {} }, { text: '' }]) await assert.rejects(f.chief(input));
  await assert.rejects(f.tools.get(f.policy.chiefTool).execute({ text: 'x' }, { ...f.context, agent: 'build' }));
  f.ctx.session.get = async () => ({ ...f.session, location: { directory: '/other' } });
  await assert.rejects(f.chief({ text: 'x' })); assert.equal(f.prompts.length, 1);
});
test('chief failures stay uncertain, no automatic retry', async t => {
  const f = await fixture(t); let sends = 0;
  f.ctx.session.prompt = async () => { sends++; throw new Error('lost receipt'); };
  await assert.rejects(f.chief({ text: 'x' }), /uncertain; do not automatically retry/); assert.equal(sends, 1);
  f.ctx.session.prompt = async () => { sends++; return { id: 'msg_wrong' }; };
  await assert.rejects(f.chief({ text: 'x' }), /uncertain; do not automatically retry/); assert.equal(sends, 2);
});
test('chief rotation fails closed before sending', async t => {
  const f = await fixture(t);
  await writerToolsPlugin(f.policy, { readChief: async () => ({ ...f.policy.chief, session: 'ses_other' }) }).setup(f.ctx);
  await assert.rejects(f.chief({ text: 'x' }), /Chief changed/); assert.equal(f.prompts.length, 0);
});
test('install refuses a symlinked plugin parent without publishing the agent', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, '.opencode'));
  const elsewhere = path.join(f.root, 'elsewhere'); await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(f.project, '.opencode/plugins'));
  await assert.rejects(installWriter(f.p), /Symlink denied/);
  assert.deepEqual(await fs.readdir(elsewhere), []);
  await assert.rejects(fs.stat(path.join(f.project, '.opencode/agents', `${f.p.agent}.md`)), { code: 'ENOENT' });
});
test('new artifacts install an exclusive guard; capability tampering and missing guard block startup', async t => {
  const f = await fixture(t);
  const file = await installWriter(f.p);
  assert.match(await fs.readFile(path.join(f.project, '.opencode/plugins', f.p.agent, 'index.mjs'), 'utf8'), /writerToolsPlugin/);
  const before = await fs.readFile(file, 'utf8'); await assert.rejects(installWriter(f.p)); assert.equal(await fs.readFile(file, 'utf8'), before);
  const changed = structuredClone(f.p); changed.capabilities.imageDirectory = f.project; await assert.rejects(verifyPrepared(changed));
  let creates = 0;
  const ctx = { location: { directory: f.project }, agent: { get: async () => ({ location: { directory: f.project }, data: { id: f.p.agent, ...f.p.profile } }) }, tool: { list: async () => [] }, session: { create: async () => { creates++; } } };
  await assert.rejects(executeNative(ctx, { kind: 'startup', binding: { sessionDirectory: f.project }, prepared: f.p }, async () => {}), /not loaded/);
  assert.equal(creates, 0);
});

test('one-command startup journals one exact native create, binds actual id and checks without sending', async t => {
  const f = await fixture(t), model = { providerID: 'fake', id: 'writer', variant: 'high' };
  const config = { binding: { sessionDirectory: f.project, draft: f.p.draft, assetRoots: [] }, model, stateDirectory: path.join(f.root, 'state') };
  let creates = 0, prepared = 0, installed = 0, activated = 0;
  f.ctx.agent = { get: async () => ({ location: { directory: f.project }, data: { id: f.p.agent, ...f.p.profile, permissions: [...f.p.profile.permissions, { action: 'browser', resource: '*', effect: 'deny' }] } }) };
  f.ctx.tool.list = async () => [...f.tools].map(([id, tool]) => ({ ...tool, id }));
  f.ctx.session.create = async input => { creates++; Object.assign(f.session, input); return f.session; };
  // The real guard is used; only the trusted binary execution is stubbed.
  await writerToolsPlugin(f.policy, { run: async (...args) => { f.calls.push(args); return { stdout: 'usage: --prompt --out' }; }, readChief: async () => f.policy.chief }).setup(f.ctx);
  const deps = {
    resolveOwner: async () => ({ ownerPID: process.pid, ownerStartedAt: Date.now() - process.uptime() * 1000 }),
    prepare: async () => { prepared++; return f.p; },
    install: async p => { installed++; return installWriter(p); },
    activateLocation: async directory => { assert.equal(directory, f.project); activated++; },
    connect: async ({ binding }) => ({
      identity: 'native:test', waitOwner: async () => {}, close: async () => {},
      startup: async (p, m) => {
        const journal = await readPrivate(path.join(config.stateDirectory, 'native', `startup-${p.agent}.json`));
        assert.equal(journal.state, 'uncertain');
        const s = await executeNative(f.ctx, { kind: 'startup', binding, prepared: p, model: m }, async () => {});
        binding.sessionId = s.id; return s;
      },
      selfCheck: async (p, m) => executeNative(f.ctx, { id: 'check1', kind: 'selfcheck', binding, prepared: p, model: m }, async () => {}),
    }),
  };
  const result = await startWriter(config, deps);
  assert.equal(result.sessionId, f.session.id);
  assert.deepEqual(f.session.permissions, f.p.profile.permissions);
  assert.deepEqual(f.session.model, model);
  assert.equal(result.selfCheck.chief.sent, false); assert.equal(f.prompts.length, 0);
  assert.deepEqual(f.calls[0].slice(0, 2), [imageCommand, ['--help']]);
  const binding = await readPrivate(result.binding);
  assert.equal(binding.sessionId, f.session.id); assert(binding.assetRoots.includes(f.policy.imageDirectory));
  const state = JSON.parse(await fs.readFile(path.join(config.stateDirectory, 'store/state.json')));
  assert.deepEqual(state.binding, binding);
  assert.deepEqual(await startWriter(config, deps), result);
  assert.deepEqual([creates, prepared, installed, activated], [1, 1, 1, 1]);
  await assert.rejects(startWriter({ ...config, model: { ...model, variant: 'low' } }, deps), /configuration changed/);
  f.ctx.agent.get = async () => ({ location: { directory: f.project }, data: { id: f.p.agent, ...f.p.profile, permissions: [...f.p.profile.permissions, { action: 'browser', resource: '*', effect: 'allow' }] } });
  await assert.rejects(executeNative(f.ctx, { kind: 'startup', binding: { sessionDirectory: f.project, agent: f.p.agent }, prepared: f.p, model }, async () => {}), /profile mismatch \(permissions\)/);
  assert.equal(creates, 1);
});

test('existing-session enrollment can resume a failed read-only check without installing or creating again', async t => {
  const f = await fixture(t), model = { providerID: 'fake', id: 'writer' };
  await installWriter(f.p); f.session.model = model;
  const preparedFile = path.join(f.root, 'prepared.json'); await fs.writeFile(preparedFile, JSON.stringify(f.p));
  const config = { binding: { sessionDirectory: f.project, draft: f.p.draft, assetRoots: [] }, model, preparedFile, sessionId: f.session.id, stateDirectory: path.join(f.root, 'state') };
  f.ctx.tool.list = async () => [...f.tools].map(([id, tool]) => ({ ...tool, id }));
  await writerToolsPlugin(f.policy, { run: async (...args) => { f.calls.push(args); return { stdout: 'usage: --prompt --out' }; }, readChief: async () => f.policy.chief }).setup(f.ctx);
  let attempts = 0;
  const deps = { mode: 'enroll', resolveOwner: async () => ({}), activateLocation: async () => {}, install: async () => assert.fail('must not install existing writer'), connect: async ({ binding }) => ({
    identity: 'native:test', waitOwner: async () => { if (++attempts === 1) throw new Error('owner unavailable'); }, close: async () => {},
    startup: async () => assert.fail('must not create'),
    selfCheck: (prepared, model) => executeNative(f.ctx, { id: 'check1', kind: 'selfcheck', binding, prepared, model }, async () => {}),
  }) };
  await assert.rejects(startWriter(config, deps), /owner unavailable/);
  const result = await startWriter(config, deps);
  assert.equal(result.sessionId, f.session.id); assert.equal(attempts, 2);
  assert.equal(f.calls.length, 1); assert.equal(f.prompts.length, 0);
  assert.equal((await readPrivate(path.join(config.stateDirectory, 'native', `startup-${f.p.agent}.json`))).source, 'verified-existing-session');
});

test('uncertain one-command create stays fenced and cannot bind or recreate on retry', async t => {
  const f = await fixture(t);
  const config = { binding: { sessionDirectory: f.project, draft: f.p.draft, assetRoots: [] }, model: { providerID: 'fake', id: 'writer' }, stateDirectory: path.join(f.root, 'state') };
  let creates = 0;
  const deps = { resolveOwner: async () => ({}), prepare: async () => f.p, activateLocation: async () => {}, connect: async () => ({ identity: 'native:test', waitOwner: async () => {}, close: async () => {}, startup: async () => { creates++; throw new Error('lost receipt'); } }) };
  await assert.rejects(startWriter(config, deps), /lost receipt/);
  await assert.rejects(startWriter(config, deps), /reconciliation/);
  assert.equal(creates, 1);
  await assert.rejects(fs.stat(path.join(config.stateDirectory, 'store')), { code: 'ENOENT' });
});

test('self-check refuses wrong permissions/model or unreachable chief before image execution', async t => {
  const f = await fixture(t), model = { providerID: 'fake', id: 'writer' };
  f.session.model = model;
  f.ctx.tool.list = async () => [...f.tools].map(([id, tool]) => ({ ...tool, id }));
  const job = { id: 'check1', kind: 'selfcheck', binding: { sessionId: f.session.id, sessionDirectory: f.project, agent: f.p.agent }, prepared: f.p, model };
  f.session.permissions = [];
  await assert.rejects(executeNative(f.ctx, job, async () => {}), /permissions don't match/);
  f.session.permissions = f.p.profile.permissions; f.session.model = { ...model, id: 'wrong' };
  await assert.rejects(executeNative(f.ctx, job, async () => {}), /model does not match/);
  f.session.model = model;
  const get = f.ctx.session.get;
  f.ctx.session.get = args => args.sessionID === f.policy.chief.session ? Promise.reject(new Error('chief missing')) : get(args);
  await assert.rejects(executeNative(f.ctx, job, async () => {}), /chief missing/);
  assert.equal(f.calls.length, 0); assert.equal(f.prompts.length, 0);
});
