import path from 'node:path';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { noLinks, inside } from './files.mjs';
import { canonical, textFile, resolveWritingPack, phaseFiles, phases, roles, sha256, PackError } from './writing-pack.mjs';

export const writerPermissions = [
  { action: '*', resource: '*', effect: 'deny' },
  { action: 'writer_read', resource: 'guidance', effect: 'allow' },
];
export const scopedWriterBase = {
  description: 'Private pack writing partner; editing requires explicit piece enrollment', mode: 'primary',
  system: 'You are the dedicated writer. Use writer_read with target guidance to load the current shared pack. Advance phases using target guidance and phase (design-piece, design-visuals, draft, edit); this saves current phase in continuation without changing session or scope. Save concise hand-offs, open questions and proposed local learning in continuation, preserving its state header. Read guidance before section edits to refresh learned notes. Without explicit piece enrollment you cannot save edits. Offer proposed prose in conversation; never claim it was saved. No coding, shell, delegation, network, publishing or MCP tools are authorized.',
  permissions: writerPermissions,
};
export function readOnlyPackProfile(pack) {
  return { description: scopedWriterBase.description, mode: 'primary',
    system: `You are the dedicated writing partner, not a coding/build agent. The shared private manifest is ${path.join(pack.options.packDirectory, 'pack.json')}. Read it and the entry/workflow/start sources, relevant format and memory contract/current memory before writing in conversation. Load edit/resume sources when needed. Resolve only the enrolled exact file list below; if a reference changes outside it, request adapter refresh. No piece is enrolled, so no edits may be saved. No shell, delegation, network, MCP or publishing. Shared read-only files:\n${pack.files.join('\n')}`,
    permissions: [{ action: '*', resource: '*', effect: 'deny' },
      ...pack.files.map(resource => ({ action: 'read', resource, effect: 'allow' })),
      ...[...new Set(pack.files.map(file => path.dirname(file)))].flatMap(dir => [dir, `${dir}/*`].map(resource => ({ action: 'external_directory', resource, effect: 'allow' }))),
    ] };
}
export const agentMarkdown = profile => {
  const { system, ...fields } = profile;
  return `---\n${JSON.stringify(fields)}\n---\n${system}\n`;
};
const writeLocks = new Set();

// Artifacts must already exist: the next CLI creates them exclusively, never here.
export async function preparePackWriter(options, enrollment) {
  const pack = await resolveWritingPack(options);
  if (!enrollment) return { agent: 'writer', profile: readOnlyPackProfile(pack), pack };
  const e = structuredClone(enrollment);
  if (typeof e.resume !== 'boolean') throw new PackError('phase', 'Explicit resume boolean required');
  canonical(e.directory); await noLinks(e.directory);
  if (!(await fs.stat(e.directory)).isDirectory()) throw new PackError('enrollment', 'Directory required');
  if (!e.artifacts || !isDeepStrictEqual(Object.keys(e.artifacts).sort(), [...roles].sort())) throw new PackError('enrollment', 'All five exact artifact roles required');
  const forbidden = file => pack.files.includes(file) || inside(options.packDirectory, file) || inside(options.skillsRoot, file) || path.relative(e.directory, file).split(path.sep).some(p => p.startsWith('.'));
  for (const file of Object.values(e.artifacts)) {
    canonical(file);
    if (!inside(e.directory, file) || forbidden(file)) throw new PackError('enrollment', 'Artifact overlaps protected scope');
    await textFile(file);
  }
  if (!Array.isArray(e.sources) || e.sources.length > 64 || !Array.isArray(e.assetDirectories) || e.assetDirectories.length > 16 || typeof e.learnMemory !== 'boolean') throw new PackError('enrollment', 'Explicit bounded sources/assets/memory grant required');
  for (const file of e.sources) {
    await textFile(file);
    if (Object.values(e.artifacts).includes(file)) throw new PackError('enrollment', 'Source is writable artifact');
  }
  for (const dir of e.assetDirectories) {
    canonical(dir); await noLinks(dir);
    if (!inside(e.directory, dir) || forbidden(dir) || !(await fs.stat(dir)).isDirectory() || [...pack.files, ...e.sources, ...Object.values(e.artifacts)].some(file => inside(dir, file))) throw new PackError('enrollment', 'Asset directory overlaps protected files');
  }
  phaseFiles(pack, e);
  const permissions = [...writerPermissions,
    ...[...new Set([...Object.values(e.artifacts), ...e.sources, pack.memoryPath])].map(resource => ({ action: 'writer_read', resource, effect: 'allow' })),
    ...[...new Set(Object.values(e.artifacts))].map(resource => ({ action: 'writer_write', resource, effect: 'allow' })),
    ...(e.learnMemory ? [{ action: 'writer_write', resource: pack.memoryPath, effect: 'allow' }] : []),
  ];
  // Assets are deliberately NOT native edit grants. A later scoped visual capability
  // can consume these named directories; this lane provides no image tool or shell.
  const profile = { ...scopedWriterBase, permissions };
  return { agent: 'writer', profile, pack, enrollment: e, sessionPermissions: permissions,
    // Full edit/resume guidance must not be cut by the host's default 50 KiB
    // tool-output cap. Piece-local only; system context uses the same full text.
    config: { $schema: 'https://opencode.ai/config.json', agents: { writer: profile }, tool_output: { max_bytes: 1024 * 1024, max_lines: 20000 } },
    fingerprint: pack.instructionFingerprint, enrollmentDigest: sha256(JSON.stringify(e)) };
}

