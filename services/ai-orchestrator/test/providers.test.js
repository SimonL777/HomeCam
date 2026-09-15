import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createProvider } from '../src/providers.js';

test('synthetic provider is explicit and deterministic', async () => {
  const provider = createProvider({
    env: { WORKER_RUNTIME: 'synthetic', WORKER_SYNTHETIC_LATENCY_MS: '1' },
    workerId: 'gpu-demo', providerClass: 'home-gpu'
  });
  const outcome = await provider.infer({ taskType: 'scene-description', payload: {} });
  assert.equal(provider.metadata.synthetic, true);
  assert.equal(outcome.result.synthetic, true);
  assert.equal(outcome.result.workerId, 'gpu-demo');
});

test('HTTP JSON provider sends a bearer token and returns metered results', async (t) => {
  const upstream = createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer provider-test-token');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    assert.deepEqual(JSON.parse(raw), {
      jobId: 'job-1',
      taskType: 'scene-description',
      privacyLevel: 'external-allowed',
      payload: { frameRef: 'synthetic://frame' }
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result: { description: 'test result' }, actualCostMicrousd: 1250 }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const provider = createProvider({
    env: {
      WORKER_RUNTIME: 'http-json',
      EXTERNAL_PROVIDER_URL: `http://127.0.0.1:${upstream.address().port}/infer`,
      EXTERNAL_PROVIDER_TOKEN: 'provider-test-token',
      ALLOW_INSECURE_PROVIDER_HTTP: 'true'
    },
    workerId: 'external-1', providerClass: 'external'
  });
  const outcome = await provider.infer({
    id: 'job-1', taskType: 'scene-description', privacyLevel: 'external-allowed', payload: { frameRef: 'synthetic://frame' }
  });
  assert.deepEqual(outcome, { result: { description: 'test result' }, actualCostMicrousd: 1250 });
  assert.equal(provider.metadata.endpointHost, `127.0.0.1:${upstream.address().port}`);
});

test('HTTP JSON provider requires HTTPS and external worker classification', () => {
  assert.throws(() => createProvider({
    env: {
      WORKER_RUNTIME: 'http-json', EXTERNAL_PROVIDER_URL: 'http://provider.example/infer',
      EXTERNAL_PROVIDER_TOKEN: 'token'
    },
    workerId: 'external-1', providerClass: 'external'
  }), /must use HTTPS/);
  assert.throws(() => createProvider({
    env: {
      WORKER_RUNTIME: 'http-json', EXTERNAL_PROVIDER_URL: 'https://provider.example/infer',
      EXTERNAL_PROVIDER_TOKEN: 'token'
    },
    workerId: 'gpu-1', providerClass: 'home-gpu'
  }), /restricted to external workers/);
});
