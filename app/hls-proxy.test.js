import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { proxyHls } from './hls-proxy.js';
import { preferHls } from './public/playback-mode.js';

test('browser address chooses same-origin HLS independently of proxy headers', () => {
  for (const hostname of ['monitor.example.com', 'another.example.com', '198.51.100.10']) {
    assert.equal(preferHls({ hostname, protocol: 'http:' }), true);
  }
  assert.equal(preferHls({ hostname: '192.168.50.10', protocol: 'https:' }), true);
  assert.equal(preferHls({ hostname: '192.168.50.10', protocol: 'http:' }), false);
});

test('HLS proxy preserves media requests and survives upstream failures', async (t) => {
  let behavior = 'playlist';
  let upstreamRequests = 0;
  const upstream = createServer((req, res) => {
    upstreamRequests += 1;
    assert.equal(req.headers.authorization, 'Bearer test-only-secret');
    if (behavior === 'redirect') { res.writeHead(302, { location: '/elsewhere' }); return res.end(); }
    if (behavior === 'unavailable') { res.writeHead(503); return res.end('unavailable'); }
    if (behavior === 'timeout') return;
    if (behavior === 'segment') {
      assert.equal(req.headers.range, 'bytes=0-6');
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': 7, 'content-range': 'bytes 0-6/7' });
      return res.end('segment');
    }
    assert.equal(req.url, '/camera-01/index.m3u8?_HLS_msn=8&_HLS_part=2');
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\nvideo1_stream.m3u8\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const web = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    void proxyHls(req, res, {
      camera: { path: 'camera-01' }, encodedPath: url.pathname.slice(1), search: url.search,
      baseUrl, secret: 'test-only-secret', timeoutMs: 250
    });
  });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  const url = `http://127.0.0.1:${web.address().port}`;
  t.after(() => {
    web.closeAllConnections(); web.close();
    upstream.closeAllConnections(); upstream.close();
  });
  const playlist = await fetch(`${url}/index.m3u8?_HLS_msn=8&_HLS_part=2`);
  assert.equal(playlist.status, 200);
  assert.equal(playlist.headers.get('set-cookie'), null);
  assert.equal(await playlist.text(), '#EXTM3U\nvideo1_stream.m3u8\n');
  behavior = 'segment';
  const segment = await fetch(`${url}/chunk.mp4`, { headers: { range: 'bytes=0-6' } });
  assert.equal(segment.status, 206);
  assert.equal(await segment.text(), 'segment');
  const count = upstreamRequests;
  assert.equal((await fetch(`${url}/%2e%2e%2fother/index.m3u8`)).status, 403);
  assert.equal(upstreamRequests, count);
  behavior = 'redirect';
  assert.equal((await fetch(`${url}/index.m3u8`)).status, 502);
  assert.equal(upstreamRequests, count + 1);
  behavior = 'unavailable';
  assert.equal((await fetch(`${url}/index.m3u8`)).status, 503);
  behavior = 'timeout';
  assert.equal((await fetch(`${url}/index.m3u8`)).status, 504);
  behavior = 'playlist';
  assert.equal((await fetch(`${url}/index.m3u8?_HLS_msn=8&_HLS_part=2`)).status, 200);
});
