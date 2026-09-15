import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createOrchestratorServer } from '../src/server.js';
import { Store } from '../src/store.js';

test('HTTP API authenticates, preserves idempotency, and exposes metrics', async (t) => {
  const store = new Store();
  let now = 20_000;
  const server = createOrchestratorServer({ store, token: 'test-token', now: () => now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/v1/jobs`)).status, 401);
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

  const workerResponse = await fetch(`${base}/v1/workers/register`, {
    method: 'POST', headers, body: JSON.stringify({
      id: 'nas', providerClass: 'nas-cpu', modelVersion: 'demo-v1',
      capabilities: { taskTypes: ['person-detection'] }, estimatedLatencyMs: 100
    })
  });
  assert.equal(workerResponse.status, 201);

  const jobRequest = {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': 'camera-01:event-1:person' },
    body: JSON.stringify({ taskType: 'person-detection', privacyLevel: 'local-only' })
  };
  const created = await fetch(`${base}/v1/jobs`, jobRequest);
  assert.equal(created.status, 201);
  const job = await created.json();
  const duplicate = await fetch(`${base}/v1/jobs`, jobRequest);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).id, job.id);

  now = 20_100;
  const claim = await fetch(`${base}/v1/workers/nas/claim`, { method: 'POST', headers, body: '{}' });
  assert.equal(claim.status, 200);
  const lease = await claim.json();
  now = 20_150;
  const renewed = await fetch(`${base}/v1/jobs/${job.id}/lease/renew`, {
    method: 'POST', headers, body: JSON.stringify({ workerId: 'nas', leaseToken: lease.leaseToken })
  });
  assert.equal(renewed.status, 200);
  now = 20_200;
  assert.equal((await fetch(`${base}/v1/jobs/${job.id}/complete`, {
    method: 'POST', headers, body: JSON.stringify({
      workerId: 'nas', leaseToken: lease.leaseToken, result: { synthetic: true }, inferenceMs: 75
    })
  })).status, 200);
  const metrics = await (await fetch(`${base}/metrics`, { headers })).text();
  assert.match(metrics, /homecam_ai_jobs\{state="succeeded"\} 1/);
  assert.match(metrics, /homecam_ai_inference_milliseconds_avg 75/);
});

test('HTTP API rejects external identity jobs before queueing', async (t) => {
  const store = new Store();
  const server = createOrchestratorServer({ store, token: 'test-token' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections(); server.close(); store.close();
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/jobs`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ taskType: 'face-identity', privacyLevel: 'external-allowed', preferredProvider: 'external' })
  });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /requires one of: local-only/);
  assert.equal(store.listJobs().length, 0);
});
