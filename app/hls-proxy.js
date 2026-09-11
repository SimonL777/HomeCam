import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function proxyHls(request, response, { camera, encodedPath, search, baseUrl, secret, timeoutMs = 15000 }) {
  const fail = (status, message) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: message }));
  };
  if (!camera) return fail(404, '机位不存在');
  let file;
  try {
    file = decodeURIComponent(encodedPath);
  } catch {
    return fail(400, '无效的 HLS 路径');
  }
  if (!/^[\w-][\w.-]*\.(m3u8|mp4|mp|ts)$/.test(file)) return fail(403, '无效的 HLS 路径');

  const controller = new AbortController();
  const onClose = () => controller.abort();
  response.once('close', onClose);
  try {
    const headers = { 'accept-encoding': 'identity' };
    if (request.headers.range) headers.range = request.headers.range;
    if (secret) headers.authorization = `Bearer ${secret}`;
    const upstream = await fetch(`${baseUrl}/${encodeURIComponent(camera.path)}/${encodeURIComponent(file)}${search}`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return fail([401, 403, 404, 416, 503].includes(upstream.status) ? upstream.status : 502, '视频暂时不可用，请重试');
    }
    const responseHeaders = {
      'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no'
    };
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    response.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) return response.end();
    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return;
    if (response.headersSent) response.destroy();
    else fail(error.name === 'TimeoutError' ? 504 : 502, '视频服务暂时无法连接');
  } finally {
    response.removeListener('close', onClose);
  }
}
