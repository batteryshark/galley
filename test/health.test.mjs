import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';

test('Fleet health is exact inert GET only; HTTPS Host/Origin and data auth remain strict', async t => {
  const root = await fs.mkdtemp(path.resolve('.test-galley-health-'));
  const draft = path.join(root, 'draft.md');
  await fs.writeFile(draft, '# Synthetic health fixture\n');
  const store = await openStore(path.join(root, 'state'), { draft, sessionDirectory: root, sessionId: 'ses_fake', upstreamIdentity: 'fake-only', assetRoots: [] });
  const token = await store.issue();
  const publicOrigin = 'https://review.example.invalid:9443';
  const app = await startServer({ store, publicOrigin });
  t.after(async () => { await app.close(); await store.close(); await fs.rm(root, { recursive: true }); });
  async function request(url, host = '127.0.0.1:4177', method = 'GET', headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: app.server.address().port, path: url, method, headers: { Host: host, ...headers } }, res => {
        const chunks = [];
        res.on('data', b => chunks.push(b));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
      });
      req.on('error', reject); req.end();
    });
  }
  const health = await request('/galley/health');
  assert.equal(health.status, 200); assert.deepEqual(JSON.parse(health.body), { ok: true });
  assert.equal(health.headers['cache-control'], 'no-store');
  const publicHost = new URL(publicOrigin).host;
  assert.equal((await request('/galley/health', publicHost)).status, 200);
  for (const host of ['localhost:4177', '127.0.0.1', '127.0.0.1:4178', 'evil.invalid']) assert.equal((await request('/galley/health', host)).status, 403);
  for (const url of ['/galley/', '/galley/api/document', '/galley/image/' + 'a'.repeat(32), '/galley/health?x=1', '/galley/health/', '/galley/%68ealth', '/health']) assert.equal((await request(url)).status, 403);
  for (const method of ['POST', 'HEAD', 'OPTIONS']) assert.equal((await request('/galley/health', undefined, method)).status, 403);
  for (const url of ['/galley/api/document', '/galley/image/' + 'a'.repeat(32)]) {
    assert.equal((await request(url, publicHost)).status, 401);
    assert.equal((await request(url, '127.0.0.1:4177', 'GET', { Authorization: `Bearer ${token}` })).status, 403);
    assert.equal((await request(url, publicHost, 'GET', { Authorization: `Bearer ${token}`, Origin: 'https://evil.invalid' })).status, 403);
  }
  assert.equal((await request('/galley/api/document', publicHost, 'GET', { Authorization: `Bearer ${token}`, Origin: publicOrigin })).status, 200);
  assert.equal((await request('/galley/api/comments', publicHost, 'POST', { Authorization: `Bearer ${token}`, Origin: 'https://evil.invalid' })).status, 403);
});
