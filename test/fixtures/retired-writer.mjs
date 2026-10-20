// Historical HTTP startup seam, guarded synthetic fixture only; no operational imports.
import { isDeepStrictEqual } from 'node:util';
import { verifyPrepared } from '../../src/writer.mjs';
export async function startWriter(prepared, transport, model) {
  if (!prepared.directory.includes('/.test-galley-')) throw new Error('Retired synthetic fixture only');
  await verifyPrepared(prepared);
  if (!model || typeof model.id !== 'string' || !model.id || typeof model.providerID !== 'string' || !model.providerID || (model.variant !== undefined && (typeof model.variant !== 'string' || !model.variant)) || Object.keys(model).some(k => !['id', 'providerID', 'variant'].includes(k))) throw new Error('Explicit approved model required');
  const query = new URLSearchParams({ 'location[directory]': prepared.directory });
  const resolved = await transport.request('GET', `/api/agent/${prepared.agent}?${query}`);
  const a = resolved.data;
  if (resolved.location?.directory !== prepared.directory || a?.id !== prepared.agent || a.mode !== 'primary' || a.system !== prepared.profile.system || !Array.isArray(a.permissions) || !isDeepStrictEqual(a.permissions.slice(-prepared.profile.permissions.length), prepared.profile.permissions)) throw new Error('Runtime writer profile mismatch');
  const { data: created } = await transport.request('POST', '/api/session', { location: { directory: prepared.directory }, agent: prepared.agent, model, permissions: prepared.profile.permissions });
  if (!/^ses_[\w-]+$/.test(created?.id || '')) throw new Error('Uncertain writer creation');
  const { data: s } = await transport.request('GET', `/api/session/${created.id}`);
  if (s?.id !== created.id || s.location?.directory !== prepared.directory || s.agent !== prepared.agent || !isDeepStrictEqual(s.model, model) || !isDeepStrictEqual(s.permissions, prepared.profile.permissions)) throw new Error('Created writer identity mismatch; do not retry creation');
  return s;
}
