#!/usr/bin/env node
import path from 'node:path';
import { boundedRead, noLinks } from '../src/files.mjs';
import { generateNative } from '../src/native-artifacts.mjs';
import { prepareWriter } from '../src/writer.mjs';
import * as fs from 'node:fs/promises';
try {
  const [command, preparedFile, output, bindingFile, ...extra] = process.argv.slice(2);
  if (!['prepare', 'generate'].includes(command) || !preparedFile || !output || !bindingFile || extra.length) throw new Error('Invalid arguments');
  const input = JSON.parse(await boundedRead(path.resolve(preparedFile), 2 * 1024 * 1024));
  const prepared = command === 'prepare' ? await prepareWriter(input) : input;
  await noLinks(path.resolve(output));
  if (command === 'prepare') {
    const h = await fs.open(path.join(path.resolve(output), 'prepared.json'), 'wx', 0o600);
    try { await h.writeFile(JSON.stringify(prepared, null, 2)); await h.sync(); } finally { await h.close(); }
  }
  await generateNative(prepared, path.resolve(output), path.resolve(bindingFile));
  console.log('Inert profile/plugin artifacts generated exclusively. Nothing installed or started.');
} catch {
  console.error('Usage: galley-writer.mjs prepare <binding.json> <existing-output-directory> <future-private-binding.json>, or generate <prepared.json> <output-directory> <binding.json>. Old desktop install/start commands are retired.');
  process.exitCode = 1;
}
