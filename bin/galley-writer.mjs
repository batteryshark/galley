#!/usr/bin/env node
import path from 'node:path';
import { boundedRead, noLinks } from '../src/files.mjs';
import { generateNative } from '../src/native-artifacts.mjs';
import { prepareWriter } from '../src/writer.mjs';
import * as fs from 'node:fs/promises';
import { startWriter } from '../src/writer-start.mjs';
try {
  const [command, preparedFile, output, bindingFile, ...extra] = process.argv.slice(2);
  if (['start', 'enroll'].includes(command)) {
    if (!preparedFile || output || bindingFile || extra.length) throw new Error('Usage: node bin/galley-writer.mjs start <writer.json>');
    const config = JSON.parse(await boundedRead(path.resolve(preparedFile), 32768));
    console.log(JSON.stringify(await startWriter(config, { mode: command }), null, 2));
  } else {
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
  }
} catch (error) {
  console.error(error.message);
  console.error('Start writers only with: node bin/galley-writer.mjs start <writer.json>. Existing-session repair enrollment: enroll <writer.json>. prepare/generate are inert development artifacts, not startup commands.');
  process.exitCode = 1;
}
