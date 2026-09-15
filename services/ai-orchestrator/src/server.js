import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';

function sendJson(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, { error: message }, status);
}

async function readBody(request, maxBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function authorized(request, token) {
  if (!token) return false;
  const prefix = 'Bearer ';
  const header = request.headers.authorization || '';
  if (!header.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function prometheus(metrics) {
  const lines = [
    '# HELP homecam_ai_jobs Current inference jobs by state.',
    '# TYPE homecam_ai_jobs gauge'
  ];
  for (const [state, value] of Object.entries(metrics.jobs)) {
    lines.push(`homecam_ai_jobs{state="${state}"} ${value}`);
  }
  lines.push(
    '# HELP homecam_ai_workers Current workers by liveness.',
    '# TYPE homecam_ai_workers gauge',
    `homecam_ai_workers{status="online"} ${metrics.workers.online}`,
    `homecam_ai_workers{status="offline"} ${metrics.workers.offline}`,
    '# HELP homecam_ai_attempts_total Total inference attempts.',
    '# TYPE homecam_ai_attempts_total counter',
    `homecam_ai_attempts_total ${metrics.attempts.total}`,
    '# HELP homecam_ai_fallback_total Total jobs routed away from their first provider class.',
    '# TYPE homecam_ai_fallback_total counter',
    `homecam_ai_fallback_total ${metrics.attempts.fallbackTotal}`,
    '# HELP homecam_ai_retry_total Total failed or expired attempts.',
    '# TYPE homecam_ai_retry_total counter',
    `homecam_ai_retry_total ${metrics.attempts.retryTotal}`,
    '# HELP homecam_ai_queue_milliseconds_avg Average queue time at lease acquisition.',
    '# TYPE homecam_ai_queue_milliseconds_avg gauge',
    `homecam_ai_queue_milliseconds_avg ${metrics.attempts.queueMsAvg}`,
    '# HELP homecam_ai_inference_milliseconds_avg Average successful inference latency.',
    '# TYPE homecam_ai_inference_milliseconds_avg gauge',
    `homecam_ai_inference_milliseconds_avg ${metrics.attempts.inferenceMsAvg}`,
    '# HELP homecam_ai_cost_microusd_total Reported inference cost in millionths of a US dollar.',
    '# TYPE homecam_ai_cost_microusd_total counter',
    `homecam_ai_cost_microusd_total ${metrics.attempts.costMicrousdTotal}`
  );
  return `${lines.join('\n')}\n`;
}

export function createOrchestratorServer({
  store,
  token,
  leaseMs = 30_000,
  offlineAfterMs = 30_000,
  now = () => Date.now()
}) {
  if (!store) throw new Error('store is required');
  if (!token) throw new Error('AI_ORCHESTRATOR_TOKEN is required');
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      return sendJson(response, { status: 'ok' });
    }
    if (!authorized(request, token)) {
      response.setHeader('www-authenticate', 'Bearer');
      return sendError(response, 401, 'authentication required');
    }
    try {
      const instant = now();
      if (request.method === 'POST' && requestUrl.pathname === '/v1/jobs') {
        const result = store.enqueue(await readBody(request), {
          now: instant,
          idempotencyKey: request.headers['idempotency-key'] || null
        });
        return sendJson(response, result.job, result.created ? 201 : 200);
      }
      if (request.method === 'GET' && requestUrl.pathname === '/v1/jobs') {
        return sendJson(response, {
          items: store.listJobs({ state: requestUrl.searchParams.get('state'), limit: requestUrl.searchParams.get('limit') })
        });
      }
      const jobMatch = requestUrl.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (request.method === 'GET' && jobMatch) {
        const job = store.getJob(decodeURIComponent(jobMatch[1]));
        return job ? sendJson(response, job) : sendError(response, 404, 'job not found');
      }
      const completionMatch = requestUrl.pathname.match(/^\/v1\/jobs\/([^/]+)\/(complete|fail)$/);
      if (request.method === 'POST' && completionMatch) {
        const body = await readBody(request);
        const job = completionMatch[2] === 'complete'
          ? store.complete(decodeURIComponent(completionMatch[1]), body, instant)
          : store.fail(decodeURIComponent(completionMatch[1]), body, instant);
        return sendJson(response, job);
      }
      const renewalMatch = requestUrl.pathname.match(/^\/v1\/jobs\/([^/]+)\/lease\/renew$/);
      if (request.method === 'POST' && renewalMatch) {
        return sendJson(response, store.renewLease(
          decodeURIComponent(renewalMatch[1]), await readBody(request), { now: instant, leaseMs }
        ));
      }
      if (request.method === 'POST' && requestUrl.pathname === '/v1/workers/register') {
        return sendJson(response, store.registerWorker(await readBody(request), instant, offlineAfterMs), 201);
      }
      if (request.method === 'GET' && requestUrl.pathname === '/v1/workers') {
        return sendJson(response, { items: store.listWorkers(instant, offlineAfterMs) });
      }
      const workerMatch = requestUrl.pathname.match(/^\/v1\/workers\/([^/]+)\/(heartbeat|claim)$/);
      if (request.method === 'POST' && workerMatch) {
        const workerId = decodeURIComponent(workerMatch[1]);
        if (workerMatch[2] === 'heartbeat') {
          return sendJson(response, store.heartbeat(workerId, await readBody(request), instant, offlineAfterMs));
        }
        const lease = store.claim(workerId, { now: instant, leaseMs, offlineAfterMs });
        if (!lease) {
          response.writeHead(204, { 'cache-control': 'no-store' });
          return response.end();
        }
        return sendJson(response, lease);
      }
      if (request.method === 'GET' && requestUrl.pathname === '/v1/overview') {
        return sendJson(response, store.overview(instant, offlineAfterMs));
      }
      if (request.method === 'POST' && requestUrl.pathname === '/v1/maintenance/recover') {
        return sendJson(response, store.recoverExpiredLeases(instant));
      }
      if (request.method === 'GET' && requestUrl.pathname === '/metrics') {
        const body = prometheus(store.metrics(instant, offlineAfterMs));
        response.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store'
        });
        return response.end(body);
      }
      if (!['GET', 'POST'].includes(request.method)) {
        response.writeHead(405, { allow: 'GET, POST' });
        return response.end('Method not allowed');
      }
      return sendError(response, 404, 'not found');
    } catch (error) {
      const status = error.statusCode || 500;
      if (status >= 500) console.error(error);
      return sendError(response, status, error.message || 'internal error');
    }
  });
}

async function main() {
  const port = Number(process.env.PORT || 8090);
  const leaseMs = Number(process.env.AI_LEASE_MS || 30_000);
  const offlineAfterMs = Number(process.env.AI_WORKER_OFFLINE_MS || 30_000);
  const sweepMs = Number(process.env.AI_SWEEP_MS || 5_000);
  const store = new Store({
    path: process.env.AI_DATABASE_PATH || '/var/lib/homecam-ai/orchestrator.db',
    retryBaseMs: Number(process.env.AI_RETRY_BASE_MS || 1_000)
  });
  const server = createOrchestratorServer({
    store,
    token: process.env.AI_ORCHESTRATOR_TOKEN,
    leaseMs,
    offlineAfterMs
  });
  const sweep = setInterval(() => {
    try {
      const result = store.recoverExpiredLeases();
      if (result.requeued || result.deadLettered) console.log('lease recovery', result);
    } catch (error) {
      console.error('lease recovery failed', error);
    }
  }, sweepMs);
  sweep.unref();
  const close = () => {
    clearInterval(sweep);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  server.listen(port, '0.0.0.0', () => console.log(`homecam ai orchestrator listening on :${port}`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
