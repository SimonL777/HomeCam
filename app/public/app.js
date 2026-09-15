import { preferHls } from './playback-mode.js';

const preview = document.querySelector('#preview');
const emptyState = document.querySelector('#empty-state');
const status = document.querySelector('#status');
const cameraName = document.querySelector('#camera-name');
const hudCamera = document.querySelector('#hud-camera');
const liveDetail = document.querySelector('#live-detail');
const lastUpdate = document.querySelector('#last-update');
const connectButton = document.querySelector('#connect');
const historyVideo = document.querySelector('#history-video');
const playbackEmpty = document.querySelector('#playback-empty');
const playbackCaption = document.querySelector('#playback-caption');
const recordingList = document.querySelector('#recording-list');
const recordingDate = document.querySelector('#recording-date');
const recordingCamera = document.querySelector('#recording-camera');
const downloadButton = document.querySelector('#download-recording');
const downloadStatus = document.querySelector('#download-status');
const downloadProgress = document.querySelector('#download-progress');
const downloadPercent = document.querySelector('#download-percent');
const storageForm = document.querySelector('#storage-form');
const cameraForm = document.querySelector('#camera-form');
const settingsState = document.querySelector('#settings-state');
const storageMessage = document.querySelector('#storage-message');
const cameraMessage = document.querySelector('#camera-message');
const configNote = document.querySelector('#config-note');
const aiRefreshState = document.querySelector('#ai-refresh-state');
const workerList = document.querySelector('#worker-list');
const jobList = document.querySelector('#job-list');
const dispatchForm = document.querySelector('#dispatch-form');
const dispatchMessage = document.querySelector('#dispatch-message');

let config;
let cameraList = [];
let settingsData;
let selectedCameraId;
let selectedRecording;
let peer;
let hlsPlayer;
let nativeHlsActive = false;
let connecting = false;
let hlsRetryTimer;
let activeView = 'live';
let historyPlayer;
let historyRequest;
let historyVersion = 0;
let aiRefreshInFlight = false;

const formatBytes = (bytes) => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

function cameraLabel(camera) {
  return `${camera.name}${camera.status?.connected ? '' : ' // 未接入'}`;
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `请求失败：${response.status}`);
  return body;
}

