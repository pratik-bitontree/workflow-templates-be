import { RedisOptions } from 'ioredis';

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

/**
 * Eviction policy check is disabled. No CONFIG GET/SET is performed at startup.
 * If you need noeviction on Redis, configure it in the server (e.g. maxmemory-policy noeviction).
 */
export async function ensureRedisNoEviction(_env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // No-op: eviction policy check disabled.
}
