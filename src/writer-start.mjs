import path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual as equal } from 'node:util';
import { prepareWriter, installWriter, verifyPrepared } from './writer.mjs';
import { boundedRead, noLinks, validateBinding } from './files.mjs';
import { privateDirectory, privateLock, readPrivate, writePrivate } from './private.mjs';
import { openNative } from './native-ipc.mjs';
import { startPreparedWriter } from './startup.mjs';
import { openStore } from './store.mjs';
import { processBirth } from './native-owner.mjs';

async function runtimeOwner(runtime) {
  if (!runtime || !path.isAbsolute(runtime.executable) || !runtime.version) throw new Error('Explicit runtime executable, version and existing server required');
  const server = new URL(runtime.server);
  if (server.origin !== runtime.server || server.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname)) throw new Error('Explicit existing loopback native server required');
  await noLinks(runtime.executable);
  const run = promisify(execFile);
  const version = await run(runtime.executable, ['--version'], { timeout: 10000 });
  if (version.stdout.trim().replace(/^opencode v/, '') !== runtime.version) throw new Error('CLI version differs from configured native runtime');
  const response = await run(runtime.executable, ['api', '--server', runtime.server, 'get', '/api/info'], { timeout: 10000 });
  const info = JSON.parse(response.stdout);
  if (info.version !== runtime.version || !Number.isSafeInteger(info.pid) || info.pid < 1) throw new Error('Native host version/PID mismatch');
  return { ownerPID: info.pid, ownerStartedAt: processBirth(info.pid) };
}

async function activate(directory, runtime) {
  const run = promisify(execFile);
  const query = `?location[directory]=${encodeURIComponent(directory)}`;
  // Explicit existing host and location; cwd alone does not scope V2 API calls.
  await run(runtime.executable, ['api', '--server', runtime.server, 'post', `/api/location/reload${query}`], { cwd: directory, timeout: 30000 });
  await run(runtime.executable, ['api', '--server', runtime.server, 'get', `/api/model/default${query}`], { cwd: directory, timeout: 30000 });
}

async function savePrepared(file, prepared) {
  const h = await fs.open(file, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(prepared, null, 2)); await h.sync(); } finally { await h.close(); }
  const d = await fs.open(path.dirname(file), 'r'); try { await d.sync(); } finally { await d.close(); }
}

