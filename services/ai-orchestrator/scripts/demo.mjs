const baseUrl = (process.env.AI_ORCHESTRATOR_URL || 'http://localhost:8090').replace(/\/$/, '');
const token = process.env.AI_ORCHESTRATOR_TOKEN || 'replace-with-a-random-64-character-secret';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...options.headers
    }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${body?.error || response.status}`);
  return body;
}

const suffix = Date.now();
const jobs = [
  {
    taskType: 'person-detection',
    privacyLevel: 'local-only',
    payload: { frameRef: `synthetic://entry/${suffix}` }
  },
  {
    taskType: 'event-classification',
    privacyLevel: 'metadata-only',
    payload: { personCount: 1, durationSeconds: 18, zone: 'entry' }
  },
  {
    taskType: 'scene-description',
    privacyLevel: 'external-allowed',
    preferredProvider: 'home-gpu',
    budgetMicrousd: 5_000,
    payload: { frameRef: `synthetic://entry/${suffix}` }
  }
];

console.log(`HomeCam AI demo -> ${baseUrl}`);
for (const [index, job] of jobs.entries()) {
  const created = await request('/v1/jobs', {
    method: 'POST',
    headers: { 'idempotency-key': `homecam-demo-${suffix}-${index}` },
    body: JSON.stringify(job)
  });
  console.log(`queued ${created.id} ${created.taskType} privacy=${created.privacyLevel}`);
}

await new Promise((resolve) => setTimeout(resolve, 2_500));
const overview = await request('/v1/overview');
console.log(JSON.stringify({ metrics: overview.metrics, workers: overview.workers, jobs: overview.jobs.slice(0, 3) }, null, 2));
