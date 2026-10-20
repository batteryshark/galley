import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyPrepared } from './writer.mjs';
import { noLinks } from './files.mjs';

// Generate inert artifacts only. Neither writes .opencode nor merges configuration.
export async function generateNative(prepared, output, bindingFile) {
  await verifyPrepared(prepared); await noLinks(output);
  if (!path.isAbsolute(bindingFile) || path.normalize(bindingFile) !== bindingFile) throw new Error('Explicit private binding path required');
  const { system, ...fields } = prepared.profile;
  const entry = `import { nativePlugin } from ${JSON.stringify(pathToFileURL(new URL('./native-plugin.mjs', import.meta.url).pathname).href)};\nexport default nativePlugin(${JSON.stringify(bindingFile)});\n`;
  const files = { [`${prepared.agent}.md`]: `---\n${JSON.stringify(fields)}\n---\n${system}`, 'galley-native.ts': entry };
  for (const [name, bytes] of Object.entries(files)) {
    const h = await fs.open(path.join(output, name), 'wx', 0o600);
    try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
  }
  const d = await fs.open(output, 'r'); try { await d.sync(); } finally { await d.close(); }
  return Object.keys(files);
}