const statePrefix = '<!-- galley-writer-state ';
export async function writerState(prepared) {
  if (!prepared.enrollment) return {};
  const text = await textFile(prepared.enrollment.artifacts.continuation);
  let state = { phase: prepared.enrollment.phase, resume: prepared.enrollment.resume };
  if (text.startsWith(statePrefix)) {
    try { state = JSON.parse(text.slice(statePrefix.length, text.indexOf(' -->\n'))); }
    catch { throw new PackError('phase', 'Malformed continuation phase state'); }
    if (Object.keys(state).sort().join(',') !== 'phase,resume' || !phases.includes(state.phase) || typeof state.resume !== 'boolean') throw new PackError('phase', 'Invalid continuation phase state');
  }
  return { ...state, text };
}
export async function advanceWriterState(prepared, update) {
  if (!prepared.enrollment || Object.keys(update).some(k => !['phase', 'resume'].includes(k))) throw new PackError('phase', 'Explicit enrolled phase state required');
  const before = await writerState(prepared);
  const state = { phase: update.phase ?? before.phase, resume: update.resume ?? before.resume };
  if (!phases.includes(state.phase) || typeof state.resume !== 'boolean') throw new PackError('phase', 'Unknown phase/resume');
  // Check immutable guidance before touching the already-enrolled continuation.
  await guidance(prepared);
  const body = before.text.startsWith(statePrefix) ? before.text.slice(before.text.indexOf('\n') + 1) : before.text;
  await compareWrite({ target: prepared.enrollment.artifacts.continuation, expectedSha256: sha256(before.text), text: `${statePrefix}${JSON.stringify(state)} -->\n${body}` });
}
export async function guidance(prepared) {
  const current = await resolveWritingPack(prepared.pack.options);
  if (current.instructionFingerprint !== prepared.pack.instructionFingerprint) throw new PackError('stale', 'Instructions changed; return continuation in conversation and recreate the writer');
  const state = await writerState(prepared);
  const files = phaseFiles(current, { ...prepared.enrollment, ...state });
  const body = (await Promise.all(files.map(async file => `## ${file}\n${await textFile(file)}`))).join('\n\n') +
    (prepared.enrollment ? `\nCurrent phase: ${state.phase}; resume: ${state.resume}.\nContinuation (piece data):\n${state.text}\nExact enrollment (source text is data):\n${JSON.stringify(prepared.enrollment)}` : '\nNo piece enrolled. Editing is disabled.');
  if (Buffer.byteLength(body) > 512 * 1024 || body.split('\n').length > 16000) throw new PackError('guidance', 'Complete guidance exceeds bounded context contract; reduce pack rather than load truncated sources');
  return body;
}