function setStatus(online, text) {
  status.classList.toggle('online', online);
  status.querySelector('span:last-child').textContent = text;
  lastUpdate.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function setEmpty(title, detail) {
  emptyState.querySelector('strong').textContent = title;
  emptyState.querySelector('span').textContent = detail;
  emptyState.hidden = false;
}

function populateCameraSelect(select, value = selectedCameraId) {
  const current = value || select.value;
  select.replaceChildren(...cameraList.map((camera) => {
    const option = document.createElement('option');
    option.value = camera.id;
    option.textContent = cameraLabel(camera);
    return option;
  }));
  if (cameraList.some((camera) => camera.id === current)) select.value = current;
}

function populateSelect(select, values, labels = (value) => value) {
  select.replaceChildren(...values.map((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = labels(value);
    return option;
  }));
}

async function loadCameras() {
  const result = await getJson('/api/cameras');
  cameraList = result.items || [];
  selectedCameraId = selectedCameraId || cameraList.find((camera) => camera.status?.connected)?.id || cameraList[0]?.id;
  populateCameraSelect(document.querySelector('#live-camera'));
  populateCameraSelect(document.querySelector('#recording-camera'));
  populateCameraSelect(document.querySelector('#settings-camera'));
  cameraName.textContent = cameraList.find((camera) => camera.id === selectedCameraId)?.name || 'CAM 1';
  hudCamera.textContent = cameraList.find((camera) => camera.id === selectedCameraId)?.name || 'CAM 1';
}

async function loadConfig() {
  config = await getJson(`/api/config?cameraId=${encodeURIComponent(selectedCameraId)}`);
  // Reverse proxies may replace Host; the browser address is authoritative.
  if (preferHls(window.location)) config.playbackMode = 'hls';
  cameraName.textContent = config.cameraName;
  hudCamera.textContent = config.cameraName;
}

async function refreshStatus() {
  try {
    const result = await getJson(`/api/status?cameraId=${encodeURIComponent(selectedCameraId)}`);
    setStatus(result.connected, result.connected ? 'ONLINE' : 'OFFLINE');
    liveDetail.textContent = result.connected
      ? (config?.playbackMode === 'hls' ? '远程播放 // HLS' : '局域网模式 // WEBRTC')
      : result.detail;
    if (activeView === 'live' && result.connected && !peer && !hlsPlayer && !nativeHlsActive && !connecting && !hlsRetryTimer) await connectLive();
    if (!result.connected && (peer || hlsPlayer || nativeHlsActive)) resetPlayback();
    if (!result.connected && !peer && !hlsPlayer && !nativeHlsActive) setEmpty('NO SIGNAL', result.detail);
  } catch (error) {
    setStatus(false, 'ERROR');
    liveDetail.textContent = error.message;
    setEmpty('SYSTEM ERROR', error.message);
  }
}

async function waitForIce(connection) {
  if (connection.iceGatheringState === 'complete') return;
  await new Promise((resolve) => {
    const handleStateChange = () => {
      if (connection.iceGatheringState !== 'complete') return;
      connection.removeEventListener('icegatheringstatechange', handleStateChange);
      resolve();
    };
    connection.addEventListener('icegatheringstatechange', handleStateChange);
  });
}

function resetPlayback() {
  clearTimeout(hlsRetryTimer);
  hlsRetryTimer = undefined;
  preview.onplaying = null;
  preview.onerror = null;
  if (peer) peer.close();
  peer = undefined;
  if (hlsPlayer) hlsPlayer.destroy();
  hlsPlayer = undefined;
  nativeHlsActive = false;
  preview.removeAttribute('src');
  preview.srcObject = null;
  preview.load();
  setEmpty('NO SIGNAL', '等待该机位推流。');
}

async function connectLive() {
  if (connecting || !config) return;
  connecting = true;
  if (config.playbackMode === 'hls') {
    try {
      await connectHls();
    } finally {
      connecting = false;
    }
    return;
  }
  const connection = new RTCPeerConnection();
  if (peer) peer.close();
  peer = connection;
  setEmpty('CONNECTING', '正在建立 WebRTC 连接。');
  const resetConnection = () => {
    if (peer !== connection) return;
    connection.close();
    peer = undefined;
    preview.srcObject = null;
    setEmpty('NO SIGNAL', '正在等待下一次自动重连。');
  };
  try {
    connection.addTransceiver('video', { direction: 'recvonly' });
    connection.ontrack = (event) => {
      preview.srcObject = event.streams[0];
      emptyState.hidden = true;
    };
    connection.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(connection.connectionState)) resetConnection();
      if (connection.connectionState === 'disconnected') {
        setTimeout(() => {
          if (connection.connectionState === 'disconnected') resetConnection();
        }, 2000);
      }
    };
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIce(connection);
    const response = await fetch(`${config.webrtcUrl}/${config.cameraId}/whep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: connection.localDescription.sdp
    });
    if (!response.ok) throw new Error(`WebRTC endpoint returned ${response.status}`);
    await connection.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  } catch (error) {
    resetConnection();
    throw error;
  } finally {
    connecting = false;
  }
}

async function connectHls() {
  resetPlayback();
  setEmpty('CONNECTING', '正在通过安全外网通道加载视频。');
  liveDetail.textContent = '远程播放 // HLS';
  document.querySelector('.viewer-hud span:last-child').textContent = 'REMOTE // HLS';
  preview.onplaying = () => { emptyState.hidden = true; };
  const play = () => preview.play().catch(() => setEmpty('等待播放', '点击重新连接以播放视频。'));
  const retry = () => {
    resetPlayback();
    setEmpty('RECONNECTING', '视频连接中断，正在重试。');
    hlsRetryTimer = setTimeout(() => {
      hlsRetryTimer = undefined;
      refreshStatus();
    }, 3000);
  };
  if (window.Hls?.isSupported()) {
    const player = new window.Hls({
      lowLatencyMode: true,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 8,
      backBufferLength: 30
    });
    hlsPlayer = player;
    player.attachMedia(preview);
    player.on(window.Hls.Events.MEDIA_ATTACHED, () => player.loadSource(config.hlsUrl));
    player.on(window.Hls.Events.MANIFEST_PARSED, play);
    player.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data.fatal && hlsPlayer === player) retry();
    });
    return;
  }
  if (preview.canPlayType('application/vnd.apple.mpegurl')) {
    nativeHlsActive = true;
    preview.src = config.hlsUrl;
    preview.onerror = retry;
    preview.load();
    play();
    return;
  }
  throw new Error('当前浏览器不支持 HLS 播放');
}

async function switchLiveCamera() {
  selectedCameraId = document.querySelector('#live-camera').value;
  resetPlayback();
  await loadConfig();
  await refreshStatus();
}

function activateView(viewName) {
  activeView = viewName;
  if (viewName !== 'live') resetPlayback();
  else refreshStatus();
  if (viewName !== 'history') stopHistory();
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === viewName));
  document.querySelectorAll('.view').forEach((view) => {
    const active = view.id === `view-${viewName}`;
    view.classList.toggle('active', active);
    view.hidden = !active;
  });
  if (viewName === 'history') loadRecordings();
  if (viewName === 'ai') loadAiOverview();
  if (viewName === 'settings') loadSettings();
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '--';
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function formatCost(microusd) {
  if (!microusd) return '$0.0000';
  return `$${(microusd / 1_000_000).toFixed(4)}`;
}

function renderWorkers(workers) {
  workerList.replaceChildren();
  if (!workers.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '尚无 Worker 注册。';
    workerList.append(empty);
    return;
  }
  workers.forEach((worker) => {
    const row = document.createElement('div');
    row.className = `worker-row ${worker.status}`;
    const identity = document.createElement('div');
    const name = document.createElement('strong');
    const model = document.createElement('span');
    name.textContent = worker.name;
    model.textContent = worker.modelVersion;
    identity.append(name, model);
    const provider = document.createElement('span');
    provider.className = `provider provider-${worker.providerClass}`;
    provider.textContent = worker.providerClass;
    const capabilities = document.createElement('span');
    capabilities.className = 'worker-capabilities';
    capabilities.textContent = worker.capabilities.taskTypes.join(' · ');
    const load = document.createElement('span');
    load.className = 'worker-load';
    load.textContent = `${worker.currentLoad}/${worker.maxConcurrency} // ${worker.status}`;
    row.append(identity, provider, capabilities, load);
    workerList.append(row);
  });
}

