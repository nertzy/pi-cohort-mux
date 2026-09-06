export const REGISTRATION_PROTOCOL_VERSION = 1;
export const REGISTRATION_HUB_KEY = "pi-cohort.registration-spike.backends.v1";

function hub() {
  const key = Symbol.for(REGISTRATION_HUB_KEY);
  const existing = globalThis[key];
  if (existing === undefined) {
    const created = { version: REGISTRATION_PROTOCOL_VERSION, backends: new Map() };
    globalThis[key] = created;
    return created;
  }
  if (!existing || typeof existing !== "object" || existing.version !== REGISTRATION_PROTOCOL_VERSION || !(existing.backends instanceof Map)) {
    throw new Error(`Unsupported registration hub version at Symbol.for("${REGISTRATION_HUB_KEY}").`);
  }
  return existing;
}

function validateBackend(backend) {
  if (!backend || typeof backend !== "object" || typeof backend.name !== "string" || backend.name.trim() !== backend.name || backend.name.length === 0) {
    throw new Error("Backend must have a non-empty trimmed name.");
  }
  return backend;
}

export function registerBackend(backend) {
  const validated = validateBackend(backend);
  const current = hub();
  if (current.backends.has(validated.name)) throw new Error(`Backend '${validated.name}' is already registered.`);
  current.backends.set(validated.name, validated);
  return () => {
    if (current.backends.get(validated.name) === validated) current.backends.delete(validated.name);
  };
}

export function listBackends() {
  return [...hub().backends.values()].sort((left, right) => left.name.localeCompare(right.name));
}
