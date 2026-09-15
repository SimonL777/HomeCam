import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';

function register(store, overrides = {}, now = 10_000, offlineAfterMs = 5_000) {
  return store.registerWorker({
    id: 'nas-1',
    name: 'NAS CPU',
    providerClass: 'nas-cpu',
    modelVersion: 'synthetic-cpu-v1',
    capabilities: { taskTypes: ['person-detection', 'event-classification'] },
    maxConcurrency: 1,
    availableMemoryMb: 4096,
    estimatedLatencyMs: 100,
    costPerJobMicrousd: 0,
    ...overrides
  }, now, offlineAfterMs);
}

test('durable queue leases and completes a job with observable metrics', (t) => {
  const store = new Store({ retryBaseMs: 10 });
  t.after(() => store.close());
  register(store);
  const { job, created } = store.enqueue({
    cameraId: 'camera-01', taskType: 'person-detection', privacyLevel: 'local-only', payload: { frameRef: 'synthetic://frame-1' }
  }, { now: 10_100, idempotencyKey: 'event-1-person' });
  assert.equal(created, true);
  const duplicate = store.enqueue({
    cameraId: 'camera-01', taskType: 'person-detection', privacyLevel: 'local-only', payload: { frameRef: 'synthetic://frame-1' }
  }, { now: 10_200, idempotencyKey: 'event-1-person' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.id, job.id);

  const lease = store.claim('nas-1', { now: 10_300, leaseMs: 1_000, offlineAfterMs: 5_000 });
  assert.equal(lease.job.state, 'leased');
  assert.equal(lease.job.attempts, 1);
  const completed = store.complete(job.id, {
    workerId: 'nas-1', leaseToken: lease.leaseToken,
    result: { synthetic: true, detections: 1 }, inferenceMs: 87, actualCostMicrousd: 0
  }, 10_400);
  assert.equal(completed.state, 'succeeded');
  assert.deepEqual(completed.result, { synthetic: true, detections: 1 });
  assert.deepEqual(store.metrics(10_400, 5_000), {
    jobs: { queued: 0, leased: 0, succeeded: 1, deadLetter: 0 },
    workers: { online: 1, offline: 0 },
    attempts: { total: 1, queueMsAvg: 200, inferenceMsAvg: 87, fallbackTotal: 0, retryTotal: 0, costMicrousdTotal: 0 }
  });
});

test('expired leases are recovered and can fall back when the GPU disappears', (t) => {
  const store = new Store({ retryBaseMs: 10 });
  t.after(() => store.close());
  register(store, {
    id: 'gpu-1', name: '4070S', providerClass: 'home-gpu',
    capabilities: { taskTypes: ['scene-description'] }, estimatedLatencyMs: 50
  });
  register(store, {
    id: 'external-1', name: 'External', providerClass: 'external',
    capabilities: { taskTypes: ['scene-description'] }, estimatedLatencyMs: 80, costPerJobMicrousd: 1_000
  });
  const { job } = store.enqueue({
    taskType: 'scene-description', privacyLevel: 'external-allowed', preferredProvider: 'home-gpu',
    budgetMicrousd: 2_000, maxAttempts: 3
  }, { now: 10_100 });
  const first = store.claim('gpu-1', { now: 10_200, leaseMs: 100, offlineAfterMs: 5_000 });
  assert.equal(first.job.providerClass, 'home-gpu');
  assert.deepEqual(store.recoverExpiredLeases(10_301), { requeued: 1, deadLettered: 0 });
  assert.equal(store.getJob(job.id).state, 'queued');

  store.heartbeat('external-1', {}, 10_320, 5_000);
  const fallback = store.claim('external-1', { now: 10_400, leaseMs: 100, offlineAfterMs: 100 });
  assert.equal(fallback.job.providerClass, 'external');
  assert.equal(fallback.job.fallbackCount, 1);
  assert.equal(fallback.job.attempts, 2);
  assert.equal(store.metrics(10_400, 100).attempts.retryTotal, 1);
});

test('worker failure retries with backoff and stale lease tokens are rejected', (t) => {
  const store = new Store({ retryBaseMs: 100 });
  t.after(() => store.close());
  register(store);
  const { job } = store.enqueue({ taskType: 'person-detection', privacyLevel: 'local-only', maxAttempts: 2 }, { now: 10_100 });
  const lease = store.claim('nas-1', { now: 10_200, leaseMs: 1_000, offlineAfterMs: 5_000 });
  const queued = store.fail(job.id, {
    workerId: 'nas-1', leaseToken: lease.leaseToken, error: 'temporary', retryable: true, inferenceMs: 10
  }, 10_250);
  assert.equal(queued.state, 'queued');
  assert.equal(store.claim('nas-1', { now: 10_300, leaseMs: 1_000, offlineAfterMs: 5_000 }), null);
  const retry = store.claim('nas-1', { now: 10_350, leaseMs: 1_000, offlineAfterMs: 5_000 });
  assert.equal(retry.job.attempts, 2);
  assert.throws(() => store.complete(job.id, {
    workerId: 'nas-1', leaseToken: lease.leaseToken, result: {}
  }, 10_400), /invalid lease owner or token/);
  assert.equal(store.fail(job.id, {
    workerId: 'nas-1', leaseToken: retry.leaseToken, error: 'permanent', retryable: true
  }, 10_450).state, 'dead-letter');
});

test('idempotency keys reject a different request body', (t) => {
  const store = new Store();
  t.after(() => store.close());
  store.enqueue({ taskType: 'event-classification', privacyLevel: 'metadata-only', payload: { count: 1 } }, {
    now: 10_000, idempotencyKey: 'same-key'
  });
  assert.throws(() => store.enqueue({
    taskType: 'event-classification', privacyLevel: 'metadata-only', payload: { count: 2 }
  }, { now: 10_001, idempotencyKey: 'same-key' }), /different request/);
});

test('jobs survive a control-plane restart on disk', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'homecam-ai-store-'));
  const path = join(directory, 'orchestrator.db');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new Store({ path });
  const { job } = first.enqueue({
    taskType: 'event-classification', privacyLevel: 'metadata-only', payload: { personCount: 1 }
  }, { now: 10_000, idempotencyKey: 'durable-event' });
  first.close();
  const reopened = new Store({ path });
  t.after(() => reopened.close());
  assert.equal(reopened.getJob(job.id).state, 'queued');
  assert.equal(reopened.enqueue({
    taskType: 'event-classification', privacyLevel: 'metadata-only', payload: { personCount: 1 }
  }, { now: 10_100, idempotencyKey: 'durable-event' }).created, false);
});

