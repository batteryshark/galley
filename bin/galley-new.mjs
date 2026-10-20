#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readPrivate, writePrivate } from '../src/private.mjs';
import { validatePieceConfig } from '../src/new-piece.mjs';
import { ipcRequest } from '../src/native-ipc.mjs';

export async function newPieceCLI(args, env = process.env) {
  const { values: v } = parseArgs({ args, strict: true, options: {
    config: { type: 'string' }, install: { type: 'string' }, title: { type: 'string' }, format: { type: 'string' },
    resume: { type: 'string' }, 'resume-allocated': { type: 'string' }, 'expected-allocation': { type: 'string' }, id: { type: 'string' },
    source: { type: 'string', multiple: true }, 'learn-memory': { type: 'boolean' },
  } });
  const configFile = v.config || env.GALLEY_NEW_CONFIG;
  if (!configFile || !path.isAbsolute(configFile)) throw new Error('Set GALLEY_NEW_CONFIG or --config to private local configuration');
  if (v.install) {
    if (v.title || v.resume || v['resume-allocated'] || v['expected-allocation'] || v.format || v.id || v.source || v['learn-memory']) throw new Error('Install is separate from new/resume');
    const c = await validatePieceConfig(await readPrivate(path.resolve(v.install)));
    await writePrivate(configFile, c, { exclusive: true });
    return { installed: true }; // Inert; activation belongs to the managed service.
  }
  const c = await readPrivate(configFile);
  const binding = await readPrivate(path.join(c.controlDirectory, 'control.json'));
  if (v['resume-allocated']) {
    if (!v['expected-allocation'] || v.resume || v.title || v.format || v.id || v.source || v['learn-memory']) throw new Error('Allocated recovery requires only id and private expected identity');
    return ipcRequest(binding, { op: 'resumeAllocated', id: v['resume-allocated'], input: await readPrivate(path.resolve(v['expected-allocation'])) }, 60000);
  }
  if (v['expected-allocation']) throw new Error('Expected allocation only for explicit recovery');
  if (v.resume && (v.title || v.format || v.id || v.source || v['learn-memory'])) throw new Error('Resume accepts only a piece id');
  if (!v.resume && (!v.title || !v.format)) throw new Error('Supply --title and --format, or --resume ID');
  return ipcRequest(binding, v.resume ? { op: 'resume', id: v.resume } : { op: 'new', input: { title: v.title, format: v.format, ...(v.id ? { id: v.id } : {}), sources: (v.source || []).map(file => path.resolve(file)), learnMemory: v['learn-memory'] === true } }, 60000);
}
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  try { console.log(JSON.stringify(await newPieceCLI(process.argv.slice(2)))); }
  catch { console.error('Galley new-piece refused. Check private configuration/journal and runtime activation. Resume ready pieces only; never reset or replay uncertain startup.'); process.exitCode = 1; }
}
