import assert from 'node:assert/strict';
import test from 'node:test';
import { selectWorker, validateJobInput, validateWorkerInput } from '../src/routing.js';

function worker(overrides = {}) {
  return {
    id: 'worker-1',
    providerClass: 'nas-cpu',
    status: 'online',
    capabilities: { taskTypes: ['person-detection', 'event-classification'] },
    currentLoad: 0,
    maxConcurrency: 1,
    availableMemoryMb: 2048,
    estimatedLatencyMs: 500,
    costPerJobMicrousd: 0,
    ...overrides
  };
}

test('identity and raw person detection are local-only invariants', () => {
  assert.throws(() => validateJobInput({
    taskType: 'face-identity', privacyLevel: 'external-allowed', preferredProvider: 'external'
  }), /requires one of: local-only/);
  assert.throws(() => validateWorkerInput({
    id: 'cloud', providerClass: 'external', capabilities: { taskTypes: ['face-identity'] }
  }), /not permitted/);

  const job = validateJobInput({ taskType: 'face-identity', privacyLevel: 'local-only' });
  const decision = selectWorker(job, [
    worker({ id: 'cloud', providerClass: 'external', capabilities: { taskTypes: ['face-identity'] } }),
    worker({ id: 'gpu', providerClass: 'home-gpu', capabilities: { taskTypes: ['face-identity'] } })
  ]);
  assert.equal(decision.worker.id, 'gpu');
});

test('routing falls back to an eligible provider by availability, deadline, and budget', () => {
  const now = Date.now();
  const job = validateJobInput({
    taskType: 'scene-description',
    privacyLevel: 'external-allowed',
    preferredProvider: 'home-gpu',
    deadlineAt: new Date(now + 1_000).toISOString(),
    budgetMicrousd: 2_000
  }, now);
  const decision = selectWorker(job, [
    worker({
      id: 'gpu', providerClass: 'home-gpu', capabilities: { taskTypes: ['scene-description'] },
      estimatedLatencyMs: 2_000
    }),
    worker({
      id: 'external-expensive', providerClass: 'external', capabilities: { taskTypes: ['scene-description'] },
      estimatedLatencyMs: 200, costPerJobMicrousd: 3_000
    }),
    worker({
      id: 'external-budget', providerClass: 'external', capabilities: { taskTypes: ['scene-description'] },
      estimatedLatencyMs: 300, costPerJobMicrousd: 1_500
    })
  ], now);
  assert.equal(decision.worker.id, 'external-budget');
  assert.equal(decision.fallback, true);
  assert.equal(decision.reason, 'home-gpu unavailable-or-ineligible');
});

test('metadata-only jobs may use external classification without media upload', () => {
  const job = validateJobInput({ taskType: 'event-classification', privacyLevel: 'metadata-only' });
  const decision = selectWorker(job, [worker({
    id: 'cloud', providerClass: 'external', capabilities: { taskTypes: ['event-classification'] }
  })]);
  assert.equal(decision.worker.id, 'cloud');
  assert.throws(() => validateJobInput({
    taskType: 'event-classification', privacyLevel: 'metadata-only', payload: { event: { frameRef: 'synthetic://frame' } }
  }), /metadata-only payload cannot include media field payload.event.frameRef/);
});