test('a valid worker can renew a lease while stale tokens cannot', (t) => {
  const store = new Store({ retryBaseMs: 10 });
  t.after(() => store.close());
  register(store);
  const { job } = store.enqueue({ taskType: 'person-detection', privacyLevel: 'local-only' }, { now: 10_100 });
  const lease = store.claim('nas-1', { now: 10_200, leaseMs: 100, offlineAfterMs: 5_000 });
  const renewal = store.renewLease(job.id, { workerId: 'nas-1', leaseToken: lease.leaseToken }, {
    now: 10_250, leaseMs: 500
  });
  assert.equal(renewal.leaseExpiresAt, new Date(10_750).toISOString());
  assert.deepEqual(store.recoverExpiredLeases(10_400), { requeued: 0, deadLettered: 0 });
  assert.equal(store.getJob(job.id).state, 'leased');
  assert.throws(() => store.renewLease(job.id, { workerId: 'nas-1', leaseToken: 'stale' }, {
    now: 10_450, leaseMs: 500
  }), /invalid lease owner or token/);
});

test('an expired lease cannot renew or commit before the sweeper runs', (t) => {
  const store = new Store({ retryBaseMs: 10 });
  t.after(() => store.close());
  register(store);
  const { job } = store.enqueue({ taskType: 'person-detection', privacyLevel: 'local-only' }, { now: 10_100 });
  const lease = store.claim('nas-1', { now: 10_200, leaseMs: 100, offlineAfterMs: 5_000 });
  assert.throws(() => store.renewLease(job.id, {
    workerId: 'nas-1', leaseToken: lease.leaseToken
  }, { now: 10_301, leaseMs: 100 }), /lease has expired/);
  assert.throws(() => store.complete(job.id, {
    workerId: 'nas-1', leaseToken: lease.leaseToken, result: {}
  }, 10_301), /lease has expired/);
  assert.deepEqual(store.recoverExpiredLeases(10_301), { requeued: 1, deadLettered: 0 });
});
