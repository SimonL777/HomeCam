import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { selectWorker, validateJobInput, validateWorkerInput, ValidationError } from './routing.js';

function json(value) {
  return JSON.stringify(value);
}

function parse(value, fallback) {
  try {
    return value === null || value === undefined ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function iso(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function asJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    cameraId: row.camera_id,
    eventId: row.event_id,
    taskType: row.task_type,
    privacyLevel: row.privacy_level,
    preferredProvider: row.preferred_provider,
    payload: parse(row.payload_json, {}),
    state: row.state,
    priority: row.priority,
    deadlineAt: iso(row.deadline_at),
    maxAttempts: row.max_attempts,
    attempts: row.attempts,
    budgetMicrousd: row.budget_microusd,
    providerClass: row.provider_class,
    workerId: row.lease_owner,
    modelVersion: row.model_version,
    fallbackCount: row.fallback_count,
    result: parse(row.result_json, null),
    error: row.error,
    availableAt: iso(row.available_at),
    leaseExpiresAt: iso(row.lease_expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at)
  };
}

function asWorker(row, now, offlineAfterMs) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    providerClass: row.provider_class,
    modelVersion: row.model_version,
    capabilities: parse(row.capabilities_json, { taskTypes: [] }),
    maxConcurrency: row.max_concurrency,
    currentLoad: row.current_load,
    availableMemoryMb: row.available_memory_mb,
    estimatedLatencyMs: row.estimated_latency_ms,
    costPerJobMicrousd: row.cost_per_job_microusd,
    metadata: parse(row.metadata_json, {}),
    status: now - row.last_heartbeat_at <= offlineAfterMs ? 'online' : 'offline',
    registeredAt: iso(row.registered_at),
    lastHeartbeatAt: iso(row.last_heartbeat_at)
  };
}

