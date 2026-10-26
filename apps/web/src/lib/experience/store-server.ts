import "server-only";
import { Pool } from "pg";
import { ExperienceStore } from "@niho-experience/experience-store";

const globalPool = globalThis as typeof globalThis & { __nihoExperiencePool?: Pool };

/** No database URL means the new calendar stays unavailable during the migration. */
export function experiencePool(): Pool | null {
  const connectionString = process.env.EXPERIENCE_DATABASE_URL;
  if (!connectionString) return null;
  if (!globalPool.__nihoExperiencePool) {
    globalPool.__nihoExperiencePool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
  }
  return globalPool.__nihoExperiencePool;
}

export function experienceStore(): ExperienceStore | null {
  const pool = experiencePool();
  return pool ? new ExperienceStore(pool) : null;
}
