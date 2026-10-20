import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from '../fixtures/writing-pack.mjs';
import { preparePackWriter, generatePackArtifacts } from '../../src/pack-writer.mjs';
import { installPieceDomain } from '../../src/new-piece.mjs';

test('actual V2 SDK discovery, outgoing schemas and production plugin layout', { timeout: 45000 }, async t => {
  const f = await fixture(t), p = await preparePackWriter(f.options), files = generatePackArtifacts(p);
  const config = path.join(f.root, 'config', 'opencode');
  await fs.mkdir(path.join(config, 'agents'), { recursive: true });
  await fs.writeFile(path.join(config, 'agents', 'writer.md'), files['writer.md']);
  const env = { ...process.env, HOME: f.root, XDG_CONFIG_HOME: path.join(f.root, 'config'), XDG_DATA_HOME: path.join(f.root, 'data'), XDG_STATE_HOME: path.join(f.root, 'state'), XDG_CACHE_HOME: path.join(f.root, 'cache'), OPENCODE_CONFIG_CONTENT: '{}', GALLEY_ISOLATED_RUNTIME: '1', GALLEY_FIXTURE_DIRECTORY: f.enrollment.directory };
  // No actual provider credentials or inherited service/inline configuration.
  for (const key of Object.keys(env)) if (/API_KEY|TOKEN|^OPENCODE_/.test(key)) delete env[key];
  env.OPENCODE_CONFIG_CONTENT = '{}';
  const result = await promisify(execFile)(process.execPath, [path.resolve('test/native-runtime/fixtures/pack-runtime.mjs')], { cwd: f.enrollment.directory, env, timeout: 40000, maxBuffer: 1024 * 1024 });
  assert(result.stdout.includes('"discovery":true'));
  await fs.appendFile(path.join(f.options.skillsRoot, 'edit.md'), 'Synthetic long editing source line.\n'.repeat(2000) + 'SYNTHETIC FULL EDIT END\n');
  const scoped = await preparePackWriter(f.options, { ...f.enrollment, learnMemory: true });
  const scopedFiles = generatePackArtifacts(scoped);
  await fs.mkdir(path.join(config, 'plugins', 'writer'), { recursive: true });
  await fs.writeFile(path.join(config, 'agents', 'writer.md'), scopedFiles['writer.md']);
  await fs.writeFile(path.join(config, 'opencode.json'), scopedFiles['opencode.json']);
  await fs.writeFile(path.join(config, 'plugins', 'writer', 'index.mjs'), scopedFiles['writer-plugin.mjs']);
  const enrolledFile = path.join(f.root, 'enrolled-test.json');
  const otherDraft = await f.put(f.root, 'other-piece/draft.md');
  await fs.writeFile(enrolledFile, JSON.stringify({ permissions: scoped.sessionPermissions, draft: scoped.enrollment.artifacts.draft, source: scoped.enrollment.sources[0], memory: scoped.pack.memoryPath, otherDraft }));
  const scopedResult = await promisify(execFile)(process.execPath, [path.resolve('test/native-runtime/fixtures/pack-runtime.mjs')], { cwd: f.enrollment.directory, env: { ...env, GALLEY_ENROLLMENT: enrolledFile }, timeout: 40000, maxBuffer: 1024 * 1024 });
  assert(scopedResult.stdout.includes('"discovery":true'));
  const schemaResult = await promisify(execFile)(process.execPath, [path.resolve('test/native-runtime/fixtures/pack-runtime.mjs')], { cwd: f.enrollment.directory, env: { ...env, GALLEY_ENROLLMENT: enrolledFile, GALLEY_SCHEMA_PROOF: '1' }, timeout: 40000, maxBuffer: 1024 * 1024 });
  assert(schemaResult.stdout.includes('"outgoingSchemaProof":true'));
  t.diagnostic(schemaResult.stdout.split('\n').find(line => line.includes('"outgoingSchemaProof":true')));
  // Production new-piece generator, not a hand-built SDK-only plugin layout.
  await fs.rm(path.join(config, 'plugins', 'writer'), { recursive: true });
  const state = path.join(f.root, 'piece-state'); await fs.mkdir(state, { mode: 0o700 });
  await installPieceDomain({ directory: f.enrollment.directory, state, sessionFile: path.join(state, 'session.json') }, scoped);
  const discovery = await promisify(execFile)(process.execPath, [path.resolve('test/native-runtime/fixtures/pack-runtime.mjs')], { cwd: f.enrollment.directory, env: { ...env, GALLEY_ENROLLMENT: enrolledFile, GALLEY_PIECE_DISCOVERY: '1' }, timeout: 40000, maxBuffer: 1024 * 1024 });
  assert(discovery.stdout.includes('"coldPieceLayoutDiscovery":true'));
});
