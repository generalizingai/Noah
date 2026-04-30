import Redis from 'ioredis';

let _redis: Redis | null = null;

/** REDIS_DB_HOST may be 'hostname:port' or just 'hostname'. Parse both. */
function parseRedisHostPort(): { host: string; port: number } | null {
  const raw = process.env.REDIS_DB_HOST;
  if (!raw) return null;
  const colonIdx = raw.lastIndexOf(':');
  if (colonIdx > 0) {
    const maybePort = parseInt(raw.slice(colonIdx + 1), 10);
    if (!isNaN(maybePort)) {
      return { host: raw.slice(0, colonIdx), port: maybePort };
    }
  }
  const envPort = process.env.REDIS_DB_PORT;
  return { host: raw, port: envPort ? parseInt(envPort, 10) : 6379 };
}

function getRedis(): Redis | null {
  if (_redis) return _redis;

  const parsed = parseRedisHostPort();
  const password = process.env.REDIS_DB_PASSWORD;

  if (!parsed) {
    console.warn('REDIS_DB_HOST not set — Redis cache will be skipped');
    return null;
  }

  _redis = new Redis({ host: parsed.host, port: parsed.port, password: password || undefined, lazyConnect: true });
  _redis.on('error', (err) => console.error('Redis error:', err.message));
  return _redis;
}

/**
 * Read a JSON value from Redis. Returns null if Redis is unavailable,
 * the key is missing, or the stored value can't be parsed. Errors are
 * logged but never thrown — callers should treat this as a best-effort
 * cache read and fall back to the source of truth.
 */
export async function getJsonCache<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`Redis get ${key} failed:`, err);
    return null;
  }
}

/**
 * Write a JSON value to Redis with a TTL (in seconds). Fail-open: any
 * serialization or transport error is logged and swallowed.
 */
export async function setJsonCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    console.error(`Redis set ${key} failed:`, err);
  }
}

/**
 * Delete the enforcement stage cache for a user.
 * Matches backend's invalidate_enforcement_cache() in utils/fair_use.py.
 * Fail-open: errors are logged but do not block the admin action.
 */
export async function invalidateEnforcementCache(uid: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.del(`fair_use:stage:${uid}`);
  } catch (err) {
    console.error('Failed to invalidate enforcement cache:', err);
  }
}
