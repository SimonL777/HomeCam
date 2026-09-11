import { basicAuthorization } from './basic-auth.js';

async function readSdp(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('WebRTC offer is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function proxyWhep(request, response, {
  camera, baseUrl, username, password, timeoutMs = 15000, maxBytes = 1024 * 1024
}) {
  const fail = (status, message) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: message }));
  };
  if (!camera) return fail(404, 'Camera does not exist');

  const controller = new AbortController();
  const onClose = () => controller.abort();
  response.once('close', onClose);
  try {
    const offer = await readSdp(request, maxBytes);
    if (!offer.trim()) return fail(400, 'WebRTC offer is empty');
    const upstream = await fetch(`${baseUrl}/${encodeURIComponent(camera.path)}/whep`, {
      method: 'POST',
      headers: {
        authorization: basicAuthorization(username, password),
        'content-type': 'application/sdp'
      },
      body: offer,
      redirect: 'manual',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
    });
    const answer = await upstream.text();
    if (!upstream.ok) return fail([400, 401, 403, 404, 406, 415, 503].includes(upstream.status) ? upstream.status : 502, 'Live video is unavailable');
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/sdp',
      'cache-control': 'no-store'
    });
    response.end(answer);
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return;
    fail(error.statusCode || (error.name === 'TimeoutError' ? 504 : 502), 'WebRTC service is unavailable');
  } finally {
    response.removeListener('close', onClose);
  }
}
