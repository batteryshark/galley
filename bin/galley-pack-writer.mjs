#!/usr/bin/env node
// Maintainer-only inert generation. Does not create sessions/install/restart.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { preparePackWriter, generatePackArtifacts } from '../src/pack-writer.mjs';
import { noLinks } from '../src/files.mjs';
import { textFile } from '../src/writing-pack.mjs';

try {
  const allowed = new Set(['--pack-directory', '--skills-root', '--expected-version', '--enrollment', '--output']);
  const args = process.argv.slice(2), input = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || input[args[i]] !== undefined) throw Error('Expected unique explicit option/value pairs');
    input[args[i]] = args[i + 1];
  }
  const enrollment = input['--enrollment'] ? JSON.parse(await textFile(input['--enrollment'])) : undefined;
  const prepared = await preparePackWriter({ packDirectory: input['--pack-directory'], skillsRoot: input['--skills-root'], expectedVersion: input['--expected-version'] }, enrollment);
  const output = input['--output']; await noLinks(output);
  if ((await fs.readdir(output)).length) throw Error('Private output directory must be empty');
  const files = generatePackArtifacts(prepared);
  for (const [name, bytes] of Object.entries(files)) {
    const h = await fs.open(path.join(output, name), 'wx', 0o600);
    try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
  }
  console.log(JSON.stringify({ ok: true, agent: prepared.agent, files: Object.keys(files), fingerprint: prepared.pack.instructionFingerprint }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code ?? 'adapter', message: error.code && !['path','manifest','schema','version','source-version','missing','io','phase','enrollment'].includes(error.code) ? 'Private artifact operation failed' : error.message }));
  process.exitCode = 2;
}
