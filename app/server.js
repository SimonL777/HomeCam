import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { isBasicAuthorized } from './basic-auth.js';
import { proxyAiJson } from './ai-proxy.js';
import { proxyHls } from './hls-proxy.js';
import { proxyWhep } from './webrtc-proxy.js';
import { RecordingPlayback } from './recording-playback.js';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const port = Number(process.env.PORT || 8080);
const defaultCameraId = process.env.CAMERA_ID || 'camera-01';
const defaultCameraName = process.env.CAMERA_NAME || 'CAM 1';
const mediamtxApiUrl = process.env.MEDIAMTX_API_URL || 'http://localhost:9997';
const mediamtxHlsUrl = (process.env.MEDIAMTX_HLS_URL || 'http://localhost:8888').replace(/\/$/, '');
const mediamtxWebrtcUrl = (process.env.MEDIAMTX_WEBRTC_URL || 'http://localhost:8889').replace(/\/$/, '');
const mediamtxReadUser = process.env.MEDIAMTX_READ_USER || '';
const mediamtxReadPassword = process.env.MEDIAMTX_READ_PASSWORD || '';
const hlsCdnSecret = process.env.HLS_CDN_SECRET || '';
const recordingsRoot = normalize(process.env.RECORDINGS_ROOT || '/var/lib/homecam/recordings');
const settingsFile = normalize(process.env.SETTINGS_FILE || '/var/lib/homecam/config/settings.json');
const playbackCacheRoot = normalize(process.env.PLAYBACK_CACHE_ROOT || '/tmp/homecam-vod');
const piControlUrl = (process.env.PI_CONTROL_URL || '').replace(/\/$/, '');
const piControlToken = process.env.PI_CONTROL_TOKEN || '';
const timezone = process.env.TZ || 'UTC';
const webUsername = process.env.WEB_USERNAME || '';
const webPassword = process.env.WEB_PASSWORD || '';
const allowInsecureNoAuth = process.env.ALLOW_INSECURE_NO_AUTH === 'true';
const aiOrchestratorUrl = (process.env.AI_ORCHESTRATOR_URL || '').replace(/\/$/, '');
const aiOrchestratorToken = process.env.AI_ORCHESTRATOR_TOKEN || '';

if ((!webUsername || !webPassword) && !allowInsecureNoAuth) {
  throw new Error('WEB_USERNAME and WEB_PASSWORD are required');
}
if (webUsername.includes(':')) {
  throw new Error('WEB_USERNAME cannot contain a colon');
}
if (!mediamtxReadUser || !mediamtxReadPassword) {
  throw new Error('MEDIAMTX_READ_USER and MEDIAMTX_READ_PASSWORD are required');
}

function loadCameraRegistry() {
  try {
    const configured = JSON.parse(process.env.CAMERAS_JSON || '[]');
    if (Array.isArray(configured) && configured.length) {
      return configured.map((camera, index) => ({
        id: String(camera.id),
        name: String(camera.name || `CAM ${index + 1}`),
        path: String(camera.path || camera.id),
        enabled: camera.enabled !== false
      }));
    }
  } catch (error) {
    console.error(`invalid CAMERAS_JSON: ${error.message}`);
  }
  return [
    { id: defaultCameraId, name: defaultCameraName, path: defaultCameraId, enabled: true },
    { id: 'camera-02', name: 'CAM 2', path: 'camera-02', enabled: false }
  ];
}

const cameras = loadCameraRegistry();
const cameraById = new Map(cameras.map((camera) => [camera.id, camera]));
const activeCamera = cameraById.get(defaultCameraId) || cameras[0];

const settingsOptions = {
  resolutions: ['640x480', '1280x720'],
  fps: [5, 10, 15, 20, 25, 30],
  bitrates: ['1000k', '1500k', '2000k', '3000k']
};

function defaultCameraSettings(camera) {
  return {
    id: camera.id,
    name: camera.name,
    enabled: camera.enabled,
    resolution: '1280x720',
    fps: 15,
    bitrate: '2000k',
    cameraApply: { status: 'unknown', detail: '尚未应用到采集端', at: null }
  };
}

const defaultSettings = {
  retentionDays: 7,
  storage: { retentionDays: 7 },
  cameras: Object.fromEntries(cameras.map((camera) => [camera.id, defaultCameraSettings(camera)])),
  updatedAt: null
};

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml'
};

let settings = structuredClone(defaultSettings);
const recordingPlayback = new RecordingPlayback({ root: playbackCacheRoot });

function sendJson(response, value, status = 200) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  sendJson(response, { error: message }, status);
}

function setSecurityHeaders(response) {
  response.setHeader('content-security-policy', "default-src 'self'; base-uri 'none'; connect-src 'self' http: https:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; script-src 'self'; style-src 'self'");
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
}