// Operator-only, journaled orchestration. No model prompt, image generation or chief send.
export async function startWriter(config, { mode = 'start', prepare = prepareWriter, install = installWriter, verify = verifyPrepared, connect = openNative, activateLocation = activate, resolveOwner = runtimeOwner } = {}) {
  if (!['start', 'enroll'].includes(mode)) throw new Error('Use start or enroll');
  const { binding: input, model, stateDirectory } = config;
  if (!input || !model || typeof model.providerID !== 'string' || !model.providerID || typeof model.id !== 'string' || !model.id || Object.keys(model).some(k => !['providerID', 'id', 'variant'].includes(k)) || (model.variant !== undefined && (typeof model.variant !== 'string' || !model.variant))) throw new Error('Explicit binding and model required');
  if (input.sessionId !== undefined || input.upstreamIdentity !== undefined) throw new Error('Do not supply placeholder session/upstream ids; the command binds the actual writer');
  if (mode === 'start' && (config.sessionId || config.preparedFile)) throw new Error('start prepares a new writer; use enroll for an existing repaired session');
  if (mode === 'enroll' && (!/^ses_[\w-]+$/.test(config.sessionId || '') || !config.preparedFile)) throw new Error('enroll requires exact sessionId and preparedFile');
  await noLinks(input.sessionDirectory);
  await privateDirectory(stateDirectory, input.sessionDirectory);
  if (Buffer.byteLength(path.join(stateDirectory, 'native/ipc.sock')) > 100) throw new Error('Choose a shorter stateDirectory for the native socket (at most 100 bytes)');
  return privateLock(stateDirectory, async () => {
    const operationFile = path.join(stateDirectory, 'operation.json');
    let existing;
    try { existing = await readPrivate(operationFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing) {
      const expectedConfig = mode === 'enroll' && !existing.config.runtime && config.runtime ? { ...existing.config, runtime: config.runtime } : existing.config;
      if (!equal(expectedConfig, config) || existing.mode !== mode) throw new Error('Writer configuration changed; retain this enrollment and its journals');
      if (existing.state === 'ready') return existing.result;
      if (mode !== 'enroll') throw new Error(`Writer startup requires reconciliation; do not retry creation or delete journals${existing.sessionId ? ` (session ${existing.sessionId})` : ''}`);
      // Enrollment only repeats read-only checks of an explicitly supplied existing
      // session; it cannot create a writer or deliver a prompt. Keep all journals.
    }
    const imageDirectory = path.join(input.sessionDirectory, '_images');
    try { await fs.mkdir(imageDirectory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const binding = await validateBinding({ ...input, assetRoots: [...new Set([...(input.assetRoots || []), imageDirectory])] }, { unbound: true });
    const owner = await resolveOwner(config.runtime);
    const operation = { state: 'preparing', mode, config, attempts: (existing?.attempts || 0) + 1 };
    await writePrivate(operationFile, operation, { exclusive: !existing });
      const prepared = mode === 'start' ? await prepare(binding) : JSON.parse(await boundedRead(path.resolve(config.preparedFile), 2 * 1024 * 1024));
      if (!prepared.capabilities) throw new Error('Supported startup requires explicit binding.writerTools configuration');
    if (prepared.directory !== binding.sessionDirectory || prepared.draft !== binding.draft) throw new Error('Prepared writer does not match enrollment');
    await verify(prepared);
    if (existing) {
      const saved = JSON.parse(await boundedRead(path.join(stateDirectory, 'prepared.json'), 2 * 1024 * 1024));
      if (!equal(saved, prepared)) throw new Error('Saved prepared writer changed');
    } else await savePrepared(path.join(stateDirectory, 'prepared.json'), prepared);
    if (mode === 'start') await install(prepared);
    binding.agent = prepared.agent;
    if (mode === 'enroll') binding.sessionId = config.sessionId;
    const nativeDirectory = path.join(stateDirectory, 'native');
    await privateDirectory(nativeDirectory, prepared.directory);
    if (existing) {
      for (const file of [path.join(nativeDirectory, `startup-${prepared.agent}.json`), path.join(stateDirectory, 'store/state.json')]) {
        try { await fs.lstat(file); throw new Error('Enrollment already verified or partially bound; reconcile its retained journals'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
    const pluginDirectory = path.join(prepared.directory, '.opencode/plugins', `${prepared.agent}-startup`);
    await noLinks(path.dirname(pluginDirectory));
    if (!existing) await fs.mkdir(pluginDirectory, { mode: 0o700 });
    await noLinks(pluginDirectory);
    const source = `import { nativePlugin } from ${JSON.stringify(new URL('./native-plugin.mjs', import.meta.url).href)};\nexport default nativePlugin(${JSON.stringify(path.join(nativeDirectory, 'binding.json'))}, { id: ${JSON.stringify(`galley.start.${prepared.agent}`)} });\n`;
    if (existing) {
      if ((await boundedRead(path.join(pluginDirectory, 'index.mjs'))).toString() !== source) throw new Error('Installed native entry changed');
    } else {
      const h = await fs.open(path.join(pluginDirectory, 'index.mjs'), 'wx', 0o600);
      try { await h.writeFile(source); await h.sync(); } finally { await h.close(); }
    }
    let native, store;
    try {
      native = await connect({ directory: nativeDirectory, binding, leaseMs: 20000, ...owner });
      await activateLocation(prepared.directory, config.runtime);
      await native.waitOwner();
      const session = mode === 'start'
        ? await startPreparedWriter(prepared, model, { directory: nativeDirectory, connector: native })
        : { id: config.sessionId };
      operation.sessionId = session.id; operation.state = 'checking';
      await writePrivate(operationFile, operation);
      const check = await native.selfCheck(prepared, model);
      if (check.sessionId !== session.id || check.imageHelp !== true || check.chief?.reachable !== true || check.chief.sent !== false || check.chief.chief !== prepared.capabilities.chief.session) throw new Error('Writer self-check failed');
      if (mode === 'enroll') await writePrivate(path.join(nativeDirectory, `startup-${prepared.agent}.json`), { state: 'created-not-edit-verified', agent: prepared.agent, digest: prepared.digest, sessionId: session.id, source: 'verified-existing-session' }, { exclusive: true });
      const enrolled = await validateBinding({ ...binding, sessionId: session.id, upstreamIdentity: native.identity });
      const storeDirectory = path.join(stateDirectory, 'store');
      store = await openStore(storeDirectory, enrolled);
      await writePrivate(path.join(stateDirectory, 'binding.json'), enrolled, { exclusive: true });
      await writePrivate(path.join(stateDirectory, 'operator.json'), { mode: 'attach', privateDirectory: nativeDirectory, storeDirectory, ...owner }, { exclusive: true });
      const result = { sessionId: session.id, agent: prepared.agent, directory: prepared.directory, model, selfCheck: check, binding: path.join(stateDirectory, 'binding.json'), operator: path.join(stateDirectory, 'operator.json'), review: 'enrolled; attach review service and issue a link' };
      await writePrivate(operationFile, { ...operation, state: 'ready', result });
      return result;
    } finally { await store?.close(); await native?.close(); }
  });
}
