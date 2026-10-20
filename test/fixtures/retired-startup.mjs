import path from 'node:path';
import { readPrivate, writePrivate, privateDirectory, privateLock } from '../../src/private.mjs';
import { credentialDirectory, desktopTransport, identity } from './retired-desktop.mjs';
import { verifyPrepared } from '../../src/writer.mjs';
import { startWriter } from './retired-writer.mjs';

// A crash/lost create response fences this prepared ID permanently until manual
// reconciliation. This is local crash safety, not a provider-traffic audit.
export async function startPreparedWriter(prepared, model, { credentials = credentialDirectory, settings, transport } = {}) {
  await verifyPrepared(prepared);
  await privateDirectory(credentials, prepared.directory);
  return privateLock(credentials, async () => {
    const journal = path.join(credentials, `startup-${prepared.agent}.json`);
    await writePrivate(journal, { state: 'uncertain', agent: prepared.agent, directory: prepared.directory, digest: prepared.digest }, { exclusive: true });
    if (!transport) {
      const c = await readPrivate(path.join(credentials, 'credential.json'));
      transport = desktopTransport({ credentials, settings, binding: { agent: prepared.agent, sessionDirectory: prepared.directory, upstreamIdentity: identity(c.serverId, c.clientId) } });
    }
    const session = await startWriter(prepared, transport, model);
    await writePrivate(journal, { state: 'created-not-edit-verified', agent: prepared.agent, directory: prepared.directory, digest: prepared.digest, sessionId: session.id });
    return session;
  });
}
