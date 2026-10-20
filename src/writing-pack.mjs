// Generic private manifest contract. Never exports pack bodies or host defaults.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import * as fs from 'node:fs/promises';
import { boundedRead, noLinks, inside } from './files.mjs';

export const phases = ['design-piece', 'design-visuals', 'draft', 'edit'];
export const roles = ['brief', 'beats', 'visual-plan', 'draft', 'continuation'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export class PackError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new PackError(code, message); };
export function canonical(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file || file === path.parse(file).root || /[\x00-\x1f*?\[\]{}!\\]/.test(file)) fail('path', 'Explicit canonical path without permission metacharacters required');
  return file;
}
export async function textFile(file) {
  canonical(file);
  try {
    const bytes = await boundedRead(file, 256 * 1024);
    if ((await fs.lstat(file)).nlink !== 1) fail('path', 'Hardlink alias denied');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  catch (e) { fail(e.code === 'ENOENT' ? 'missing' : 'io', `Required bounded regular no-symlink UTF-8 file unavailable (${e.code || 'invalid'})`); }
}
export async function localFile(root, ref) {
  if (typeof ref !== 'string' || !ref || path.isAbsolute(ref) || ref.split('/').some(p => !p || p === '.' || p === '..')) fail('path', 'Invalid relative file reference');
  const file = canonical(path.join(root, ref));
  if (!inside(root, file) || file === root) fail('path', 'Reference escapes root');
  await textFile(file); return file;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export async function resolveWritingPack({ packDirectory, skillsRoot, expectedVersion } = {}) {
  canonical(packDirectory); canonical(skillsRoot);
  for (const root of [packDirectory, skillsRoot]) {
    try { await noLinks(root); if (!(await fs.stat(root)).isDirectory()) fail('path', 'Pack/skills root must be a directory'); }
    catch (e) { fail(e.code === 'ENOENT' ? 'missing' : 'path', 'Required canonical no-symlink pack/skills root unavailable'); }
  }
  if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) fail('version', 'Explicit expected semantic version required');
  const manifestFile = await localFile(packDirectory, 'pack.json');
  let manifest;
  try { manifest = JSON.parse(await textFile(manifestFile)); } catch { fail('manifest', 'Invalid manifest JSON'); }
  if (manifest?.schema_version !== 1) fail('schema', 'Supported schema_version is 1');
  if (manifest.version !== expectedVersion) fail('version', 'Pack version differs; explicit review required');
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(manifest.id) || manifest.visibility !== 'private' || !same(manifest.phases, phases) || !same(manifest.artifact_roles, roles)) fail('manifest', 'Invalid private writing contract');
  const documents = manifest.documents;
  const docKeys = ['adapter-contract', 'editor', 'long-form', 'short-form', 'workflow'];
  if (!documents || !same(Object.keys(documents).sort(), docKeys)) fail('manifest', 'Required documents differ');
  const tracked = { manifest: manifestFile };
  const track = async (label, ref, root = packDirectory) => (tracked[label] = await localFile(root, ref));
  const entry = await track('entry', manifest.entry);
  const docs = {};
  for (const [key, ref] of Object.entries(documents)) docs[key] = await track(`document:${key}`, ref);
  const memory = manifest.voice_memory;
  if (memory?.path !== 'voice/learned.md' || memory.contract !== 'voice/README.md' || memory.write_policy !== 'explicit-scoped-only') fail('manifest', 'Expected exact single-file memory contract');
  const memoryPath = await localFile(packDirectory, memory.path);
  const memoryContract = await track('memory-contract', memory.contract);
  if (!Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.length > 32) fail('manifest', 'Nonempty bounded sources list required');
  const sources = [], ids = new Set();
  for (const s of manifest.sources) {
    if (!s || !/^[a-z][a-z0-9-]{0,79}$/.test(s.id) || ids.has(s.id) || !['start', 'edit', 'resume'].includes(s.load_when)) fail('manifest', 'Duplicate/invalid source or phase');
    ids.add(s.id);
    const file = await track(`source:${s.id}`, s.path, skillsRoot);
    if (s.metadata_version !== undefined) {
      const body = await textFile(file), front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
      let metadata; try { metadata = front && parse(front[1])?.metadata; } catch { fail('source-version', 'Malformed source metadata'); }
      if (typeof s.metadata_version !== 'string' || metadata?.version !== s.metadata_version) fail('source-version', 'Nested source metadata.version differs');
    }
    sources.push({ id: s.id, path: file, load_when: s.load_when });
  }
  const candidateCheck = await track('candidate-check', manifest.candidate_check);
  // Schema 1 reference helper is instruction-bearing but is never executed.
  await track('resolver', 'scripts/resolve_pack.py');
  if (Object.values(tracked).includes(memoryPath)) fail('path', 'Mutable memory aliases immutable guidance');
  const hash = createHash('sha256');
  for (const [label, file] of Object.entries(tracked).sort(([a], [b]) => a.localeCompare(b))) hash.update(label).update('\0').update(await textFile(file)).update('\0');
  return { options: { packDirectory, skillsRoot, expectedVersion }, id: manifest.id, version: manifest.version, entry, documents: docs, sources, memoryPath, memoryContract, candidateCheck,
    instructionFingerprint: hash.digest('hex'), files: [...new Set([...Object.values(tracked), memoryPath])] };
}

export function phaseFiles(pack, { phase = 'design-piece', format = 'long-form', resume = false } = {}) {
  if (!phases.includes(phase) || !['long-form', 'short-form'].includes(format)) fail('phase', 'Unknown phase or format');
  return [...new Set([pack.entry, pack.documents['adapter-contract'], pack.documents.workflow, pack.documents[format], pack.memoryContract, pack.memoryPath,
    ...(phase === 'edit' ? [pack.documents.editor] : []), ...pack.sources.filter(s => s.load_when === 'start' || (phase === 'edit' && s.load_when === 'edit') || (resume && s.load_when === 'resume')).map(s => s.path)])];
}