function authorizeRequest(request, response) {
  if (allowInsecureNoAuth && !webUsername && !webPassword) return true;
  if (isBasicAuthorized(request.headers.authorization, webUsername, webPassword)) return true;
  response.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'www-authenticate': 'Basic realm="HomeCam", charset="UTF-8"'
  });
  response.end('Authentication required');
  return false;
}

function normalizeSettings(parsed = {}) {
  const retentionDays = Number(parsed.storage?.retentionDays ?? parsed.retentionDays ?? 7);
  const result = structuredClone(defaultSettings);
  result.retentionDays = Number.isInteger(retentionDays) ? retentionDays : 7;
  result.storage.retentionDays = result.retentionDays;
  result.updatedAt = parsed.updatedAt || null;
  for (const camera of cameras) {
    const saved = parsed.cameras?.[camera.id] || (camera.id === activeCamera.id ? parsed : {});
    result.cameras[camera.id] = {
      ...defaultCameraSettings(camera),
      id: camera.id,
      name: String(saved.name || camera.name),
      enabled: saved.enabled !== undefined ? Boolean(saved.enabled) : camera.enabled,
      resolution: settingsOptions.resolutions.includes(saved.resolution) ? saved.resolution : '1280x720',
      fps: settingsOptions.fps.includes(Number(saved.fps)) ? Number(saved.fps) : 15,
      bitrate: settingsOptions.bitrates.includes(saved.bitrate) ? saved.bitrate : '2000k',
      cameraApply: saved.cameraApply || defaultCameraSettings(camera).cameraApply
    };
  }
  return result;
}

async function loadSettings() {
  try {
    settings = normalizeSettings(JSON.parse(await readFile(settingsFile, 'utf8')));
  } catch {
    settings = structuredClone(defaultSettings);
    await persistSettings();
  }
}

async function persistSettings() {
  await mkdir(join(settingsFile, '..'), { recursive: true });
  const temporary = `${settingsFile}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await rename(temporary, settingsFile);
}

function getCamera(cameraId) {
  return cameraById.get(cameraId) || activeCamera;
}

function isPrivateHost(hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (/^10\./.test(hostname) || /^192\.168\./.test(hostname)) return true;
  const match = hostname.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function publicCameraSettings(camera) {
  return { ...camera, ...(settings.cameras[camera.id] || defaultCameraSettings(camera)) };
}

function validateRetention(value) {
  const retentionDays = Number(value);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error('保留天数必须是 1 到 365 之间的整数');
  }
  return retentionDays;
}

function validateCameraSettings(input) {
  const next = {
    resolution: String(input.resolution),
    fps: Number(input.fps),
    bitrate: String(input.bitrate)
  };
  if (!settingsOptions.resolutions.includes(next.resolution)) throw new Error('不支持这个分辨率');
  if (!settingsOptions.fps.includes(next.fps)) throw new Error('不支持这个帧率');
  if (!settingsOptions.bitrates.includes(next.bitrate)) throw new Error('不支持这个码率');
  return next;
}

async function applyCameraSettings(camera, next) {
  if (camera.id !== activeCamera.id) {
    return { status: 'pending', detail: '该机位尚未接入独立采集端' };
  }
  if (!piControlUrl || !piControlToken) {
    return { status: 'pending', detail: '设置已保存，树莓派控制端尚未配置' };
  }
  try {
    const response = await fetch(`${piControlUrl}/v1/camera/settings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${piControlToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(next),
      signal: AbortSignal.timeout(8000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { status: 'error', detail: body.error || `树莓派返回 HTTP ${response.status}` };
    return { status: 'applied', detail: body.detail || '采集端已应用设置' };
  } catch (error) {
    return { status: 'error', detail: `无法连接采集端：${error.message}` };
  }
}

async function mediaStatus(camera) {
  try {
    const response = await fetch(`${mediamtxApiUrl}/v3/paths/list`);
    if (!response.ok) return { connected: false, detail: `MediaMTX API ${response.status}` };
    const body = await response.json();
    const path = body.items?.find((item) => item.name === camera.path);
    return {
      connected: Boolean(path?.ready),
      detail: path?.ready ? '实时流正常' : camera.enabled ? '等待该机位推流' : '该机位尚未接入'
    };
  } catch (error) {
    return { connected: false, detail: error.message };
  }
}

function localDate(instant) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(instant);
}

function localTime(instant) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(instant);
}

function recordingTime(fileName, fileInfo) {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (match) {
    const instant = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
    if (!Number.isNaN(instant.valueOf())) return instant;
  }
  return new Date(fileInfo.mtimeMs);
}