export class Store {
  constructor({ path = ':memory:', retryBaseMs = 1_000 } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.retryBaseMs = retryBaseMs;
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_class TEXT NOT NULL,
        model_version TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        max_concurrency INTEGER NOT NULL,
        current_load INTEGER NOT NULL DEFAULT 0,
        available_memory_mb INTEGER NOT NULL DEFAULT 0,
        estimated_latency_ms INTEGER NOT NULL,
        cost_per_job_microusd INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        registered_at INTEGER NOT NULL,
        last_heartbeat_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        request_hash TEXT,
        camera_id TEXT NOT NULL,
        event_id TEXT,
        task_type TEXT NOT NULL,
        privacy_level TEXT NOT NULL,
        preferred_provider TEXT,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        deadline_at INTEGER,
        max_attempts INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        budget_microusd INTEGER NOT NULL DEFAULT 0,
        provider_class TEXT,
        model_version TEXT,
        fallback_count INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error TEXT,
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (lease_owner) REFERENCES workers(id)
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(state, available_at, priority DESC, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(state, lease_expires_at);
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        provider_class TEXT NOT NULL,
        model_version TEXT NOT NULL,
        state TEXT NOT NULL,
        fallback_reason TEXT,
        queue_ms INTEGER NOT NULL,
        inference_ms INTEGER,
        estimated_cost_microusd INTEGER NOT NULL DEFAULT 0,
        actual_cost_microusd INTEGER,
        leased_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        FOREIGN KEY (job_id) REFERENCES jobs(id),
        FOREIGN KEY (worker_id) REFERENCES workers(id),
        UNIQUE(job_id, attempt_number)
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_job ON attempts(job_id, attempt_number);
    `);
  }

  close() {
    this.db.close();
  }

  registerWorker(input, now = Date.now(), offlineAfterMs = 30_000) {
    const worker = validateWorkerInput(input);
    this.db.prepare(`
      INSERT INTO workers (
        id, name, provider_class, model_version, capabilities_json, max_concurrency,
        current_load, available_memory_mb, estimated_latency_ms, cost_per_job_microusd,
        metadata_json, registered_at, last_heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        provider_class = excluded.provider_class,
        model_version = excluded.model_version,
        capabilities_json = excluded.capabilities_json,
        max_concurrency = excluded.max_concurrency,
        available_memory_mb = excluded.available_memory_mb,
        estimated_latency_ms = excluded.estimated_latency_ms,
        cost_per_job_microusd = excluded.cost_per_job_microusd,
        metadata_json = excluded.metadata_json,
        last_heartbeat_at = excluded.last_heartbeat_at
    `).run(
      worker.id, worker.name, worker.providerClass, worker.modelVersion, json(worker.capabilities),
      worker.maxConcurrency, worker.availableMemoryMb, worker.estimatedLatencyMs,
      worker.costPerJobMicrousd, json(worker.metadata), now, now
    );
    return this.getWorker(worker.id, now, offlineAfterMs);
  }

  heartbeat(workerId, input = {}, now = Date.now(), offlineAfterMs = 30_000) {
    const currentLoad = input.currentLoad === undefined ? null : Number(input.currentLoad);
    const availableMemoryMb = input.availableMemoryMb === undefined ? null : Number(input.availableMemoryMb);
    if (currentLoad !== null && (!Number.isInteger(currentLoad) || currentLoad < 0)) {
      throw new ValidationError('currentLoad must be a non-negative integer');
    }
    if (availableMemoryMb !== null && (!Number.isInteger(availableMemoryMb) || availableMemoryMb < 0)) {
      throw new ValidationError('availableMemoryMb must be a non-negative integer');
    }
    const result = this.db.prepare(`
      UPDATE workers SET
        last_heartbeat_at = ?,
        current_load = COALESCE(?, current_load),
        available_memory_mb = COALESCE(?, available_memory_mb)
      WHERE id = ?
    `).run(now, currentLoad, availableMemoryMb, workerId);
    if (!result.changes) throw new ValidationError('worker not found', 404);
    return this.getWorker(workerId, now, offlineAfterMs);
  }

  getWorker(workerId, now = Date.now(), offlineAfterMs = 30_000) {
    return asWorker(this.db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId), now, offlineAfterMs);
  }

  listWorkers(now = Date.now(), offlineAfterMs = 30_000) {
    return this.db.prepare(`
      SELECT * FROM workers
      ORDER BY CASE provider_class WHEN 'nas-cpu' THEN 1 WHEN 'home-gpu' THEN 2 ELSE 3 END, name
    `).all()
      .map((row) => asWorker(row, now, offlineAfterMs));
  }

  enqueue(input, { now = Date.now(), idempotencyKey = null } = {}) {
    const job = validateJobInput(input, now);
    const hash = requestHash(job);
    if (idempotencyKey) {
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) {
        throw new ValidationError('Idempotency-Key must be 1 to 200 characters');
      }
      const existing = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        if (existing.request_hash !== hash) throw new ValidationError('Idempotency-Key was reused with a different request', 409);
        return { job: asJob(existing), created: false };
      }
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO jobs (
        id, idempotency_key, request_hash, camera_id, event_id, task_type, privacy_level,
        preferred_provider, payload_json, state, priority, deadline_at, max_attempts,
        budget_microusd, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, idempotencyKey, hash, job.cameraId, job.eventId, job.taskType, job.privacyLevel,
      job.preferredProvider, json(job.payload), job.priority, job.deadlineAt, job.maxAttempts,
      job.budgetMicrousd, now, now, now
    );
    return { job: this.getJob(id), created: true };
  }

  getJob(jobId) {
    return asJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId));
  }

  listJobs({ state = null, limit = 50 } = {}) {
    const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = state
      ? this.db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC LIMIT ?').all(state, boundedLimit)
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(boundedLimit);
    return rows.map(asJob);
  }

  expireDeadlines(now = Date.now()) {
    return this.db.prepare(`
      UPDATE jobs SET state = 'dead-letter', error = 'deadline-exceeded', updated_at = ?, completed_at = ?
      WHERE state = 'queued' AND deadline_at IS NOT NULL AND deadline_at <= ?
    `).run(now, now, now).changes;
  }

  recoverExpiredLeases(now = Date.now()) {
    const expired = this.db.prepare(`
      SELECT * FROM jobs WHERE state = 'leased' AND lease_expires_at <= ? ORDER BY lease_expires_at
    `).all(now);
    if (!expired.length) {
      this.expireDeadlines(now);
      return { requeued: 0, deadLettered: 0 };
    }
    let requeued = 0;
    let deadLettered = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of expired) {
        this.db.prepare(`
          UPDATE attempts SET state = 'expired', completed_at = ?, error = 'lease-expired'
          WHERE job_id = ? AND attempt_number = ? AND state = 'leased'
        `).run(now, row.id, row.attempts);
        this.db.prepare('UPDATE workers SET current_load = MAX(0, current_load - 1) WHERE id = ?').run(row.lease_owner);
        const canRetry = row.attempts < row.max_attempts && (row.deadline_at === null || row.deadline_at > now);
        if (canRetry) {
          const delay = this.retryBaseMs * (2 ** Math.max(0, row.attempts - 1));
          this.db.prepare(`
            UPDATE jobs SET state = 'queued', error = 'lease-expired', available_at = ?,
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE id = ? AND state = 'leased'
          `).run(now + delay, now, row.id);
          requeued += 1;
        } else {
          this.db.prepare(`
            UPDATE jobs SET state = 'dead-letter', error = 'lease-expired', completed_at = ?,
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE id = ? AND state = 'leased'
          `).run(now, now, row.id);
          deadLettered += 1;
        }
      }
      this.expireDeadlines(now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { requeued, deadLettered };
  }

  claim(workerId, { now = Date.now(), leaseMs = 30_000, offlineAfterMs = 30_000 } = {}) {
    this.recoverExpiredLeases(now);
    const worker = this.getWorker(workerId, now, offlineAfterMs);
    if (!worker) throw new ValidationError('worker not found', 404);
    if (worker.status !== 'online') throw new ValidationError('worker is offline', 409);
    if (worker.currentLoad >= worker.maxConcurrency) return null;
    const workers = this.listWorkers(now, offlineAfterMs);
    const rows = this.db.prepare(`
      SELECT * FROM jobs
      WHERE state = 'queued' AND available_at <= ? AND (deadline_at IS NULL OR deadline_at > ?)
      ORDER BY priority DESC, created_at ASC LIMIT 200
    `).all(now, now);
    for (const row of rows) {
      const job = asJob(row);
      job.deadlineAt = row.deadline_at;
      const decision = selectWorker(job, workers, now);
      if (!decision.worker || decision.worker.id !== workerId) continue;
      const leaseToken = randomUUID();
      const attempt = row.attempts + 1;
      const leaseExpiresAt = now + leaseMs;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = this.db.prepare(`
          UPDATE jobs SET state = 'leased', attempts = ?, provider_class = ?, model_version = ?,
            fallback_count = fallback_count + ?, lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND state = 'queued'
        `).run(
          attempt, worker.providerClass, worker.modelVersion, decision.fallback ? 1 : 0,
          workerId, leaseToken, leaseExpiresAt, now, row.id
        );
        if (!result.changes) {
          this.db.exec('ROLLBACK');
          continue;
        }
        this.db.prepare('UPDATE workers SET current_load = current_load + 1 WHERE id = ?').run(workerId);
        this.db.prepare(`
          INSERT INTO attempts (
            job_id, attempt_number, worker_id, provider_class, model_version, state,
            fallback_reason, queue_ms, estimated_cost_microusd, leased_at
          ) VALUES (?, ?, ?, ?, ?, 'leased', ?, ?, ?, ?)
        `).run(
          row.id, attempt, workerId, worker.providerClass, worker.modelVersion,
          decision.reason, Math.max(0, now - row.created_at), worker.costPerJobMicrousd, now
        );
        this.db.exec('COMMIT');
        return { job: this.getJob(row.id), leaseToken, leaseExpiresAt: iso(leaseExpiresAt), route: decision.route };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    return null;
  }

  complete(jobId, input, now = Date.now()) {
    return this.finishLease(jobId, input, now, true);
  }

  fail(jobId, input, now = Date.now()) {
    return this.finishLease(jobId, input, now, false);
  }

  renewLease(jobId, input, { now = Date.now(), leaseMs = 30_000 } = {}) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!row) throw new ValidationError('job not found', 404);
    if (row.state !== 'leased') throw new ValidationError('job is not leased', 409);
    if (!input || input.workerId !== row.lease_owner || input.leaseToken !== row.lease_token) {
      throw new ValidationError('invalid lease owner or token', 409);
    }
    if (row.lease_expires_at <= now) throw new ValidationError('lease has expired', 409);
    const leaseExpiresAt = now + leaseMs;
    this.db.prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ? AND state = ?')
      .run(leaseExpiresAt, jobId, 'leased');
    return { jobId, leaseExpiresAt: iso(leaseExpiresAt) };
  }

  finishLease(jobId, input, now, succeeded) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!row) throw new ValidationError('job not found', 404);
    if (row.state !== 'leased') throw new ValidationError('job is not leased', 409);
    if (!input || input.workerId !== row.lease_owner || input.leaseToken !== row.lease_token) {
      throw new ValidationError('invalid lease owner or token', 409);
    }
    if (row.lease_expires_at <= now) throw new ValidationError('lease has expired', 409);
    const inferenceMs = Number(input.inferenceMs ?? Math.max(0, now - row.updated_at));
    const actualCostMicrousd = Number(input.actualCostMicrousd ?? 0);
    if (!Number.isInteger(inferenceMs) || inferenceMs < 0) throw new ValidationError('inferenceMs must be a non-negative integer');
    if (!Number.isInteger(actualCostMicrousd) || actualCostMicrousd < 0) throw new ValidationError('actualCostMicrousd must be a non-negative integer');
    const errorMessage = succeeded ? null : String(input.error || 'worker-failed').slice(0, 500);
    const retryable = !succeeded && input.retryable !== false && row.attempts < row.max_attempts && (row.deadline_at === null || row.deadline_at > now);
    const nextState = succeeded ? 'succeeded' : retryable ? 'queued' : 'dead-letter';
    const availableAt = retryable ? now + this.retryBaseMs * (2 ** Math.max(0, row.attempts - 1)) : row.available_at;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE attempts SET state = ?, inference_ms = ?, actual_cost_microusd = ?, completed_at = ?, error = ?
        WHERE job_id = ? AND attempt_number = ? AND state = 'leased'
      `).run(succeeded ? 'succeeded' : 'failed', inferenceMs, actualCostMicrousd, now, errorMessage, jobId, row.attempts);
      this.db.prepare('UPDATE workers SET current_load = MAX(0, current_load - 1) WHERE id = ?').run(row.lease_owner);
      this.db.prepare(`
        UPDATE jobs SET state = ?, result_json = ?, error = ?, available_at = ?,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
        WHERE id = ? AND state = 'leased'
      `).run(
        nextState, succeeded ? json(input.result ?? {}) : null, errorMessage, availableAt,
        now, nextState === 'queued' ? null : now, jobId
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getJob(jobId);
  }

  metrics(now = Date.now(), offlineAfterMs = 30_000) {
    const jobs = Object.fromEntries(this.db.prepare('SELECT state, COUNT(*) AS count FROM jobs GROUP BY state').all()
      .map((row) => [row.state, row.count]));
    const attempts = this.db.prepare(`
      SELECT COUNT(*) AS count,
        COALESCE(AVG(queue_ms), 0) AS queue_ms_avg,
        COALESCE(AVG(CASE WHEN state = 'succeeded' THEN inference_ms END), 0) AS inference_ms_avg,
        COALESCE(SUM(COALESCE(actual_cost_microusd, 0)), 0) AS cost_microusd_total,
        COALESCE(SUM(CASE WHEN fallback_reason IS NOT NULL THEN 1 ELSE 0 END), 0) AS fallback_total,
        COALESCE(SUM(CASE WHEN state IN ('failed', 'expired') THEN 1 ELSE 0 END), 0) AS retry_total
      FROM attempts
    `).get();
    const workers = this.listWorkers(now, offlineAfterMs);
    return {
      jobs: {
        queued: jobs.queued || 0,
        leased: jobs.leased || 0,
        succeeded: jobs.succeeded || 0,
        deadLetter: jobs['dead-letter'] || 0
      },
      workers: {
        online: workers.filter((worker) => worker.status === 'online').length,
        offline: workers.filter((worker) => worker.status === 'offline').length
      },
      attempts: {
        total: attempts.count,
        queueMsAvg: Math.round(attempts.queue_ms_avg),
        inferenceMsAvg: Math.round(attempts.inference_ms_avg),
        fallbackTotal: attempts.fallback_total,
        retryTotal: attempts.retry_total,
        costMicrousdTotal: attempts.cost_microusd_total
      }
    };
  }

  overview(now = Date.now(), offlineAfterMs = 30_000) {
    this.recoverExpiredLeases(now);
    return {
      generatedAt: iso(now),
      metrics: this.metrics(now, offlineAfterMs),
      workers: this.listWorkers(now, offlineAfterMs),
      jobs: this.listJobs({ limit: 30 })
    };
  }
}
