import { fileURLToPath } from 'node:url';
import { createProvider } from './providers.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function envNumber(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function taskTypes(providerClass) {
  if (providerClass === 'nas-cpu') return ['person-detection', 'event-classification'];
  if (providerClass === 'home-gpu') return ['person-detection', 'face-identity', 'scene-description', 'event-classification'];
  return ['scene-description', 'event-classification'];
}

async function request(baseUrl, token, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...options.headers
    },
    signal: options.signal || AbortSignal.timeout(5_000)
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${body.error || response.status}`);
  return body;
}

export async function runWorker({ env = process.env, signal } = {}) {
  const baseUrl = (env.AI_ORCHESTRATOR_URL || 'http://localhost:8090').replace(/\/$/, '');
  const token = env.AI_ORCHESTRATOR_TOKEN;
  const providerClass = env.WORKER_PROVIDER_CLASS || 'nas-cpu';
  const workerId = env.WORKER_ID || `synthetic-${providerClass}`;
  const latencyMs = envNumber(env, 'WORKER_SYNTHETIC_LATENCY_MS', 700);
  const pollMs = envNumber(env, 'WORKER_POLL_MS', 1_000);
  const heartbeatMs = envNumber(env, 'WORKER_HEARTBEAT_MS', 5_000);
  if (!token) throw new Error('AI_ORCHESTRATOR_TOKEN is required');
  const provider = createProvider({ env, workerId, providerClass });
  const registration = {
    id: workerId,
    name: env.WORKER_NAME || workerId,
    providerClass,
    modelVersion: env.WORKER_MODEL_VERSION || `synthetic-${providerClass}-v1`,
    capabilities: { taskTypes: env.WORKER_TASK_TYPES ? env.WORKER_TASK_TYPES.split(',').map((value) => value.trim()).filter(Boolean) : taskTypes(providerClass) },
    maxConcurrency: Number(env.WORKER_MAX_CONCURRENCY || 1),
    availableMemoryMb: Number(env.WORKER_MEMORY_MB || 0),
    estimatedLatencyMs: Number(env.WORKER_ESTIMATED_LATENCY_MS || latencyMs),
    costPerJobMicrousd: Number(env.WORKER_COST_PER_JOB_MICROUSD || 0),
    metadata: { ...provider.metadata, ephemeral: providerClass !== 'nas-cpu' }
  };
  await request(baseUrl, token, '/v1/workers/register', { method: 'POST', body: JSON.stringify(registration) });
  console.log(`worker ${workerId} registered as ${providerClass}`);
  const active = new Map();
  const sendHeartbeat = async () => {
    try {
      await request(baseUrl, token, `/v1/workers/${encodeURIComponent(workerId)}/heartbeat`, {
        method: 'POST', body: JSON.stringify({ currentLoad: active.size })
      });
      await Promise.all([...active.entries()].map(([jobId, leaseToken]) => request(
        baseUrl, token, `/v1/jobs/${jobId}/lease/renew`, {
          method: 'POST', body: JSON.stringify({ workerId, leaseToken })
        }
      )));
    } catch (error) {
      if (!signal?.aborted) console.error(error.message);
    }
  };
  const heartbeat = setInterval(sendHeartbeat, heartbeatMs);
  heartbeat.unref();
  const execute = async (lease) => {
    const startedAt = Date.now();
    console.log(`worker ${workerId} claimed ${lease.job.id} (${lease.job.taskType})`);
    try {
      const outcome = await provider.infer(lease.job);
      await request(baseUrl, token, `/v1/jobs/${lease.job.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          workerId,
          leaseToken: lease.leaseToken,
          result: outcome.result,
          inferenceMs: Date.now() - startedAt,
          actualCostMicrousd: outcome.actualCostMicrousd
        })
      });
      console.log(`worker ${workerId} completed ${lease.job.id}`);
    } catch (error) {
      await request(baseUrl, token, `/v1/jobs/${lease.job.id}/fail`, {
        method: 'POST',
        body: JSON.stringify({
          workerId,
          leaseToken: lease.leaseToken,
          error: error.message,
          retryable: error.retryable !== false,
          inferenceMs: Date.now() - startedAt
        })
      });
      console.log(`worker ${workerId} failed ${lease.job.id}: ${error.message}`);
    }
  };
  while (!signal?.aborted) {
    try {
      await sendHeartbeat();
      while (active.size < registration.maxConcurrency && !signal?.aborted) {
        const lease = await request(baseUrl, token, `/v1/workers/${encodeURIComponent(workerId)}/claim`, {
          method: 'POST', body: '{}'
        });
        if (!lease) break;
        active.set(lease.job.id, lease.leaseToken);
        void execute(lease).catch((error) => {
          if (!signal?.aborted) console.error(error.message);
        }).finally(() => active.delete(lease.job.id));
      }
    } catch (error) {
      if (!signal?.aborted) console.error(error.message);
    }
    await sleep(pollMs);
  }
  await Promise.allSettled([...active.keys()].map(async (jobId) => {
    while (active.has(jobId)) await sleep(25);
  }));
  clearInterval(heartbeat);
}

async function main() {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  await runWorker({ signal: controller.signal });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