function renderJobs(jobs) {
  jobList.replaceChildren();
  if (!jobs.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'muted';
    cell.textContent = '队列为空。';
    row.append(cell);
    jobList.append(row);
    return;
  }
  jobs.forEach((job) => {
    const row = document.createElement('tr');
    const state = document.createElement('td');
    const stateTag = document.createElement('span');
    stateTag.className = `job-state state-${job.state}`;
    stateTag.textContent = job.state;
    state.append(stateTag);
    const values = [
      job.taskType,
      job.privacyLevel,
      job.providerClass || 'pending',
      `${job.attempts}/${job.maxAttempts}`,
      new Date(job.createdAt).toLocaleTimeString('zh-CN', { hour12: false })
    ];
    row.append(state, ...values.map((value) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      return cell;
    }));
    jobList.append(row);
  });
}

async function loadAiOverview() {
  if (aiRefreshInFlight) return;
  aiRefreshInFlight = true;
  aiRefreshState.textContent = 'SYNCING';
  try {
    const overview = await getJson('/api/ai/overview');
    const { metrics } = overview;
    document.querySelector('#metric-workers').textContent = metrics.workers.online;
    document.querySelector('#metric-workers-offline').textContent = `${metrics.workers.offline} offline`;
    document.querySelector('#metric-queue').textContent = metrics.jobs.queued;
    document.querySelector('#metric-leased').textContent = `${metrics.jobs.leased} leased`;
    document.querySelector('#metric-latency').textContent = formatDuration(metrics.attempts.inferenceMsAvg);
    document.querySelector('#metric-queue-time').textContent = `${formatDuration(metrics.attempts.queueMsAvg)} queue`;
    document.querySelector('#metric-fallback').textContent = `${metrics.attempts.fallbackTotal} / ${metrics.attempts.retryTotal}`;
    document.querySelector('#metric-cost').textContent = `${formatCost(metrics.attempts.costMicrousdTotal)} reported`;
    renderWorkers(overview.workers || []);
    renderJobs(overview.jobs || []);
    aiRefreshState.textContent = `SYNCED ${new Date(overview.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch (error) {
    aiRefreshState.textContent = 'CONTROL PLANE OFFLINE';
    workerList.replaceChildren();
    const message = document.createElement('p');
    message.className = 'muted';
    message.textContent = error.message;
    workerList.append(message);
  } finally {
    aiRefreshInFlight = false;
  }
}

function syncAiPolicyControls() {
  const task = document.querySelector('#ai-task').value;
  const privacy = document.querySelector('#ai-privacy');
  const provider = document.querySelector('#ai-provider');
  const localOnly = ['person-detection', 'face-identity'].includes(task);
  if (localOnly) privacy.value = 'local-only';
  privacy.disabled = localOnly;
  [...provider.options].forEach((option) => {
    option.disabled = localOnly && option.value === 'external';
  });
  if (localOnly && provider.value === 'external') provider.value = '';
}

dispatchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  dispatchMessage.textContent = '正在写入持久队列。';
  const data = Object.fromEntries(new FormData(dispatchForm));
  if (!data.preferredProvider) delete data.preferredProvider;
  data.payload = data.taskType === 'event-classification'
    ? { source: 'synthetic-ui', personCount: 1, durationSeconds: 18, zone: 'entry' }
    : { source: 'synthetic-ui', frameRef: `synthetic://dashboard/${Date.now()}` };
  if (data.taskType === 'scene-description') data.budgetMicrousd = 5_000;
  try {
    const job = await getJson('/api/ai/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
    });
    dispatchMessage.textContent = `${job.taskType} 已入队 // ${job.id.slice(0, 8)}`;
    await loadAiOverview();
  } catch (error) {
    dispatchMessage.textContent = error.message;
  }
});

