const PROVIDER_CLASSES = ['nas-cpu', 'home-gpu', 'external'];
const PRIVACY_LEVELS = ['local-only', 'metadata-only', 'external-allowed'];

export const TASK_POLICIES = Object.freeze({
  'person-detection': {
    providers: ['nas-cpu', 'home-gpu'],
    privacy: ['local-only']
  },
  'face-identity': {
    providers: ['home-gpu', 'nas-cpu'],
    privacy: ['local-only']
  },
  'scene-description': {
    providers: ['home-gpu', 'external', 'nas-cpu'],
    privacy: ['local-only', 'external-allowed']
  },
  'event-classification': {
    providers: ['nas-cpu', 'home-gpu', 'external'],
    privacy: PRIVACY_LEVELS
  }
});

export class ValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = statusCode;
  }
}

function asString(value, name, { optional = false, max = 160 } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${name} is required`);
  if (value.length > max) throw new ValidationError(`${name} is too long`);
  return value.trim();
}

function asInteger(value, name, minimum, maximum, defaultValue) {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidationError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function findMediaField(value, path = 'payload') {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = findMediaField(value[index], `${path}[${index}]`);
      if (nested) return nested;
    }
    return null;
  }
  const mediaKeys = new Set(['frame', 'frameref', 'recording', 'recordingref', 'image', 'imageurl', 'video', 'videourl', 'media', 'mediaref']);
  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (mediaKeys.has(key.toLowerCase())) return nestedPath;
    const nested = findMediaField(nestedValue, nestedPath);
    if (nested) return nested;
  }
  return null;
}

export function validateJobInput(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('job body must be an object');
  }
  const taskType = asString(input.taskType, 'taskType');
  const policy = TASK_POLICIES[taskType];
  if (!policy) throw new ValidationError(`unsupported taskType: ${taskType}`);
  const privacyLevel = input.privacyLevel || 'local-only';
  if (!PRIVACY_LEVELS.includes(privacyLevel)) throw new ValidationError(`unsupported privacyLevel: ${privacyLevel}`);
  if (!policy.privacy.includes(privacyLevel)) {
    throw new ValidationError(`${taskType} requires one of: ${policy.privacy.join(', ')}`, 422);
  }
  const preferredProvider = input.preferredProvider || null;
  if (preferredProvider && !PROVIDER_CLASSES.includes(preferredProvider)) {
    throw new ValidationError(`unsupported preferredProvider: ${preferredProvider}`);
  }
  if (preferredProvider && !policy.providers.includes(preferredProvider)) {
    throw new ValidationError(`${taskType} cannot route to ${preferredProvider}`, 422);
  }
  const externalEligible = privacyLevel === 'external-allowed'
    || (taskType === 'event-classification' && privacyLevel === 'metadata-only');
  if (preferredProvider === 'external' && !externalEligible) {
    throw new ValidationError(`${taskType} with ${privacyLevel} cannot prefer an external provider`, 422);
  }
  const deadlineAt = input.deadlineAt ? Date.parse(input.deadlineAt) : null;
  if (input.deadlineAt && !Number.isFinite(deadlineAt)) throw new ValidationError('deadlineAt must be an ISO-8601 timestamp');
  if (deadlineAt !== null && deadlineAt <= now) throw new ValidationError('deadlineAt must be in the future', 422);
  if (input.payload !== undefined && (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload))) {
    throw new ValidationError('payload must be an object');
  }
  const payload = input.payload || {};
  if (privacyLevel === 'metadata-only') {
    const exposed = findMediaField(payload);
    if (exposed) throw new ValidationError(`metadata-only payload cannot include media field ${exposed}`, 422);
  }
  return {
    cameraId: asString(input.cameraId || 'camera-01', 'cameraId'),
    eventId: asString(input.eventId, 'eventId', { optional: true }),
    taskType,
    privacyLevel,
    preferredProvider,
    deadlineAt,
    maxAttempts: asInteger(input.maxAttempts, 'maxAttempts', 1, 10, 3),
    priority: asInteger(input.priority, 'priority', -100, 100, 0),
    budgetMicrousd: asInteger(input.budgetMicrousd, 'budgetMicrousd', 0, 1_000_000_000, 0),
    payload
  };
}

export function validateWorkerInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('worker body must be an object');
  }
  const providerClass = asString(input.providerClass, 'providerClass');
  if (!PROVIDER_CLASSES.includes(providerClass)) throw new ValidationError(`unsupported providerClass: ${providerClass}`);
  const taskTypes = input.capabilities?.taskTypes;
  if (!Array.isArray(taskTypes) || !taskTypes.length) throw new ValidationError('capabilities.taskTypes must not be empty');
  for (const taskType of taskTypes) {
    if (!TASK_POLICIES[taskType]) throw new ValidationError(`unsupported worker taskType: ${taskType}`);
    if (!TASK_POLICIES[taskType].providers.includes(providerClass)) {
      throw new ValidationError(`${providerClass} is not permitted for ${taskType}`, 422);
    }
  }
  return {
    id: asString(input.id, 'id'),
    name: asString(input.name || input.id, 'name'),
    providerClass,
    modelVersion: asString(input.modelVersion || 'unreported', 'modelVersion'),
    capabilities: { taskTypes: [...new Set(taskTypes)] },
    maxConcurrency: asInteger(input.maxConcurrency, 'maxConcurrency', 1, 128, 1),
    availableMemoryMb: asInteger(input.availableMemoryMb, 'availableMemoryMb', 0, 1_000_000, 0),
    estimatedLatencyMs: asInteger(input.estimatedLatencyMs, 'estimatedLatencyMs', 1, 3_600_000, 1_000),
    costPerJobMicrousd: asInteger(input.costPerJobMicrousd, 'costPerJobMicrousd', 0, 1_000_000_000, 0),
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {}
  };
}

function routeOrder(job) {
  const route = [...TASK_POLICIES[job.taskType].providers];
  if (!job.preferredProvider) return route;
  return [job.preferredProvider, ...route.filter((provider) => provider !== job.preferredProvider)];
}

function externalIsAllowed(job) {
  if (job.privacyLevel === 'external-allowed') return true;
  return job.taskType === 'event-classification' && job.privacyLevel === 'metadata-only';
}

export function selectWorker(job, workers, now = Date.now()) {
  const route = routeOrder(job);
  const deadlineRemaining = job.deadlineAt === null ? null : job.deadlineAt - now;
  const eligible = workers.filter((worker) => {
    if (worker.status !== 'online' || worker.currentLoad >= worker.maxConcurrency) return false;
    if (!worker.capabilities.taskTypes.includes(job.taskType)) return false;
    if (!route.includes(worker.providerClass)) return false;
    if (worker.providerClass === 'external' && !externalIsAllowed(job)) return false;
    if (deadlineRemaining !== null && worker.estimatedLatencyMs > deadlineRemaining) return false;
    if (job.budgetMicrousd > 0 && worker.costPerJobMicrousd > job.budgetMicrousd) return false;
    return true;
  });
  eligible.sort((left, right) => {
    const provider = route.indexOf(left.providerClass) - route.indexOf(right.providerClass);
    if (provider) return provider;
    const load = (left.currentLoad / left.maxConcurrency) - (right.currentLoad / right.maxConcurrency);
    if (load) return load;
    if (left.estimatedLatencyMs !== right.estimatedLatencyMs) return left.estimatedLatencyMs - right.estimatedLatencyMs;
    return right.availableMemoryMb - left.availableMemoryMb;
  });
  const worker = eligible[0] || null;
  if (!worker) return { worker: null, route, fallback: false, reason: 'no-eligible-worker' };
  const selectedIndex = route.indexOf(worker.providerClass);
  return {
    worker,
    route,
    fallback: selectedIndex > 0,
    reason: selectedIndex > 0 ? `${route[0]} unavailable-or-ineligible` : null
  };
}
