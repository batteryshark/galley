import path from 'node:path';
import { privateDirectory, writePrivate } from './private.mjs';
import { verifyPrepared } from './writer.mjs';

export async function startPreparedWriter(prepared, model, { directory, connector, parentID } = {}) {
  await verifyPrepared(prepared);
  if (!connector || !directory || !model || typeof model.providerID !== 'string' || !model.providerID || typeof model.id !== 'string' || !model.id || Object.keys(model).some(k => !['id', 'providerID', 'variant'].includes(k)) || (model.variant !== undefined && (typeof model.variant !== 'string' || !model.variant))) throw new Error('Explicit native connector/model required');
  await privateDirectory(directory, prepared.directory);
  const journal = path.join(directory, `startup-${prepared.agent}.json`);
  // Exclusive, fsynced BEFORE claim/create; even preflight failures remain fenced.
  await writePrivate(journal, { state: 'uncertain', agent: prepared.agent, digest: prepared.digest }, { exclusive: true });
  const s = await connector.startup(prepared, model, parentID);
  await writePrivate(journal, { state: 'created-not-edit-verified', agent: prepared.agent, digest: prepared.digest, sessionId: s.id });
  return s;
}