function setCameraForm(cameraId) {
  const camera = settingsData?.cameras?.find((item) => item.id === cameraId);
  if (!camera) return;
  document.querySelector('#resolution').value = camera.resolution;
  document.querySelector('#fps').value = camera.fps;
  document.querySelector('#bitrate').value = camera.bitrate;
  cameraMessage.textContent = camera.cameraApply?.detail || (camera.enabled ? '等待保存' : '该机位尚未接入');
}

async function loadSettings() {
  try {
    settingsData = await getJson('/api/settings');
    document.querySelector('#retention-days').value = settingsData.storage.retentionDays;
    populateSelect(document.querySelector('#resolution'), settingsData.options.resolutions);
    populateSelect(document.querySelector('#fps'), settingsData.options.fps, (value) => `${value} FPS`);
    populateSelect(document.querySelector('#bitrate'), settingsData.options.bitrates, (value) => `${value.replace('k', '')} kbps`);
    populateCameraSelect(document.querySelector('#settings-camera'), document.querySelector('#settings-camera').value || selectedCameraId);
    setCameraForm(document.querySelector('#settings-camera').value);
    settingsState.textContent = settingsData.controlConfigured ? 'CONTROL LINK ONLINE' : 'CONTROL LINK PENDING';
    configNote.textContent = settingsData.controlConfigured
      ? '存储策略由 NAS / Docker 管理；分辨率、帧率和码率按机位下发到采集端。'
      : '存储策略可以立即保存；采集端控制服务尚未配置，机位参数会保存但暂不应用。';
  } catch (error) {
    settingsState.textContent = 'LOAD ERROR';
    cameraMessage.textContent = error.message;
  }
}

