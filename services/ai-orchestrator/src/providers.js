export class ProviderError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function positiveNumber(value, name, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function syntheticResult(job, workerId, providerClass) {
  const base = { synthetic: true, workerId, providerClass, taskType: job.taskType };
  if (job.taskType === 'person-detection') {
    return { ...base, detections: [{ label: 'person', confidence: 0.93, box: [0.27, 0.12, 0.31, 0.74] }] };
  }
  if (job.taskType === 'face-identity') {
    return { ...base, match: { subject: 'demo-household-member', confidence: 0.91 }, localDecision: true };
  }
  if (job.taskType === 'scene-description') {
    return { ...base, description: 'Synthetic demo: one person is standing near the entry area.' };
  }
  return { ...base, category: 'person-arrival', confidence: 0.88 };
}

class SyntheticProvider {
  constructor({ env, workerId, providerClass }) {
    this.workerId = workerId;
    this.providerClass = providerClass;
    this.latencyMs = positiveNumber(env.WORKER_SYNTHETIC_LATENCY_MS, 'WORKER_SYNTHETIC_LATENCY_MS', 700);
    this.costMicrousd = Number(env.WORKER_COST_PER_JOB_MICROUSD || 0);
    this.metadata = { runtime: 'synthetic', synthetic: true };
  }

  async infer(job) {
    await sleep(this.latencyMs);
    if (job.payload?.simulateFailure === true) {
      throw new ProviderError('synthetic-provider-failure');
    }
    return {
      result: syntheticResult(job, this.workerId, this.providerClass),
      actualCostMicrousd: this.costMicrousd
    };
  }
}

class HttpJsonProvider {
  constructor({ env, providerClass }) {
    if (providerClass !== 'external') throw new Error('http-json runtime is restricted to external workers');
    if (!env.EXTERNAL_PROVIDER_URL) throw new Error('EXTERNAL_PROVIDER_URL is required for http-json runtime');
    if (!env.EXTERNAL_PROVIDER_TOKEN) throw new Error('EXTERNAL_PROVIDER_TOKEN is required for http-json runtime');
    this.url = new URL(env.EXTERNAL_PROVIDER_URL);
    if (this.url.protocol !== 'https:' && env.ALLOW_INSECURE_PROVIDER_HTTP !== 'true') {
      throw new Error('EXTERNAL_PROVIDER_URL must use HTTPS');
    }
    this.token = env.EXTERNAL_PROVIDER_TOKEN;
    this.timeoutMs = positiveNumber(env.EXTERNAL_PROVIDER_TIMEOUT_MS, 'EXTERNAL_PROVIDER_TIMEOUT_MS', 15_000);
    this.metadata = { runtime: 'http-json', synthetic: false, endpointHost: this.url.host };
  }

  async infer(job) {
    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          jobId: job.id,
          taskType: job.taskType,
          privacyLevel: job.privacyLevel,
          payload: job.payload
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new ProviderError(`external provider request failed: ${error.message}`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new ProviderError('external provider response is too large', { retryable: false });
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new ProviderError('external provider returned invalid JSON', { retryable: false });
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderError(body.error || `external provider returned HTTP ${response.status}`, { retryable });
    }
    if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) {
      throw new ProviderError('external provider response must contain a result object', { retryable: false });
    }
    const actualCostMicrousd = Number(body.actualCostMicrousd || 0);
    if (!Number.isInteger(actualCostMicrousd) || actualCostMicrousd < 0) {
      throw new ProviderError('external provider returned invalid actualCostMicrousd', { retryable: false });
    }
    return { result: body.result, actualCostMicrousd };
  }
}

export function createProvider({ env = process.env, workerId, providerClass }) {
  const runtime = env.WORKER_RUNTIME || 'synthetic';
  if (runtime === 'synthetic') return new SyntheticProvider({ env, workerId, providerClass });
  if (runtime === 'http-json') return new HttpJsonProvider({ env, providerClass });
  throw new Error(`unsupported WORKER_RUNTIME: ${runtime}`);
}
