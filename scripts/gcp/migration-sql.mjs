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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