function renderRecordings(items) {
  recordingList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'muted empty-list';
    empty.textContent = '这一天没有找到录像。';
    recordingList.append(empty);
    return;
  }
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recording-item';
    const description = document.createElement('span');
    const title = document.createElement('strong');
    const time = document.createElement('span');
    const meta = document.createElement('span');
    title.textContent = item.cameraName;
    time.className = 'recording-time';
    time.textContent = item.timeRange;
    meta.className = 'recording-meta';
    meta.textContent = formatBytes(item.size);
    description.append(title, time);
    button.append(description, meta);
    button.addEventListener('click', () => {
      document.querySelectorAll('.recording-item').forEach((element) => element.classList.remove('selected'));
      button.classList.add('selected');
      playRecording(item);
    });
    recordingList.append(button);
  });
}

function stopHistory() {
  historyVersion += 1;
  historyRequest?.abort();
  historyPlayer?.destroy();
  historyPlayer = undefined;
  historyVideo.onplaying = null;
  historyVideo.onerror = null;
  historyVideo.pause();
  historyVideo.removeAttribute('src');
  historyVideo.load();
}

function historyState(title, detail, retry = false) {
  playbackEmpty.hidden = false;
  playbackEmpty.querySelector('strong').textContent = title;
  playbackEmpty.querySelector('span').textContent = detail;
  document.querySelector('#retry-playback').hidden = !retry;
}

async function playRecording(item) {
  stopHistory();
  selectedRecording = item;
  downloadButton.disabled = false;
  downloadStatus.hidden = true;
  playbackCaption.textContent = `${item.cameraName} // ${item.date} // ${item.timeRange} // ${formatBytes(item.size)}`;
  const version = historyVersion;
  historyRequest = new AbortController();
  const signal = AbortSignal.any([historyRequest.signal, AbortSignal.timeout(150000)]);
  historyState('准备回放', '正在生成可播放片段…');
  const fail = (message) => {
    if (version !== historyVersion) return;
    historyPlayer?.destroy();
    historyPlayer = undefined;
    historyState('暂时无法播放', message, true);
  };
  try {
    const query = new URLSearchParams({ cameraId: item.cameraId, id: item.id });
    let job = await getJson(`/api/playback?${query}`, { signal });
    while (job.status === 'preparing') {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (version !== historyVersion) return;
      job = await getJson(`/api/playback/status?token=${encodeURIComponent(job.token)}`, { signal });
    }
    if (version !== historyVersion) return;
    if (job.status !== 'ready') throw new Error(job.detail);
    historyState('加载回放', '正在缓冲视频…');
    const playbackTimer = setTimeout(() => fail('视频加载超时，请重试'), 30000);
    const onPlaying = () => {
      clearTimeout(playbackTimer);
      if (version === historyVersion) playbackEmpty.hidden = true;
    };
    const play = () => historyVideo.play().catch(() => {
      clearTimeout(playbackTimer);
      if (version === historyVersion) historyState('等待播放', '点击重试播放', true);
    });
    historyVideo.onplaying = onPlaying;
    historyVideo.onerror = () => { clearTimeout(playbackTimer); fail('视频解码失败，请重试'); };
    if (window.Hls?.isSupported()) {
      const player = new window.Hls({ lowLatencyMode: false, maxBufferLength: 12, maxMaxBufferLength: 24, backBufferLength: 12 });
      historyPlayer = player;
      player.on(window.Hls.Events.MEDIA_ATTACHED, () => player.loadSource(job.url));
      player.on(window.Hls.Events.MANIFEST_PARSED, play);
      player.on(window.Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && version === historyVersion) {
          clearTimeout(playbackTimer);
          fail('视频片段加载失败，请重试');
        }
      });
      player.attachMedia(historyVideo);
    } else if (historyVideo.canPlayType('application/vnd.apple.mpegurl')) {
      historyVideo.src = job.url;
      historyVideo.load();
      play();
    } else {
      clearTimeout(playbackTimer);
      fail('当前浏览器不支持此回放格式');
    }
  } catch (error) {
    if (version === historyVersion) fail(error.name === 'TimeoutError' ? '回放准备超时，请重试' : error.message);
  }
}

