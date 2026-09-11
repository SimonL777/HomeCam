import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { proxyWhep } from './webrtc-proxy.js';

test('WHEP proxy authenticates upstream and returns its SDP answer', async (t) => {
  const upstream = createServer(async (request, response) => {
    assert.equal(request.url, '/camera-01/whep');
    assert.equal(request.headers.authorization, `Basic ${Buffer.from('viewer:test-password').toString('base64')}`);
    assert.equal(request.headers['content-type'], 'application/sdp');
    let body = '';
    for await (const chunk of request) body += chunk;
    assert.equal(body, 'test-offer');
    response.writeHead(201, { 'content-type': 'application/sdp' });
    response.end('test-answer');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const web = createServer((request, response) => {
    void proxyWhep(request, response, {
      camera: { path: 'camera-01' },
      baseUrl: `http://127.0.0.1:${upstream.address().port}`,
      username: 'viewer', password: 'test-password'
    });
  });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  t.after(() => {
    web.closeAllConnections(); web.close();
    upstream.closeAllConnections(); upstream.close();
  });

  const response = await fetch(`http://127.0.0.1:${web.address().port}`, {
    method: 'POST', headers: { 'content-type': 'application/sdp' }, body: 'test-offer'
  });
  assert.equal(response.status, 201);
  assert.equal(await response.text(), 'test-answer');
});
