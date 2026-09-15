# ADR-001: SQLite-backed leased inference queue

## Status

Accepted for the HomeCam AI MVP.

## Context

The NAS must remain the always-on control plane while GPU workers may disappear
at any time. The queue therefore needs persistence, exclusive attempt ownership,
retry history, and abandoned-work recovery. The project should remain easy to
run on a home NAS without operating a separate database or broker.

## Decision

Use SQLite WAL in the AI orchestrator and model execution as expiring leases.
Each claim atomically changes a queued job to leased, creates an attempt row,
and returns an opaque token. Completion requires the current worker and token.
Expired attempts are recorded and requeued with bounded exponential backoff.

## Consequences

- The queue survives orchestrator and container restarts.
- The failover behavior is locally demonstrable with no infrastructure service.
- The scheduler is intentionally single-node and optimized for modest event volume.
- Execution is at least once, so provider adapters need idempotency.
- Horizontal control-plane scaling requires a transactional shared database.