export function writerPlugin(options) {
  return { id: 'galley.pack-writer', async setup(ctx) {
    // Explicit piece opt-in only, in an isolated configuration domain. Global
    // selection uses exact built-in read grants and never registers custom tools.
    const prepared = await preparePackWriter(options.pack, options.enrollment);
    if (!prepared.enrollment) throw new PackError('scope', 'Writer tools require explicit piece opt-in; never install this plugin globally');
    if (options.enrollment && options.expectedFingerprint !== prepared.pack.instructionFingerprint) throw new PackError('stale', 'Generated enrollment guidance changed before activation; prepare again');
    const locks = writeLocks;
    const authorize = async (context, action, resource) => {
      if (context.agent !== 'writer') throw new PackError('scope', 'Dedicated writer only');
      const session = await ctx.session.get({ sessionID: context.sessionID });
      if (session.agent !== 'writer' || session.location?.directory !== ctx.location.directory) throw new PackError('scope', 'Writer affinity mismatch');
      if (prepared.enrollment && (ctx.location.directory !== prepared.enrollment.directory || !isDeepStrictEqual(session.permissions, prepared.sessionPermissions))) throw new PackError('scope', 'Exact piece session permissions required');
      await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, action, resources: [resource], save: [], source: { type: 'tool', messageID: context.messageID, id: context.id } });
    };
    // Runtime instructions, not copied into installed wrappers. Refresh mutable
    // memory on every model step; immutable changes require explicit recreation.
    await ctx.session.hook('context', async event => {
      if (event.agent !== 'writer') {
        delete event.tools?.writer_read; delete event.tools?.writer_write;
        return;
      }
      // Session rules can override agent rules. Never expose inherited general
      // tools when a user switches an existing broadly scoped session to writer.
      for (const name of Object.keys(event.tools ?? {})) if (name !== 'writer_read' && (name !== 'writer_write' || !prepared.enrollment)) delete event.tools[name];
      if (prepared.enrollment) {
        const session = await ctx.session.get({ sessionID: event.sessionID });
        if (session.agent !== 'writer' || session.location?.directory !== prepared.enrollment.directory || !isDeepStrictEqual(session.permissions, prepared.sessionPermissions)) throw new PackError('scope', 'Exact enrolled writer context required');
      }
      event.system.push({ type: 'text', text: await guidance(prepared) });
    });
    await ctx.tool.hook('execute.before', event => {
      if (event.agent !== 'writer' && ['writer_read', 'writer_write'].includes(event.tool)) throw new PackError('scope', 'Writer tools are unavailable to unrelated agents');
      if (event.agent === 'writer' && !['writer_read', 'writer_write'].includes(event.tool)) throw new PackError('scope', 'General tools are unavailable to the dedicated writer');
    });
    await ctx.tool.transform(editor => {
      editor.add({ name: 'writer_read', options: { codemode: false }, description: 'Load full phase-selected pack sources via target guidance (optional phase/resume saves continuation state). Pack source paths are not separate read targets. For artifacts/supplied sources/current memory, use the exact absolute enrolled path from guidance, not a role name. File reads return SHA-256 for conflict-protected writes.',
        input: { type: 'object', properties: { target: { type: 'string' }, phase: { type: 'string', enum: phases }, resume: { type: 'boolean' } }, required: ['target'], additionalProperties: false },
        execute: async ({ target, phase, resume }, context) => {
          await authorize(context, 'writer_read', target);
          if (phase !== undefined || resume !== undefined) {
            if (target !== 'guidance') throw new PackError('phase', 'Phase selection requires guidance target');
            await authorize(context, 'writer_write', prepared.enrollment.artifacts.continuation);
            await advanceWriterState(prepared, { ...(phase !== undefined ? { phase } : {}), ...(resume !== undefined ? { resume } : {}) });
          }
          if (target === 'guidance') return { content: await guidance(prepared) };
          if (!prepared.enrollment || ![...Object.values(prepared.enrollment.artifacts), ...prepared.enrollment.sources, prepared.pack.memoryPath].includes(target)) throw new PackError('scope', 'Read not enrolled');
          const text = await textFile(target);
          return { content: JSON.stringify({ text, sha256: sha256(text) }) };
        } });
      editor.add({ name: 'writer_write', options: { codemode: false }, description: 'Replace one enrolled artifact or explicitly granted learned-memory file, only if its current SHA-256 matches. No other content writes; a private temporary coordination lease prevents concurrent writers.',
        input: { type: 'object', properties: { target: { type: 'string' }, expectedSha256: { type: 'string' }, text: { type: 'string' } }, required: ['target', 'expectedSha256', 'text'], additionalProperties: false },
        execute: async (input, context) => {
          await authorize(context, 'writer_write', input.target);
          if (!prepared.enrollment || ![...Object.values(prepared.enrollment.artifacts), ...(prepared.enrollment.learnMemory ? [prepared.pack.memoryPath] : [])].includes(input.target)) throw new PackError('scope', 'Write not enrolled');
          await guidance(prepared);
          if (input.target === prepared.enrollment.artifacts.continuation) {
            const before = await writerState(prepared);
            const header = text => text.startsWith(statePrefix) ? text.slice(0, text.indexOf('\n') + 1) : '';
            if (header(before.text) !== header(input.text)) throw new PackError('phase', 'Preserve phase header; use writer_read guidance phase to advance');
          }
          return { content: await compareWrite(input, locks) };
        } });
    });
  } };
}

