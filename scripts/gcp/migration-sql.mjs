// The SQL one migration run sends: the file's statements and its ledger row in a single transaction, so a
// connection drop or a stopped process leaves either both or neither (never a changed schema without its record).

const OWN_TRANSACTION = /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|ABORT)\s*;\s*$/im;
const WRAPPER_BEGIN = /^(?:\s*--[^\n]*\n|\s*\n)*\s*BEGIN\s*;[ \t]*\r?\n/i;
const WRAPPER_COMMIT = /\r?\n[ \t]*COMMIT\s*;(?:\s*--[^\n]*)?\s*$/i;

/**
 * Migration files wrap themselves in BEGIN; ... COMMIT;. Those two outer statements are replaced by one
 * transaction that also holds the ledger insert. A file with only one of them, or with transaction control
 * anywhere else, is refused: the run could not tell what is atomic.
 */
export function migrationBody(name, source) {
  const begin = WRAPPER_BEGIN.exec(source);
  const commit = WRAPPER_COMMIT.exec(source);
  if (!begin && !commit) {
    assert(!OWN_TRANSACTION.test(source), `${name} controls its own transaction without wrapping itself in BEGIN; ... COMMIT;`);
    return source;
  }
  assert(begin && commit && commit.index >= begin[0].length, `${name} must start with BEGIN; and end with COMMIT;`);
  const body = source.slice(begin[0].length, commit.index);
  assert(!OWN_TRANSACTION.test(body), `${name} has transaction control inside its BEGIN; ... COMMIT; block`);
  return body;
}

/** One simple-query string: BEGIN; <file>; INSERT INTO <ledger>; COMMIT; The caller rolls back if it fails. */
export function atomicMigrationSql({ name, source, ledger, sha256, escapeLiteral }) {
  return [
    "BEGIN;",
    migrationBody(name, source),
    `INSERT INTO ${ledger} (name,sha256) VALUES (${escapeLiteral(name)},${escapeLiteral(sha256)});`,
    "COMMIT;",
  ].join("\n");
}

/**
 * The files a run applies, in name order: every file not in the ledger. A pending file that sorts before the
 * last applied one stops the run, unless the operator names it in `allowOutOfOrder` after checking that it
 * changes nothing the later applied files depend on (a file merged after a later one was already applied).
 * A named file that is not pending, or a pending file out of order that is not named, still stops the run.
 */
export function pendingMigrations({ files, applied, allowOutOfOrder = [] }) {
  const recorded = new Set(applied);
  const pending = [...files].sort().filter((name) => !recorded.has(name));
  const lastApplied = [...recorded].sort().at(-1);
  const allowed = new Set(allowOutOfOrder);
  for (const name of allowed) {
    assert(pending.includes(name), `EXPERIENCE_DB_ALLOW_OUT_OF_ORDER names ${name}, which is not a pending migration`);
  }
  const outOfOrder = lastApplied === undefined ? [] : pending.filter((name) => name < lastApplied);
  const unexpected = outOfOrder.filter((name) => !allowed.has(name));
  assert(unexpected.length === 0, "A pending migration sorts before an applied one; resolve the ordering by hand");
  for (const name of allowed) {
    assert(outOfOrder.includes(name), `EXPERIENCE_DB_ALLOW_OUT_OF_ORDER names ${name}, which is not out of order`);
  }
  return { pending, outOfOrder };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
