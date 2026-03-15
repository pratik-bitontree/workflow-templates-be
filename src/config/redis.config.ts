import Redis, { RedisOptions } from 'ioredis';

/**
 * Redis connection options. When REDIS_URL is set (e.g. deployed Redis), it is used;
 * otherwise falls back to REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_DB.
 * Use rediss:// for TLS (required by Render and many managed Redis).
 */
export interface RedisConnectionOptions extends RedisOptions {
  host: string;
  port: number;
  password?: string;
  db: number;
  maxRetriesPerRequest?: null;
}

export function getRedisConnectionOptions(env: NodeJS.ProcessEnv = process.env): RedisConnectionOptions {
  const url = env.REDIS_URL;
  if (url) {
    try {
      const u = new URL(url);
      const useTls = u.protocol === 'rediss:';
      if (!useTls && (u.hostname.includes('upstash.io') || u.hostname.includes('render.com'))) {
        console.warn(
          '[Redis] REDIS_URL uses redis:// but Upstash/Render require TLS. Use rediss:// to avoid ECONNRESET.',
        );
      }
      const opts: RedisConnectionOptions = {
        host: u.hostname,
        port: parseInt(u.port || '6379', 10),
        password: u.password ? decodeURIComponent(u.password) : undefined,
        db: parseInt((u.pathname || '/').slice(1) || '0', 10),
        maxRetriesPerRequest: null,
      };
      if (useTls) {
        opts.tls = { rejectUnauthorized: true };
      }
      return opts;
    } catch (e) {
      throw new Error(`Invalid REDIS_URL: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    host: env.REDIS_HOST || 'localhost',
    port: parseInt(env.REDIS_PORT || '6379', 10),
    password: env.REDIS_PASSWORD || undefined,
    db: parseInt(env.REDIS_DB || '0', 10),
    maxRetriesPerRequest: null,
  };
}

const EVICTION_POLICY = 'noeviction';

/**
 * Set Redis eviction policy to noeviction so queue/job keys are never evicted.
 * Call at startup. If the server disallows CONFIG SET (e.g. some managed Redis), this no-ops and logs.
 * Uses REDIS_URL as-is when set so TLS (rediss://) is applied; avoids ECONNRESET on Render.
 */
export async function ensureRedisNoEviction(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let redis: Redis | null = null;
  try {
    if (env.REDIS_URL) {
      redis = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        lazyConnect: true,
      });
    } else {
      const opts = getRedisConnectionOptions(env);
      redis = new Redis({
        ...opts,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        lazyConnect: true,
      });
    }
    await redis.connect();
    const current = await redis.config('GET', 'maxmemory-policy');
    const policy = Array.isArray(current) ? current[1] : current;
    if (policy === EVICTION_POLICY) {
      return;
    }
    await redis.config('SET', 'maxmemory-policy', EVICTION_POLICY);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNRESET') || msg.includes('CONFIG')) {
      console.warn(
        `Redis: could not set maxmemory-policy to ${EVICTION_POLICY} (managed Redis may disallow CONFIG SET or require TLS).`,
      );
    } else {
      console.warn(`Redis: ensureRedisNoEviction failed:`, msg);
    }
  } finally {
    if (redis) {
      try {
        redis.disconnect();
      } catch {
        // ignore disconnect errors
      }
    }
  }
}
