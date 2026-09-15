import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { proxyAiJson } from './ai-proxy.js';

test('AI proxy keeps the orchestrator token on the server side', async (t) => {
  const upstream = createServer(async (request, response) => {
    assert.equal(request.url, '/v1/jobs');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer internal-ai-token');
    assert.equal(request.headers['idempotency-key'], 'event-1');
    let body = '';
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), { taskType: 'person-detection' });
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end('{"id":"job-1"}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const web = createServer((request, response) => {
    void proxyAiJson(request, response, {
      baseUrl: `http://127.0.0.1:${upstream.address().port}`,
      token: 'internal-ai-token',
      path: '/v1/jobs',
      body: { taskType: 'person-detection' },
      idempotencyKey: 'event-1'
    });
  });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  t.after(() => {
    web.closeAllConnections(); web.close();
    upstream.closeAllConnections(); upstream.close();
  });
  const response = await fetch(`http://127.0.0.1:${web.address().port}`, { method: 'POST' });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: 'job-1' });
});

test('AI proxy fails closed when it is not configured', async (t) => {
  const web = createServer((request, response) => {
    void proxyAiJson(request, response, { baseUrl: '', token: '', path: '/v1/overview' });
  });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  t.after(() => { web.closeAllConnections(); web.close(); });
  const response = await fetch(`http://127.0.0.1:${web.address().port}`);
  assert.equal(response.status, 503);
});
