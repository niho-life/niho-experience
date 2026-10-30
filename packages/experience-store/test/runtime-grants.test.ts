import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

interface RuntimeGrant { readonly write: readonly string[]; readonly updateColumns?: readonly string[] }

const repo = new URL("../../../", import.meta.url);
const { RUNTIME_TABLE_GRANTS } = await import(new URL("scripts/gcp/experience-db-grants.mjs", repo).href) as {
  RUNTIME_TABLE_GRANTS: Readonly<Record<string, RuntimeGrant>>;
};

async function sourceFiles(dir: URL): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => `${entry.parentPath}/${entry.name}`);
}

/** SQL lives in template, double-, or single-quoted literals in the store and the web server code. */
async function sqlLiterals(): Promise<string[]> {
  const files = [
    ...await sourceFiles(new URL("packages/experience-store/src/", repo)),
    ...await sourceFiles(new URL("apps/web/src/", repo)),
  ];
  const literals: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/`([^`]*)`|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      if (/\b(INSERT INTO|UPDATE|DELETE FROM|FOR (?:UPDATE|SHARE|NO KEY UPDATE|KEY SHARE))\b/.test(value)) literals.push(value);
    }
  }
  return literals;
}

describe("Experience runtime grants", () => {
  it("declares exactly the tables the migrations create", async () => {
    const dir = new URL("packages/experience-store/migrations/", repo);
    const tables = new Set<string>();
    for (const name of (await readdir(dir)).filter((file) => /^\d{4}_.*\.sql$/.test(file))) {
      for (const match of (await readFile(new URL(name, dir), "utf8")).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)) tables.add(match[1]!);
    }
    assert.deepEqual(Object.keys(RUNTIME_TABLE_GRANTS).sort(), [...tables].sort());
  });

  it("covers every write, upsert, and row lock the code issues", async () => {
    const tables = new Set(Object.keys(RUNTIME_TABLE_GRANTS));
    const missing = new Set<string>();
    const need = (table: string, privilege: "INSERT" | "UPDATE" | "DELETE" | "LOCK") => {
      if (!tables.has(table)) return;
      const grant = RUNTIME_TABLE_GRANTS[table]!;
      const ok = privilege === "LOCK"
        ? grant.write.includes("UPDATE") || (grant.updateColumns?.length ?? 0) > 0
        : grant.write.includes(privilege);
      if (!ok) missing.add(`${privilege} ${table}`);
    };
    for (const sql of await sqlLiterals()) {
      for (const match of sql.matchAll(/INSERT INTO\s+([a-z_]+)/g)) {
        need(match[1]!, "INSERT");
        if (/ON CONFLICT[\s\S]*DO UPDATE/.test(sql)) need(match[1]!, "UPDATE");
      }
      for (const match of sql.matchAll(/\bUPDATE\s+([a-z_]+)\s/g)) need(match[1]!, "UPDATE");
      for (const match of sql.matchAll(/DELETE FROM\s+([a-z_]+)/g)) need(match[1]!, "DELETE");
      for (const lock of sql.matchAll(/FOR (?:UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)(?:\s+OF\s+([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*))?/g)) {
        const aliases = new Map<string, string>();
        for (const from of sql.matchAll(/(?:FROM|JOIN)\s+([a-z_]+)(?:\s+(?:AS\s+)?([a-z][a-z0-9_]*))?/g)) {
          if (!tables.has(from[1]!)) continue;
          aliases.set(from[1]!, from[1]!);
          if (from[2]) aliases.set(from[2], from[1]!);
        }
        const locked = lock[1] ? lock[1].split(",").map((alias) => aliases.get(alias.trim())) : [...new Set(aliases.values())];
        for (const table of locked) if (table) need(table, "LOCK");
      }
    }
    assert.deepEqual([...missing].sort(), []);
  });
});
