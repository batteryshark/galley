import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
// HISTORICAL FAKE-HOST TEST FIXTURE ONLY. No operational enrollment path.
import { privateDirectory, privateLock, readPrivate, writePrivate } from '../../src/private.mjs';
import { discoverPort, localJSON, verifyHealth, verifyClient, identity, installedServerId, credentialDirectory, settingsFile } from './retired-desktop.mjs';

export function parseLocalLink(link, port) {
  if (typeof link !== 'string' || link.length > 16384) throw new Error('Invalid connection link');
  const u = new URL(link.trim());
  if (u.protocol !== 'openchamber:' || u.hostname !== 'connect' || u.pathname || u.hash || u.username || u.password || u.port || u.searchParams.get('v') !== '2' || [...u.searchParams.keys()].sort().join(',') !== 'p,v') throw new Error('Invalid connection link');
  const encoded = u.searchParams.get('p');
  if (!/^[A-Za-z0-9_-]+$/.test(encoded || '')) throw new Error('Invalid payload');
  const p = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const expiry = Date.parse(p.expiresAt);
  if (p.v !== 2 || !/^pair_[\w-]{1,100}$/.test(p.pairingId) || !/^[\w-]{43}$/.test(p.secret) || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 600000 || !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(p.fingerprint || '')) throw new Error('Invalid or expired pairing');
  // A single literal loopback route is the only accepted This computer only link.
  if (!Array.isArray(p.candidates) || p.candidates.length !== 1 || p.candidates[0].type !== 'lan' || p.candidates[0].url !== `http://127.0.0.1:${port}`) throw new Error('Select This computer only; no alternate candidates');
  return p;
}
export async function enrollGalley(link, { directory = credentialDirectory, settings = settingsFile, serverId = installedServerId, writerDirectory } = {}) {
  if (!directory.includes('/.test-galley-')) throw new Error('Retired: synthetic test fixture only');
  await privateDirectory(directory, writerDirectory);
  return privateLock(directory, async () => {
    try { await readPrivate(path.join(directory, 'credential.json')); throw new Error('Already paired'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const ledgerFile = path.join(directory, 'attempts.json');
    let ledger;
    try { ledger = await readPrivate(ledgerFile); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      ledger = { dedupeKey: `galley:${randomUUID()}`, attempts: [] };
      await writePrivate(ledgerFile, ledger, { exclusive: true });
    }
    if (!/^galley:[\w-]+$/.test(ledger.dedupeKey) || !Array.isArray(ledger.attempts) || ledger.attempts.length >= 64 || ledger.attempts.some(x => x.state !== 'complete')) throw new Error('Pairing halted; operator review required');
    const port = await discoverPort(settings), p = parseLocalLink(link, port);
    const digest = createHash('sha256').update(JSON.stringify([p.pairingId, p.secret])).digest('hex');
    if (ledger.attempts.some(x => x.hash === digest)) throw new Error('Pairing link already attempted');
    await verifyHealth(port, serverId);
    const attempt = { hash: digest, state: 'uncertain' }; ledger.attempts.push(attempt);
    await writePrivate(ledgerFile, ledger); // Durable replay fence BEFORE single redemption.
    const result = await localJSON(port, 'POST', '/api/client-auth/pairing/redeem', { max: 65536, body: {
      pairingId: p.pairingId, secret: p.secret, clientKind: 'desktop', clientLabel: 'Galley', deviceName: 'Galley', devicePlatform: process.platform, appVersion: 'galley-1', dedupeKey: ledger.dedupeKey,
    } });
    if (result.ok !== true || result.server?.url !== `http://127.0.0.1:${port}` || result.server?.fingerprint !== p.fingerprint || !/^[\w-]{20,512}$/.test(result.clientToken || '') || typeof result.client?.id !== 'string') throw new Error('Uncertain pairing response');
    const credential = { serverId, port, clientId: result.client.id, pairingId: p.pairingId, token: result.clientToken };
    verifyClient(result.client, credential);
    await writePrivate(path.join(directory, 'credential.json'), credential, { exclusive: true });
    await verifyHealth(port, serverId);
    const own = await localJSON(port, 'GET', '/api/client-auth/clients', { token: credential.token, max: 65536 });
    if (!Array.isArray(own.clients) || own.clients.length !== 1) throw new Error('Uncertain own-client identity');
    verifyClient(own.clients[0], credential);
    attempt.state = 'complete'; await writePrivate(ledgerFile, ledger);
    return { status: 'paired-not-authorized-for-deployment', upstreamIdentity: identity(serverId, credential.clientId) };
  });
}

export async function pairingStatus(directory = credentialDirectory) {
  const result = { credential: 'absent', attempts: 0, halted: false };
  try { const ledger = await readPrivate(path.join(directory, 'attempts.json')); result.attempts = ledger.attempts.length; result.halted = ledger.attempts.some(a => a.state !== 'complete'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { await readPrivate(path.join(directory, 'credential.json')); result.credential = 'present-not-live-verified'; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return result;
}

// Raw TTY only: no stdin pipes, echo, readline history, args or environment secrets.
export async function hiddenLink(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('Interactive terminal required');
  output.write('Paste This computer only Connection link (hidden), then Enter: ');
  return new Promise((resolve, reject) => {
    let value = ''; const wasRaw = input.isRaw;
    const timer = setTimeout(() => finish(new Error('Input expired')), 120000);
    function finish(error) {
      clearTimeout(timer); input.off('data', data);
      for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, cancel);
      input.setRawMode(!!wasRaw); input.pause(); output.write('\n');
      if (error) reject(error); else resolve(value);
      value = '';
    }
    function cancel() { finish(new Error('Cancelled')); }
    function data(chunk) {
      for (const ch of chunk.toString()) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || ch === '\u0004') return finish(new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ' && ch <= '~') value += ch;
        else return finish(new Error('Invalid input'));
        if (value.length > 16384) return finish(new Error('Input limit'));
      }
    }
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, cancel);
    input.setRawMode(true); input.on('data', data); input.resume();
  });
}
