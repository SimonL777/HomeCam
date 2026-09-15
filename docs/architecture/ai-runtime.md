# AI Runtime Architecture

## Purpose

The AI Runtime turns HomeCam's existing video product into a small,
interview-defensible inference platform. It is designed for a common home-lab
constraint: the NAS is always on, while the strongest GPU is available only
when another machine is running.

The current repository implements the control-plane behavior and synthetic
providers. Real computer-vision and hosted-model adapters remain explicit
extension points.

## Ownership boundaries

| Component | Owns | Does not own |
|---|---|---|
| Raspberry Pi | V4L2 capture, H.264 encode, RTSP publish | Recording, model routing |
| MediaMTX | Ingest auth, live media, recordings | User UI, inference |
| HomeCam web | Browser auth, media proxy, AI API gateway | Queue state, model execution |
| AI orchestrator | Job state, policy, leases, retry, metrics | Video capture, model code |
| AI worker | Provider adapter and one leased attempt | Global scheduling policy |

## Durable model

The orchestrator uses Node.js built-in SQLite in WAL mode. The single-node NAS
control plane does not require Redis or Postgres to demonstrate durable
semantics, and the store can later be replaced behind the same API.

### Job

- camera and optional event ID;
- task type and privacy level;
- preferred provider class;
- deadline, priority, attempt budget, and cost budget;
- opaque provider payload and result;
- queue, lease, retry, completion, and dead-letter state.

### Worker

- stable worker ID and provider class;
- supported task types and model version;
- maximum concurrency and current load;
- available memory, estimated latency, and estimated per-job cost;
- registration and last-heartbeat timestamps.

### Attempt

Every lease creates an immutable attempt number containing the selected worker,
provider, model version, queue time, fallback reason, latency, cost, and final
attempt state. This separates a logical job from its execution history.

## Routing algorithm

For each queued job, the scheduler:

1. Loads the task's allowed provider order.
2. Moves an allowed preferred provider to the front.
3. Removes offline or saturated workers.
4. Removes workers without the required task capability.
5. Applies the privacy policy before considering external workers.
6. Removes workers that cannot meet the remaining deadline.
7. Removes workers whose estimated cost exceeds the job budget.
8. Selects by provider order, normalized load, latency, then free memory.

The preferred provider cannot override privacy or capability policy. When the
selected provider class is not first in the route, the attempt records a
fallback reason and increments the job fallback count.

## Privacy invariants

`person-detection` and `face-identity` accept only `local-only` jobs. External
workers cannot advertise either task. Both validation layers are covered by
tests so a caller cannot bypass the rule by changing only one field.

`scene-description` may use an external provider only with
`external-allowed`. `event-classification` may use metadata externally when the
job is `metadata-only`; the event producer must not place frame or recording
data in that payload.

Provider implementations should receive short-lived, least-privilege media
references rather than filesystem paths or full recordings. Redaction,
consent, encryption, and provider-specific retention controls are required
before a real external adapter is considered production-ready.

## Lease and recovery semantics

- A worker polls for work and receives an opaque lease token.
- Completion or failure requires the exact worker ID and lease token.
- A live worker renews leases alongside its heartbeat; an already expired lease
  cannot be renewed or committed even before the sweeper observes it.
- A worker crash leaves the job leased until its deadline.
- The sweeper marks the attempt expired and decrements worker load.
- The job returns to the queue with exponential delay when attempts remain.
- Expired deadlines or exhausted attempts enter `dead-letter`.
- An idempotency key prevents duplicate ingestion for the same camera event.

This is at-least-once execution. Provider adapters must be idempotent or use
the job ID as their downstream idempotency key.

## HTTP surface

All endpoints except `/healthz` require `Authorization: Bearer ...`.

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/v1/jobs` | Enqueue an idempotent inference job. |
| `GET` | `/v1/jobs` | Inspect recent queue state. |
| `POST` | `/v1/workers/register` | Register or refresh capabilities. |
| `POST` | `/v1/workers/:id/heartbeat` | Report liveness, load, and memory. |
| `POST` | `/v1/workers/:id/claim` | Acquire one policy-selected lease. |
| `POST` | `/v1/jobs/:id/lease/renew` | Extend a live attempt lease. |
| `POST` | `/v1/jobs/:id/complete` | Commit a result for the current lease. |
| `POST` | `/v1/jobs/:id/fail` | Retry or dead-letter the current lease. |
| `GET` | `/v1/overview` | Dashboard snapshot. |
| `GET` | `/metrics` | Prometheus text metrics. |

## Synthetic worker contract

`src/worker.js` delegates model execution to a Provider interface. The default
synthetic Provider exercises registration, heartbeat, claim, lease renewal,
completion, failure, metrics, and routing without claiming to run a real model.

An optional `http-json` Provider sends a policy-approved job to one HTTPS
endpoint with `EXTERNAL_PROVIDER_TOKEN` as a Bearer token. It is a generic
integration contract, not a vendor-certified adapter. The external service must
return a `result` object and may return `actualCostMicrousd`. It is restricted to
workers registered as `external`; orchestration privacy policy still runs before
the worker can receive a job.

Recommended first adapters:

1. NAS CPU person detector producing bounding boxes and event timestamps.
2. GPU detector/embedding worker with model warm-up and VRAM reporting.
3. GPU visual-language worker for event descriptions.
4. External semantic provider that accepts only redacted, opt-in inputs.

## Operational demo

Run `npm run demo:failover` in `services/ai-orchestrator`. The script starts a
temporary control plane, simulates an abandoned GPU lease, recovers the job,
falls back to an external provider, verifies the face-identity privacy guard,
prints metrics, and removes all temporary state.

## Scaling path

SQLite is appropriate for one always-on NAS scheduler and modest camera event
volume. A multi-replica control plane would replace the store with PostgreSQL
and atomic `SKIP LOCKED` claims, add per-worker credentials, and use a message
broker or long polling to reduce idle claim traffic. The job, worker, attempt,
privacy, and lease contracts can remain unchanged.
