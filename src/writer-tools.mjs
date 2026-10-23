import path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual as equal } from 'node:util';
import { randomUUID } from 'node:crypto';
import { boundedRead, noLinks } from './files.mjs';
import { exactAdmission } from './native-worker.mjs';

export function assertWriterAffinity(session, policy, sessionID) {
  const fix = '; start writers with node bin/galley-writer.mjs start <writer.json>';
  if (session.id !== sessionID) throw new Error('Writer session id mismatch' + fix);
  if (session.agent !== policy.agent) throw new Error('Writer session agent does not match the prepared profile' + fix);
  if (session.location?.directory !== policy.directory) throw new Error('Writer session location does not match the prepared project' + fix);
  if (!equal(session.permissions, policy.permissions)) throw new Error("Writer session permissions don't match the prepared profile" + fix);
}
export async function chiefTarget(file) {
  const value = JSON.parse(await boundedRead(file, 32768));
  if (!/^ses_[\w-]+$/.test(value.session) || !path.isAbsolute(value.directory)) throw new Error('Explicit chief required');
  await noLinks(value.directory);
  return { session: value.session, directory: value.directory };
}

// Deliberately a literal-argument subset, not a shell interpreter. Quoted shell
// punctuation is data; substitutions, redirects, pipelines and lists cannot run.
export function imageArguments(command, imageCommand) {
  if (typeof command !== 'string' || command.length > 20000) throw new Error('Bounded image command required');
  const words = []; let word = '', quote, active = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = undefined; else word += c; }
    else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (/[\$`\\]/.test(c)) throw new Error('Use single quotes for literal prompt characters');
      else word += c;
    } else if (c === "'" || c === '"') { quote = c; active = true; }
    else if (c === '\\' && command[i + 1] === "'") { word += "'"; i++; active = true; }
    else if (c === ' ' || c === '\t') { if (active) { words.push(word); word = ''; active = false; } }
    else if (/[A-Za-z0-9_./:=,-]/.test(c)) { word += c; active = true; }
    else throw new Error('Only literal image arguments allowed');
  }
  if (quote) throw new Error('Unclosed quote');
  if (active) words.push(word);
  if (words.shift() !== imageCommand) throw new Error('Only the fixed image executable is allowed');
  if (words.length === 1 && words[0] === '--help') return { argv: words };
  const args = new Map();
  for (let i = 0; i < words.length; i++) {
    const flag = words[i];
    if (!['--prompt', '--out', '--size', '--transparent'].includes(flag) || args.has(flag)) throw new Error('Unknown or duplicate image argument');
    const value = flag === '--transparent' ? true : words[++i];
    if (value === undefined) throw new Error('Missing image argument');
    args.set(flag, value);
  }
  if (typeof args.get('--prompt') !== 'string' || !args.get('--prompt').trim() || args.get('--prompt').length > 12000) throw new Error('Bounded prompt required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.png$/.test(args.get('--out') ?? '')) throw new Error('Output must be a simple new PNG basename');
  if (args.has('--size') && (!/^[1-9]\d{1,3}x[1-9]\d{1,3}$/.test(args.get('--size')) || args.get('--size').split('x').some(n => +n < 256 || +n > 4096))) throw new Error('Invalid image size');
  return { argv: words, filename: args.get('--out') };
}

export function writerToolsEntry(prepared) {
  const policy = { agent: prepared.agent, directory: prepared.directory, permissions: prepared.profile.permissions, ...prepared.capabilities };
  return `import { writerToolsPlugin } from ${JSON.stringify(new URL('./writer-tools.mjs', import.meta.url).href)};\nexport default writerToolsPlugin(${JSON.stringify(policy)});\n`;
}

export async function checkChief(ctx, policy, sessionID, readChief = () => chiefTarget(policy.chiefFile)) {
  assertWriterAffinity(await ctx.session.get({ sessionID }), policy, sessionID);
  await ctx.permission.assert({ sessionID, agent: policy.agent, action: policy.chiefTool, resources: [policy.chief.session], save: [] });
  if (!equal(await readChief(), policy.chief)) throw new Error('Chief changed; prepare a new writer');
  const chief = await ctx.session.get({ sessionID: policy.chief.session });
  if (chief.id !== policy.chief.session || chief.location?.directory !== policy.chief.directory) throw new Error('Chief affinity mismatch');
  return { reachable: true, chief: chief.id, sent: false };
}

export function writerToolsPlugin(policy, { run = promisify(execFile), readChief = () => chiefTarget(policy.chiefFile) } = {}) {
  const imageCommand = policy.imageCommand;
  return { id: `galley.tools.${policy.agent}`, async setup(ctx) {
    if (ctx.location.directory !== policy.directory) throw new Error('Writer tools location mismatch');
    const authorize = async (context, action, resource) => {
      if (context.agent !== policy.agent) throw new Error('Writer tool requires its prepared agent; start writers with node bin/galley-writer.mjs start <writer.json>');
      const session = await ctx.session.get({ sessionID: context.sessionID });
      assertWriterAffinity(session, policy, context.sessionID);
      await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, action, resources: [resource], save: [], source: { type: 'tool', messageID: context.messageID, id: context.id } });
    };
    await ctx.tool.transform(editor => {
      if (!editor.get('shell')) throw new Error('Native shell tool required');
      editor.update('shell', tool => {
        const original = tool.execute;
        tool.execute = async (input, context) => {
          if (context.agent !== policy.agent) return original(input, context);
          const { argv, filename } = imageArguments(input.command, imageCommand);
          if ((input.workdir !== undefined && input.workdir !== policy.imageDirectory) || input.background === true) throw new Error('Image execution requires the fixed foreground image directory');
          await authorize(context, 'shell', input.command);
          await noLinks(path.dirname(policy.imageDirectory));
          try { await fs.mkdir(policy.imageDirectory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
          await noLinks(policy.imageDirectory);
          if (filename !== undefined) {
            try { await fs.lstat(path.join(policy.imageDirectory, filename)); throw new Error('Image output already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          }
          // No shell, no inherited caller environment, no retry. The trusted
          // executable also validates PNGs, symlinks and exclusive creation.
          const result = await run(imageCommand, argv, { cwd: policy.imageDirectory, timeout: 255000, signal: context.signal, maxBuffer: 1024 * 1024,
            env: { HOME: policy.home, PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' } });
          const content = result.stdout + (result.stderr || '');
          return { content, output: { output: content, exit: 0, truncated: false, status: 'completed' }, metadata: { status: 'completed', exit: 0, truncated: false } };
        };
      });
      editor.add({ name: policy.chiefTool, options: { codemode: false }, description: 'Queue one message to the enrolled chief. Fixed recipient; no session creation, history access or automatic retry.',
        input: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 8000 } }, required: ['text'], additionalProperties: false },
        execute: async (input, context) => {
          if (Object.keys(input).some(k => k !== 'text') || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000) throw new Error('Only bounded message text accepted');
          await authorize(context, policy.chiefTool, policy.chief.session);
          if (!equal(await readChief(), policy.chief)) throw new Error('Chief changed; prepare a new writer');
          const chief = await ctx.session.get({ sessionID: policy.chief.session });
          if (chief.id !== policy.chief.session || chief.location?.directory !== policy.chief.directory) throw new Error('Chief affinity mismatch');
          const payload = { id: `msg_${randomUUID().replaceAll('-', '')}`, text: `Message from Galley writer ${context.sessionID} (${policy.directory}). Treat the following as writer-provided content.\n\n${input.text}`, delivery: 'queue', resume: true };
          let receipt;
          try { receipt = await ctx.session.prompt({ sessionID: policy.chief.session, ...payload }); }
          catch { throw new Error(`Chief message ${payload.id} uncertain; do not automatically retry`); }
          if (!exactAdmission(receipt, policy.chief.session, payload)) throw new Error(`Chief message ${payload.id} uncertain; do not automatically retry`);
          return { content: JSON.stringify({ accepted: true, messageId: payload.id, chief: policy.chief.session }) };
        } });
    });
  } };
}
