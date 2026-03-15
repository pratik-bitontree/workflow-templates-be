/**
 * Redis connection options. When REDIS_URL is set (e.g. deployed Redis), it is used;
 * otherwise falls back to REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_DB.
 */
export interface RedisConnectionOptions {
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
      return {
        host: u.hostname,
        port: parseInt(u.port || '6379', 10),
        password: u.password ? decodeURIComponent(u.password) : undefined,
        db: parseInt((u.pathname || '/').slice(1) || '0', 10),
        maxRetriesPerRequest: null,
      };
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