async function listRecordingFiles(directory, prefix = '') {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const relativeName = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await listRecordingFiles(absolute, relativeName));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.mp4') files.push({ absolute, relativeName });
  }
  return files;
}

async function listRecordings(camera, date) {
  const files = await listRecordingFiles(join(recordingsRoot, camera.path));
  const records = [];
  for (const file of files) {
    const info = await stat(file.absolute);
    const start = recordingTime(file.relativeName, info);
    if (date && localDate(start) !== date) continue;
    const end = new Date(Math.max(info.mtimeMs, start.getTime()));
    records.push({
      id: file.relativeName.split(sep).join('/'),
      cameraId: camera.id,
      cameraName: camera.name,
      name: file.relativeName,
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      date: localDate(start),
      startTime: localTime(start),
      endTime: localTime(end),
      timeRange: `${localTime(start)} - ${localTime(end)}`,
      size: info.size,
      url: `/recordings/${encodeURIComponent(camera.id)}/${encodeURIComponent(file.relativeName.split(sep).join('/'))}`
    });
  }
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function cleanupRecordings() {
  const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
  for (const camera of cameras) {
    const files = await listRecordingFiles(join(recordingsRoot, camera.path));
    for (const file of files) {
      const info = await stat(file.absolute);
      const instant = recordingTime(file.relativeName, info);
      if (instant.valueOf() < cutoff) await unlink(file.absolute).catch(() => {});
    }
  }
}

function safeRecordingPath(cameraId, encodedPath) {
  const camera = cameraById.get(cameraId);
  if (!camera) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  const cameraRoot = normalize(join(recordingsRoot, camera.path));
  const filePath = normalize(join(cameraRoot, decoded));
  if (!filePath.startsWith(cameraRoot + sep)) return null;
  return filePath;
}

async function serveRecording(request, response, cameraId, encodedPath) {
  const filePath = safeRecordingPath(cameraId, encodedPath);
  if (!filePath) return sendError(response, 403, 'Forbidden');
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error('not a file');
  } catch {
    return sendError(response, 404, '录像不存在');
  }
  const headers = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=60'
  };
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { ...headers, 'content-length': fileInfo.size });
    return createReadStream(filePath).pipe(response);
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return sendError(response, 416, '不支持的 Range');
  const start = match[1] ? Number(match[1]) : Math.max(0, fileInfo.size - Number(match[2] || 0));
  const end = match[2] ? Number(match[2]) : fileInfo.size - 1;
  if (start < 0 || start > end || end >= fileInfo.size) {
    response.writeHead(416, { 'content-range': `bytes */${fileInfo.size}` });
    return response.end();
  }
  response.writeHead(206, {
    ...headers,
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${fileInfo.size}`
  });
  return createReadStream(filePath, { start, end }).pipe(response);
}

async function readBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleCameraSettings(response, body) {
  const camera = cameraById.get(String(body.cameraId || ''));
  if (!camera) return sendError(response, 400, '机位不存在');
  let next;
  try {
    next = validateCameraSettings(body);
  } catch (error) {
    return sendError(response, 400, error.message);
  }
  const cameraApply = await applyCameraSettings(camera, next);
  settings.cameras[camera.id] = {
    ...publicCameraSettings(camera),
    ...next,
    cameraApply: { ...cameraApply, at: new Date().toISOString() }
  };
  settings.updatedAt = new Date().toISOString();
  await persistSettings();
  return sendJson(response, { camera: settings.cameras[camera.id], detail: cameraApply.detail });
}

async function serveStatic(request, response) {
  const requested = request.url === '/' ? '/index.html' : request.url.split('?')[0];
  const filePath = normalize(join(root, requested));
  if (!filePath.startsWith(root + sep) && filePath !== root) {
    response.writeHead(403);
    return response.end('Forbidden');
  }
  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, 'http://localhost');
  setSecurityHeaders(response);
  if (!authorizeRequest(request, response)) return;
  try {
    if (request.method === 'GET' && requestUrl.pathname === '/api/cameras') {
      const statuses = await Promise.all(cameras.map(async (camera) => ({
        ...publicCameraSettings(camera),
        status: await mediaStatus(camera)
      })));
      return sendJson(response, { items: statuses });
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/config') {
      const camera = getCamera(requestUrl.searchParams.get('cameraId') || activeCamera.id);
      const forwardedProto = request.headers['x-forwarded-proto'];
      const protocol = forwardedProto || 'http';
      const requestHost = request.headers.host?.split(':')[0] || 'localhost';
      const playbackMode = isPrivateHost(requestHost) && protocol !== 'https' ? 'webrtc' : 'hls';
      return sendJson(response, {
        cameraId: camera.id,
        cameraName: camera.name,
        webrtcUrl: '/webrtc',
        hlsUrl: `/hls/${encodeURIComponent(camera.id)}/index.m3u8`,
        playbackMode,
        timezone
      });
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
      return sendJson(response, await mediaStatus(getCamera(requestUrl.searchParams.get('cameraId') || activeCamera.id)));
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/settings') {
      return sendJson(response, {
        storage: { retentionDays: settings.retentionDays },
        cameras: cameras.map(publicCameraSettings),
        options: settingsOptions,
        controlConfigured: Boolean(piControlUrl && piControlToken)
      });
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/ai/overview') {
      return proxyAiJson(request, response, {
        baseUrl: aiOrchestratorUrl,
        token: aiOrchestratorToken,
        path: '/v1/overview'
      });
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/ai/jobs') {
      return proxyAiJson(request, response, {
        baseUrl: aiOrchestratorUrl,
        token: aiOrchestratorToken,
        path: '/v1/jobs',
        body: await readBody(request)
      });
    }
    if (request.method === 'PUT' && (requestUrl.pathname === '/api/settings/storage' || requestUrl.pathname === '/api/settings')) {
      const body = await readBody(request);
      if (body.cameraId) return handleCameraSettings(response, body);
      let retentionDays;
      try {
        retentionDays = validateRetention(body.retentionDays);
      } catch (error) {
        return sendError(response, 400, error.message);
      }
      settings.retentionDays = retentionDays;
      settings.storage.retentionDays = retentionDays;
      settings.updatedAt = new Date().toISOString();
      await persistSettings();
      await cleanupRecordings();
      return sendJson(response, { storage: settings.storage, detail: 'NAS 录像保留策略已保存' });
    }
    if (request.method === 'PUT' && requestUrl.pathname === '/api/settings/camera') {
      return handleCameraSettings(response, await readBody(request));
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/recordings') {
      const camera = getCamera(requestUrl.searchParams.get('cameraId') || activeCamera.id);
      return sendJson(response, { items: await listRecordings(camera, requestUrl.searchParams.get('date') || '') });
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/playback') {
      const id = requestUrl.searchParams.get('id') || '';
      if (!/^[\w.-]+\.mp4$/.test(id)) return sendError(response, 400, '录像路径无效');
      const path = safeRecordingPath(requestUrl.searchParams.get('cameraId'), encodeURIComponent(id));
      if (!path) return sendError(response, 404, '机位或录像不存在');
      return sendJson(response, await recordingPlayback.prepare(path));
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/playback/status') {
      const job = recordingPlayback.status(requestUrl.searchParams.get('token'));
      return job ? sendJson(response, job) : sendError(response, 404, '回放已过期，请重新选择录像');
    }
    if (request.method === 'GET' && requestUrl.pathname.startsWith('/playback/')) {
      const [, , token, name, extra] = requestUrl.pathname.split('/');
      if (extra !== undefined) return sendError(response, 404, 'Not found');
      return await recordingPlayback.serve(request, response, token, name);
    }
    if (request.method === 'GET' && requestUrl.pathname.startsWith('/hls/')) {
      const [, , encodedCameraId, ...encodedParts] = requestUrl.pathname.split('/');
      return await proxyHls(request, response, {
        camera: cameraById.get(decodeURIComponent(encodedCameraId)),
        encodedPath: encodedParts.join('/'), search: requestUrl.search,
        baseUrl: mediamtxHlsUrl, secret: hlsCdnSecret
      });
    }
    if (request.method === 'POST' && requestUrl.pathname.startsWith('/webrtc/')) {
      const [, , encodedCameraId, endpoint, extra] = requestUrl.pathname.split('/');
      if (endpoint !== 'whep' || extra !== undefined) return sendError(response, 404, 'Not found');
      return await proxyWhep(request, response, {
        camera: cameraById.get(decodeURIComponent(encodedCameraId)),
        baseUrl: mediamtxWebrtcUrl,
        username: mediamtxReadUser,
        password: mediamtxReadPassword
      });
    }
    if (requestUrl.pathname.startsWith('/recordings/') && request.method === 'GET') {
      const [, , encodedCameraId, ...encodedParts] = requestUrl.pathname.split('/');
      return serveRecording(request, response, decodeURIComponent(encodedCameraId), encodedParts.join('/'));
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET, PUT, POST' });
      return response.end('Method not allowed');
    }
    return serveStatic(request, response);
  } catch (error) {
    console.error(error);
    return sendError(response, error.statusCode || 400, error.message || '请求失败');
  }
});

await loadSettings();
await recordingPlayback.initialize();
await cleanupRecordings();
setInterval(() => cleanupRecordings().catch((error) => console.error('recording cleanup failed', error)), 6 * 60 * 60 * 1000);

server.listen(port, '0.0.0.0', () => {
  console.log(`homecam web listening on :${port}`);
});
