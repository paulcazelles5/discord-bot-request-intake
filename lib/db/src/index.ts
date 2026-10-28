import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

/**
 * Lazy DB init so the Discord bot can call client.login() even when
 * DATABASE_URL is missing or the DB is not ready yet (common on Railway).
 * Accessing `db` without DATABASE_URL still throws a clear error.
 */
let _pool: pg.Pool | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL must be set. On Railway: add a PostgreSQL plugin and link DATABASE_URL to this service.",
    );
  }
  _pool = new Pool({ connectionString: url });
  return _pool;
}

function getDb() {
  if (_db) return _db;
  _db = drizzle(getPool(), { schema });
  return _db;
}

// Proxy so existing `import { db } from "@workspace/db"` keeps working,
// but connection is only opened on first real query — not at import time.
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop, receiver) {
    const real = getDb() as object;
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop, receiver) {
    const real = getPool() as object;
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export * from "./schema";
