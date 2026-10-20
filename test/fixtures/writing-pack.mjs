import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { roles } from '../../src/writing-pack.mjs';

export async function fixture(t) {
  const tmp = path.join(await fs.realpath(os.tmpdir()), 'opencode'); await fs.mkdir(tmp, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmp, 'galley-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, 'skills'), packDirectory = path.join(root, 'pack'), directory = path.join(root, 'piece');
  for (const dir of [skillsRoot, packDirectory, directory]) await fs.mkdir(dir);
  const put = async (base, ref, text = `Synthetic ${ref}\n`) => { const file = path.join(base, ref); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return file; };
  const manifest = { schema_version: 1, id: 'synthetic-writer', visibility: 'private', version: '1.0.0', entry: 'SYSTEM.md',
    documents: { workflow: 'workflow.md', 'long-form': 'long.md', 'short-form': 'short.md', editor: 'editor.md', 'adapter-contract': 'README.md' },
    voice_memory: { path: 'voice/learned.md', contract: 'voice/README.md', write_policy: 'explicit-scoped-only' },
    sources: ['start', 'edit', 'resume'].map(load_when => ({ id: load_when, path: `${load_when}.md`, load_when, ...(load_when === 'edit' ? { metadata_version: '3.1.0' } : {}) })),
    phases: ['design-piece', 'design-visuals', 'draft', 'edit'], artifact_roles: roles, candidate_check: 'scripts/check.py' };
  for (const ref of [manifest.entry, ...Object.values(manifest.documents), 'voice/learned.md', 'voice/README.md', manifest.candidate_check, 'scripts/resolve_pack.py']) await put(packDirectory, ref);
  for (const s of manifest.sources) await put(skillsRoot, s.path, s.metadata_version ? '---\nmetadata:\n  version: "3.1.0"\n---\nSynthetic edit guidance\n' : `Synthetic ${s.id} source\n`);
  const save = () => put(packDirectory, 'pack.json', JSON.stringify(manifest)); await save();
  const artifacts = {}; for (const role of roles) artifacts[role] = await put(directory, `${role}.md`);
  const source = await put(root, 'supplied.md'); const assets = path.join(directory, 'figures'); await fs.mkdir(assets);
  return { root, options: { packDirectory, skillsRoot, expectedVersion: '1.0.0' }, manifest, save, put,
    enrollment: { directory, artifacts, sources: [source], assetDirectories: [assets], learnMemory: false, phase: 'design-piece', format: 'long-form', resume: false } };
}