async function loadRecordings() {
  stopHistory();
  selectedRecording = undefined;
  downloadButton.disabled = true;
  historyState('选择录像', '选择需要回放的时间段');
  if (!recordingDate.value) recordingDate.value = new Date().toLocaleDateString('en-CA');
  const message = document.createElement('p');
  message.className = 'muted empty-list';
  message.textContent = '正在读取录像目录……';
  recordingList.replaceChildren(message);
  try {
    const cameraId = recordingCamera.value || selectedCameraId;
    const result = await getJson(`/api/recordings?cameraId=${encodeURIComponent(cameraId)}&date=${encodeURIComponent(recordingDate.value)}`);
    renderRecordings(result.items || []);
  } catch (error) {
    message.textContent = error.message;
    recordingList.replaceChildren(message);
  }
}

async function downloadRecording() {
  if (!selectedRecording) return;
  const confirmed = window.confirm(`确认下载 ${selectedRecording.cameraName} ${selectedRecording.date} ${selectedRecording.timeRange}？`);
  if (!confirmed) return;
  downloadButton.disabled = true;
  downloadStatus.hidden = false;
  downloadProgress.value = 0;
  downloadPercent.textContent = '0%';
  try {
    const response = await fetch(selectedRecording.url);
    if (!response.ok || !response.body) throw new Error(`下载失败：${response.status}`);
    const total = Number(response.headers.get('content-length')) || selectedRecording.size;
    const reader = response.body.getReader();
    const fileName = `${selectedRecording.cameraName}_${selectedRecording.date}_${selectedRecording.startTime.replaceAll(':', '-')}.mp4`;
    let writable;
    let chunks = [];
    if ('showSaveFilePicker' in window) {
      const fileHandle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }]
      });
      writable = await fileHandle.createWritable();
    }
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (writable) await writable.write(value);
      else chunks.push(value);
      loaded += value.byteLength;
      const percent = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      downloadProgress.value = percent;
      downloadPercent.textContent = `${percent}%`;
    }
    if (writable) {
      await writable.close();
    } else {
      const blobUrl = URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    }
    downloadPercent.textContent = '已完成';
  } catch (error) {
    downloadPercent.textContent = error.name === 'AbortError' ? '已取消' : error.message;
  } finally {
    downloadButton.disabled = false;
  }
}

storageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  storageMessage.textContent = '保存中……';
  try {
    const result = await getJson('/api/settings/storage', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retentionDays: Number(document.querySelector('#retention-days').value) })
    });
    storageMessage.textContent = result.detail;
    await loadSettings();
  } catch (error) {
    storageMessage.textContent = error.message;
  }
});

cameraForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  cameraMessage.textContent = '保存中……';
  const data = Object.fromEntries(new FormData(cameraForm));
  data.fps = Number(data.fps);
  try {
    const result = await getJson('/api/settings/camera', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data)
    });
    cameraMessage.textContent = result.detail;
    await loadSettings();
  } catch (error) {
    cameraMessage.textContent = error.message;
  }
});

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => activateView(tab.dataset.view)));
document.querySelector('#live-camera').addEventListener('change', () => switchLiveCamera().catch((error) => setEmpty('ERROR', error.message)));
document.querySelector('#settings-camera').addEventListener('change', (event) => setCameraForm(event.target.value));
document.querySelector('#recording-camera').addEventListener('change', loadRecordings);
document.querySelector('#refresh-recordings').addEventListener('click', loadRecordings);
recordingDate.addEventListener('change', loadRecordings);
connectButton.addEventListener('click', () => {
  resetPlayback();
  connectLive().catch((error) => setEmpty('ERROR', error.message));
});
downloadButton.addEventListener('click', downloadRecording);
document.querySelector('#retry-playback').addEventListener('click', () => {
  if (selectedRecording) playRecording(selectedRecording);
});
document.querySelector('#refresh-ai').addEventListener('click', loadAiOverview);
document.querySelector('#ai-task').addEventListener('change', syncAiPolicyControls);

await loadCameras();
await loadConfig();
await loadSettings();
await refreshStatus();
syncAiPolicyControls();
setInterval(refreshStatus, 10000);
setInterval(() => {
  if (activeView === 'ai') loadAiOverview();
}, 3000);
