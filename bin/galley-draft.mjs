#!/usr/bin/env node
import { readPrivate } from '../src/private.mjs';
import { enrollAdditionalDraft } from '../src/additional-draft.mjs';

try {
  const [command, file, ...extra] = process.argv.slice(2);
  if (command !== 'enroll' || !file || extra.length) throw new Error('Usage: node bin/galley-draft.mjs enroll <private-config.json>');
  console.log(JSON.stringify(await enrollAdditionalDraft(await readPrivate(file))));
} catch (e) {
  console.error(`Additional draft enrollment refused: ${e.message}. Retain partial files; never replace enrollment/history.`);
  process.exitCode = 1;
}
