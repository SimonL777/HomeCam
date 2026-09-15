const baseUrl = (process.env.AI_ORCHESTRATOR_URL || 'http://127.0.0.1:18090').replace(/\/$/, '');
const token = process.env.AI_ORCHESTRATOR_TOKEN || 'local-demo-token';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(path, options = {}, expectedStatus = null) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...options.headers
    }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (expectedStatus !== null) {
    if (response.status !== expectedStatus) throw new Error(`${path}: expected ${expectedStatus}, received ${response.status}`);
    return body;
  }
  if (!response.ok) throw new Error(`${path}: ${body?.error || response.status}`);
  return body;
}

async function register(worker) {
  return request('/v1/workers/register', { method: 'POST', body: JSON.stringify(worker) });
}

console.log('1. Register an intermittent GPU worker and an external fallback.');
await register({
  id: 'demo-gpu', name: 'RTX 4070S // Failover Demo', providerClass: 'home-gpu',
  modelVersion: 'synthetic-gpu-v1', capabilities: { taskTypes: ['scene-description', 'face-identity'] },
  estimatedLatencyMs: 100, maxConcurrency: 1, availableMemoryMb: 12288
});
await register({
  id: 'demo-external', name: 'External Provider // Failover Demo', providerClass: 'external',
  modelVersion: 'synthetic-external-v1', capabilities: { taskTypes: ['scene-description'] },
  estimatedLatencyMs: 150, costPerJobMicrousd: 1200, maxConcurrency: 1
});

console.log('2. Queue a scene-description job that explicitly allows external fallback.');
const job = await request('/v1/jobs', {
  method: 'POST',
  headers: { 'idempotency-key': `failover-${Date.now()}` },
  body: JSON.stringify({
    taskType: 'scene-description', privacyLevel: 'external-allowed', preferredProvider: 'home-gpu',
    budgetMicrousd: 5000, maxAttempts: 3, payload: { frameRef: 'synthetic://failover-demo' }
  })
});

console.log('3. GPU claims the lease, then disappears without completing it.');
const gpuLease = await request('/v1/workers/demo-gpu/claim', { method: 'POST', body: '{}' });
console.log(`   lease=${gpuLease.leaseToken.slice(0, 8)} job=${gpuLease.job.id.slice(0, 8)}`);
await sleep(900);

console.log('4. The control plane recovers the abandoned lease.');
console.log('  ', await request('/v1/maintenance/recover', { method: 'POST', body: '{}' }));
await sleep(100);
await request('/v1/workers/demo-external/heartbeat', { method: 'POST', body: '{}' });
const fallbackLease = await request('/v1/workers/demo-external/claim', { method: 'POST', body: '{}' });
if (!fallbackLease) throw new Error('external worker did not receive the recovered job');
console.log(`   fallback provider=${fallbackLease.job.providerClass} attempt=${fallbackLease.job.attempts}`);
await request(`/v1/jobs/${job.id}/complete`, {
  method: 'POST',
  body: JSON.stringify({
    workerId: 'demo-external', leaseToken: fallbackLease.leaseToken,
    inferenceMs: 150, actualCostMicrousd: 1200,
    result: { synthetic: true, description: 'Synthetic failover result.' }
  })
});

console.log('5. Privacy policy rejects an external face-identity request.');
const rejected = await request('/v1/jobs', {
  method: 'POST',
  body: JSON.stringify({ taskType: 'face-identity', privacyLevel: 'external-allowed', preferredProvider: 'external' })
}, 422);
console.log(`   rejected: ${rejected.error}`);

const overview = await request('/v1/overview');
const completed = overview.jobs.find((item) => item.id === job.id);
console.log('6. Final state');
console.log(JSON.stringify({
  job: {
    id: completed.id,
    state: completed.state,
    attempts: completed.attempts,
    providerClass: completed.providerClass,
    fallbackCount: completed.fallbackCount
  },
  metrics: overview.metrics
}, null, 2));
