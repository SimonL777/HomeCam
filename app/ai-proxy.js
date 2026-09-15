export async function proxyAiJson(request, response, {
  baseUrl,
  token,
  path,
  method = request.method,
  body,
  idempotencyKey = request.headers['idempotency-key'],
  timeoutMs = 5_000
}) {
  if (!baseUrl || !token) {
    response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: 'AI orchestrator is not configured' }));
    return;
  }
  try {
    const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await upstream.text();
    response.writeHead(upstream.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(payload || '{}');
  } catch (error) {
    const timedOut = error.name === 'TimeoutError';
    response.writeHead(timedOut ? 504 : 502, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(JSON.stringify({ error: timedOut ? 'AI orchestrator timed out' : 'AI orchestrator is unavailable' }));
  }
}
