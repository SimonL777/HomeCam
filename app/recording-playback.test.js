import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { RecordingPlayback } from './recording-playback.js';

const run = promisify(execFile);

test('fragmented recording becomes seekable HLS without changing original', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'homecam-vod-test-'));
  const source = join(dir, 'camera.mp4');
  const cache = new RecordingPlayback({ root: join(dir, 'cache'), ttlMs: 1 });
  await cache.initialize();
  t.after(async () => { await cache.close(); await rm(dir, { recursive: true, force: true }); });
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15',
    '-t', '24', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p',
    '-movflags', 'empty_moov+frag_keyframe+default_base_moof', source]);
  const original = await readFile(source);
  const prepared = await cache.prepare(source);
  assert.equal(prepared.status, 'preparing');
  await cache.jobs.get(prepared.token).done;
  const ready = cache.status(prepared.token);
  assert.equal(ready.status, 'ready');
  assert.ok(Math.abs(ready.duration - 24) < 0.2);
  const playlist = await readFile(join(cache.jobs.get(ready.token).dir, 'index.m3u8'), 'utf8');
  assert.match(playlist, /#EXT-X-ENDLIST/);
  assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.ok([...playlist.matchAll(/#EXTINF:/g)].length >= 4);
  const info = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', join(cache.jobs.get(ready.token).dir, 'index.m3u8')])).stdout);
  assert.equal(info.streams[0].codec_name, 'h264');
  assert.equal(info.streams[0].width, 320);
  assert.deepEqual(await readFile(source), original);
  assert.equal((await cache.prepare(source)).token, ready.token);

  const web = createServer((req, res) => { void cache.serve(req, res, ready.token, req.url.slice(1)); });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  t.after(() => { web.closeAllConnections(); web.close(); });
  const base = `http://127.0.0.1:${web.address().port}`;
  assert.equal((await fetch(`${base}/index.m3u8`)).status, 200);
  const segment = await fetch(`${base}/seg_00000.m4s`);
  assert.equal(segment.status, 200);
  assert.ok(Number(segment.headers.get('content-length')) < original.length);
  await segment.arrayBuffer();
  assert.equal((await fetch(`${base}/%2e%2e%2fcamera.mp4`)).status, 404);

  // The last recorded part can be incomplete while the camera is writing.
  const partial = join(dir, 'partial.mp4');
  await writeFile(partial, original.subarray(0, original.length - 4096));
  const partialJob = await cache.prepare(partial);
  await cache.jobs.get(partialJob.token).done;
  assert.equal(cache.status(partialJob.token).status, 'ready');

  for (const job of cache.jobs.values()) job.usedAt = 0;
  await cache.cleanup();
  assert.equal(cache.jobs.size, 0);
  assert.equal((await stat(source)).size, original.length);
});

test('invalid recordings fail explicitly and capacity is bounded', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'homecam-vod-invalid-'));
  const file = join(dir, 'invalid.mp4');
  await writeFile(file, 'not a video');
  const cache = new RecordingPlayback({ root: join(dir, 'cache') });
  await cache.initialize();
  t.after(async () => { await cache.close(); await rm(dir, { recursive: true, force: true }); });
  const job = await cache.prepare(file);
  await cache.jobs.get(job.token).done;
  assert.equal(cache.status(job.token).status, 'error');
  assert.equal((await cache.prepare(file)).status, 'preparing');
  await cache.jobs.get(job.token).done;
  cache.maxBytes = 10;
  await assert.rejects(cache.prepare(file), /容量/);
});