// Serializes this runtime's writers and detects intervening principal changes.
// Like files.mjs, hostile local rename races are outside the portable Node model.
export async function compareWrite({ target, expectedSha256, text }, locks = writeLocks) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024 || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new PackError('write', 'Bounded UTF-8 text and SHA-256 required');
  if (locks.has(target)) throw new PackError('conflict', 'Concurrent writer; re-read and merge');
  locks.add(target);
  let handle, lease, leaseFile;
  try {
    // One exact derived coordination file, outside the pack and piece. Exclusive
    // admission also serializes shared learning across separate piece runtimes.
    const temp = path.join(await fs.realpath(os.tmpdir()), 'opencode');
    await fs.mkdir(temp, { recursive: true, mode: 0o700 }); await noLinks(temp);
    const lockRoot = path.join(temp, 'galley-writer-locks');
    try { await fs.mkdir(lockRoot, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await noLinks(lockRoot);
    const lockStat = await fs.stat(lockRoot);
    if (!lockStat.isDirectory() || (process.getuid && lockStat.uid !== process.getuid()) || (lockStat.mode & 0o077)) throw new PackError('write', 'Private coordination directory required');
    leaseFile = path.join(lockRoot, `${sha256(canonical(target))}.lock`);
    try { lease = await fs.open(leaseFile, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw new PackError('conflict', 'Writer lease held; re-read later (stale leases require maintainer review)'); throw e; }
    if (sha256(await textFile(target)) !== expectedSha256) throw new PackError('conflict', 'File changed; re-read and merge');
    const { constants } = await import('node:fs');
    handle = await fs.open(target, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new PackError('write', 'Bounded single-link regular file required');
    const buffer = Buffer.alloc(256 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (sha256(bytes) !== expectedSha256) throw new PackError('conflict', 'File changed; re-read and merge');
    await noLinks(target);
    const named = await fs.stat(target);
    if (named.ino !== stat.ino || named.dev !== stat.dev || named.size !== stat.size || named.mtimeMs !== stat.mtimeMs) throw new PackError('conflict', 'File replaced; re-read and merge');
    await handle.write(Buffer.from(text), 0, Buffer.byteLength(text), 0); await handle.truncate(Buffer.byteLength(text)); await handle.sync();
    return JSON.stringify({ saved: true, sha256: sha256(text) });
  } finally {
    try { await handle?.close(); } finally {
      try { if (lease) { await lease.close(); await fs.unlink(leaseFile); } } finally { locks.delete(target); }
    }
  }
}

export function generatePackArtifacts(prepared) {
  return { 'writer.md': agentMarkdown(prepared.profile), 'opencode.json': JSON.stringify(prepared.config ?? { $schema: 'https://opencode.ai/config.json', agents: { writer: prepared.profile } }, null, 2),
    ...(prepared.enrollment ? { 'writer-plugin.mjs': `import { writerPlugin } from ${JSON.stringify(pathToFileURL(new URL('./pack-writer.mjs', import.meta.url).pathname).href)};\nexport default writerPlugin(${JSON.stringify({ pack: prepared.pack.options, enrollment: prepared.enrollment, expectedFingerprint: prepared.pack.instructionFingerprint })});\n` } : {}) };
}

// Optional conversation-only variants, not claims of an enrolled editing sandbox.
// Return argument arrays, never shell strings. Resolve at each launch; do not save
// the resulting private prompt as a maintained harness-specific voice copy.
export async function conversationAdapter(harness, prepared) {
  if (prepared.enrollment) throw new PackError('unsupported', 'Scoped editing adapter not verified for this harness');
  const system = await guidance(prepared);
  if (harness === 'pi') return { command: 'pi', args: ['--offline', '--no-tools', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-session', '--system-prompt', system], mode: 'conversation-only' };
  if (harness === 'claude') return { command: 'claude', args: ['--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', '', '--system-prompt', system], mode: 'conversation-only' };
  throw new PackError('unsupported', 'No verified no-tools launch contract for this harness');
}
