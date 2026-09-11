import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

export class RecordingPlayback {
  constructor({ root = '/tmp/homecam-vod', ffmpeg = 'ffmpeg', maxBytes = 3 * 1024 ** 3, ttlMs = 30 * 60 * 1000 } = {}) {
    Object.assign(this, { root, ffmpeg, maxBytes, ttlMs });
    this.jobs = new Map();
    this.serial = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    for (const name of await readdir(this.root)) {
      if (/^job-[a-f0-9]{64}$/.test(name)) await rm(join(this.root, name), { recursive: true, force: true });
    }
    this.timer = setInterval(() => this.lock(() => this.cleanup()).catch(console.error), 60000);
    this.timer.unref();
  }

  lock(action) {
    const result = this.serial.then(action);
    this.serial = result.catch(() => {});
    return result;
  }

  describe(job) {
    return {
      token: job.token, status: job.status, duration: job.duration,
      detail: job.error || (job.status === 'ready' ? '回放已就绪' : '正在准备回放'),
      url: job.status === 'ready' ? `/playback/${job.token}/index.m3u8` : null
    };
  }

  async prepare(filePath) {
    return this.lock(async () => {
      const info = await stat(filePath);
      if (!info.isFile() || info.size === 0) throw new Error('录像文件不可用');
      const token = createHash('sha256').update(`${filePath}:${info.size}:${info.mtimeMs}`).digest('hex');
      const existing = this.jobs.get(token);
      if (existing?.status === 'error') await this.remove(existing);
      else if (existing) { existing.usedAt = Date.now(); return this.describe(existing); }
      await this.cleanup();
      if ([...this.jobs.values()].some((job) => job.status === 'preparing')) throw new Error('已有录像正在准备，请稍后重试');
      const reserved = Math.ceil(info.size * 1.1) + 1024 * 1024;
      if (reserved > this.maxBytes) throw new Error('这段录像超出回放缓存容量，请选择较短录像');
      const total = () => [...this.jobs.values()].reduce((sum, job) => sum + job.reserved, 0);
      const candidates = [...this.jobs.values()].sort((a, b) => a.usedAt - b.usedAt);
      for (const job of candidates) {
        if (total() + reserved <= this.maxBytes) break;
        if (job.readers === 0 && Date.now() - job.usedAt > 120000) await this.remove(job);
      }
      if (total() + reserved > this.maxBytes) throw new Error('回放缓存正在使用，请稍后重试');
      const job = { token, dir: join(this.root, `job-${token}`), status: 'preparing', usedAt: Date.now(), reserved, readers: 0 };
      await mkdir(job.dir);
      this.jobs.set(token, job);
      job.done = this.convert(job, filePath, info.size);
      return this.describe(job);
    });
  }

  async convert(job, filePath, size) {
    // A bounded pipe snapshots growing recordings without modifying their files.
    const input = createReadStream(filePath, { start: 0, end: size - 1 });
    const child = spawn(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0',
      '-map', '0:v:0', '-an', '-c:v', 'copy', '-f', 'hls', '-hls_time', '6',
      '-hls_playlist_type', 'vod', '-hls_list_size', '0', '-hls_segment_type', 'fmp4',
      '-hls_flags', 'independent_segments+temp_file', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', join(job.dir, 'seg_%05d.m4s'), join(job.dir, 'index.m3u8')
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    job.child = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    const inputDone = pipeline(input, child.stdin).catch(() => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr}`)));
      });
      const manifest = await readFile(join(job.dir, 'index.m3u8'), 'utf8');
      if (!manifest.includes('#EXT-X-ENDLIST')) throw new Error('incomplete playlist');
      job.duration = [...manifest.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
      if (!job.duration) throw new Error('no playable fragments');
      job.status = 'ready';
      job.usedAt = Date.now();
    } catch (error) {
      console.error('recording playback failed:', error.message);
      job.status = 'error';
      job.error = '录像准备失败，请重试或选择已结束的录像';
      job.reserved = 0;
      await rm(job.dir, { recursive: true, force: true });
    } finally {
      clearTimeout(timer);
      input.destroy();
      await inputDone;
      job.child = null;
    }
  }

  status(token) {
    const job = this.jobs.get(token);
    if (!job) return null;
    job.usedAt = Date.now();
    return this.describe(job);
  }

  async serve(request, response, token, name) {
    const job = this.jobs.get(token);
    if (!job || job.status !== 'ready' || !/^(index\.m3u8|init\.mp4|seg_\d+\.m4s)$/.test(name)) {
      response.writeHead(404); return response.end();
    }
    job.usedAt = Date.now();
    job.readers += 1;
    try {
      const path = join(job.dir, name);
      const info = await stat(path);
      response.writeHead(200, {
        'content-type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        'content-length': info.size, 'cache-control': 'private, max-age=60'
      });
      await pipeline(createReadStream(path), response);
    } catch {
      if (!response.headersSent) { response.writeHead(404); response.end(); }
      else response.destroy();
    } finally {
      job.readers -= 1;
      job.usedAt = Date.now();
    }
  }

  async remove(job) {
    this.jobs.delete(job.token);
    await rm(job.dir, { recursive: true, force: true });
  }

  async cleanup() {
    for (const job of this.jobs.values()) {
      if (job.status !== 'preparing' && job.readers === 0 && Date.now() - job.usedAt > this.ttlMs) await this.remove(job);
    }
  }

  async close() {
    clearInterval(this.timer);
    for (const job of this.jobs.values()) job.child?.kill('SIGKILL');
    await Promise.all([...this.jobs.values()].map((job) => job.done));
  }
}
