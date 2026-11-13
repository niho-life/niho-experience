import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreValidationError } from "../src/errors.ts";
import { HostAccountIdentities } from "../src/host-account-identities.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { HOST_INVITATION_LIMITS, HostInvitations, type HostInvitationLinkIssue } from "../src/host-invitations.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** ホストの招待リンク (#596, migration 0084): invite → email → open → NIHO sign-in → bind, against a real schema, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-14T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const browser = (label: string): Buffer => createHash("sha256").update(`synthetic-browser-${label}`, "utf8").digest();
const NIHO_A = "niho-user-synthetic-a";
const NIHO_B = "niho-user-synthetic-b";

type Sent = Extract<HostInvitationLinkIssue, { kind: "send" }>;

interface Context {
  readonly pool: Pool;
  readonly accounts: HostAccounts;
  readonly identities: HostAccountIdentities;
  readonly invitations: HostInvitations;
}

async function withInvitations(run: (context: Context) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "host_invitations", { max: 4 });
  try {
    await run({ pool: db.pool, accounts: new HostAccounts(db.pool), identities: new HostAccountIdentities(db.pool), invitations: new HostInvitations(db.pool) });
  } finally {
    await db.dispose();
  }
}

const provision = async (accounts: HostAccounts, email: string): Promise<string> => (await accounts.provisionHostAccount({ email, nowUtc: at(0) })).hostAccountId;

/** Ops invites at `offsetMs`; the mail job mints the link a minute later: the raw token the email carries. */
async function invite(context: Context, hostAccountId: string, offsetMs: number): Promise<Sent> {
  const created = await context.invitations.createInvitation({ hostAccountId, nowUtc: at(offsetMs) });
  assert.equal(created.kind, "created");
  const pending = await context.invitations.listPendingInvitations({ nowUtc: at(offsetMs + MINUTE), limit: 10 });
  assert.deepEqual(pending, [(created as { invitationId: string }).invitationId]);
  const issued = await context.invitations.issueInvitationLink({ invitationId: pending[0]!, nowUtc: at(offsetMs + MINUTE) });
  assert.equal(issued.kind, "send");
  return issued as Sent;
}

describe("host account invitations", () => {
  it("binds the NIHO account that comes back to the invited host account, and changes nothing the host account owns", async () => {
    await withInvitations(async (context) => {
      const { pool, accounts, identities, invitations } = context;
      // An OWNER registered in the email era: a provider, a membership and a session from an emailed link.
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-synthetic')");
      const host = await provision(accounts, "owner@example.com");
      assert.deepEqual(await accounts.grantProviderOwner({ providerId: "provider-synthetic", hostAccountId: host, nowUtc: at(0) }), { kind: "granted" });
      const before = {
        account: (await pool.query("SELECT * FROM host_accounts WHERE id = $1", [host])).rows,
        memberships: (await pool.query("SELECT * FROM provider_memberships WHERE niho_user_id = $1", [host])).rows,
        providers: await accounts.listProviderMemberships({ hostAccountId: host }),
      };

      const sent = await invite(context, host, HOUR);
      assert.match(sent.token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(sent.toEmail, "owner@example.com");
      assert.equal(sent.expiresAtUtc, at(HOUR + HOST_INVITATION_LIMITS.ttlDays * DAY));
      // The mail job mints a link once.
      const row = (await pool.query("SELECT id::text FROM host_account_invitations")).rows[0]!;
      assert.deepEqual(await invitations.issueInvitationLink({ invitationId: row.id as string, nowUtc: at(HOUR + 2 * MINUTE) }), { kind: "skip" });
      // Only the SHA-256 of the token is stored.
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM host_account_invitations WHERE token_hash = $1", [createHash("sha256").update(sent.token).digest()])).rows[0]!.n, 1);

      // The host opens the link (their browser), signs in at NIHO, and the NIHO account comes back to the same browser.
      assert.deepEqual(await invitations.openInvitation({ token: sent.token, browserBindingHash: browser("host"), nowUtc: at(2 * HOUR) }), { kind: "opened" });
      assert.deepEqual(await invitations.openInvitation({ token: sent.token, browserBindingHash: browser("host"), nowUtc: at(2 * HOUR + MINUTE) }), { kind: "opened" });
      assert.deepEqual(await invitations.acceptInvitation({ browserBindingHash: browser("host"), nihoUserId: NIHO_A, nowUtc: at(2 * HOUR + 2 * MINUTE) }), { kind: "accepted", hostAccountId: host });
      assert.deepEqual(await identities.readNihoIdentity({ hostAccountId: host }), { linkedAtUtc: at(2 * HOUR + 2 * MINUTE), lastLoginAtUtc: null, linkedVia: "INVITATION" });

      // The same host account opens the console with NIHO: the same person, the same roles.
      const opened = await identities.startSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(2 * HOUR + 2 * MINUTE), nowUtc: at(2 * HOUR + 3 * MINUTE) });
      assert.equal(opened.kind, "ok");
      assert.equal((opened as { hostAccountId: string }).hostAccountId, host);
      assert.deepEqual((await pool.query("SELECT * FROM provider_memberships WHERE niho_user_id = $1", [host])).rows, before.memberships);
      assert.deepEqual(await accounts.listProviderMemberships({ hostAccountId: host }), before.providers);
      assert.deepEqual((await pool.query("SELECT * FROM host_accounts WHERE id = $1", [host])).rows, before.account);
      assert.deepEqual((await pool.query("SELECT event_kind, via FROM host_account_identity_events WHERE host_account_id = $1", [host])).rows, [{ event_kind: "LINKED", via: "INVITATION" }]);

      // The invitation is used up: the link and the browser get nothing more, and no new invitation is needed.
      assert.deepEqual(await invitations.openInvitation({ token: sent.token, browserBindingHash: browser("host"), nowUtc: at(3 * HOUR) }), { kind: "used" });
      assert.deepEqual(await invitations.acceptInvitation({ browserBindingHash: browser("host"), nihoUserId: NIHO_A, nowUtc: at(3 * HOUR) }), { kind: "invalid" });
      assert.deepEqual(await invitations.createInvitation({ hostAccountId: host, nowUtc: at(3 * HOUR) }), { kind: "already-linked" });
    });
  });

  it("belongs to the first browser that opens it, and tells a link that ran out, was used or was replaced", async () => {
    await withInvitations(async (context) => {
      const { accounts, invitations, pool } = context;
      const host = await provision(accounts, "browser@example.com");
      const sent = await invite(context, host, 0);
      assert.deepEqual(await invitations.openInvitation({ token: sent.token, browserBindingHash: browser("first"), nowUtc: at(HOUR) }), { kind: "opened" });
      // Another browser (a mail app's, say) cannot take it over, and cannot accept for it either.
      assert.deepEqual(await invitations.openInvitation({ token: sent.token, browserBindingHash: browser("second"), nowUtc: at(HOUR + MINUTE) }), { kind: "other-browser" });
      assert.deepEqual(await invitations.acceptInvitation({ browserBindingHash: browser("second"), nihoUserId: NIHO_A, nowUtc: at(HOUR + 2 * MINUTE) }), { kind: "invalid" });
      // Unknown, malformed and made-up tokens are all just invalid.
      assert.deepEqual(await invitations.openInvitation({ token: "x".repeat(43), browserBindingHash: browser("first"), nowUtc: at(HOUR) }), { kind: "invalid" });
      assert.deepEqual(await invitations.openInvitation({ token: "short", browserBindingHash: browser("first"), nowUtc: at(HOUR) }), { kind: "invalid" });

      // It runs out after its days, opened or not.
      const late = at(HOST_INVITATION_LIMITS.ttlDays * DAY + 2 * HOUR);
      assert.deepEqual(await invitations.openInvitation({ token: sent.token, browserBindingHash: browser("first"), nowUtc: late }), { kind: "expired" });
      assert.deepEqual(await invitations.acceptInvitation({ browserBindingHash: browser("first"), nihoUserId: NIHO_A, nowUtc: late }), { kind: "invalid" });
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM host_account_identities")).rows[0]!.n, 0);

      // A new invitation replaces an open one: the old link says it ran out, the new one works.
      const fresh = await invite(context, host, 8 * DAY);
      const replacing = await invitations.createInvitation({ hostAccountId: host, nowUtc: at(8 * DAY + 2 * HOUR) });
      assert.equal(replacing.kind, "created");
      assert.equal((replacing as { superseded: boolean }).superseded, true);
      assert.deepEqual(await invitations.openInvitation({ token: fresh.token, browserBindingHash: browser("third"), nowUtc: at(8 * DAY + 3 * HOUR) }), { kind: "expired" });
      const mint = await invitations.listPendingInvitations({ nowUtc: at(8 * DAY + 3 * HOUR), limit: 10 });
      assert.equal(mint.length, 1);
      const reissued = await invitations.issueInvitationLink({ invitationId: mint[0]!, nowUtc: at(8 * DAY + 3 * HOUR) }) as Sent;
      assert.deepEqual(await invitations.openInvitation({ token: reissued.token, browserBindingHash: browser("third"), nowUtc: at(8 * DAY + 4 * HOUR) }), { kind: "opened" });
      // Ops can also end the open invitation.
      assert.equal(await invitations.revokeInvitation({ hostAccountId: host, nowUtc: at(8 * DAY + 5 * HOUR) }), true);
      assert.equal(await invitations.revokeInvitation({ hostAccountId: host, nowUtc: at(8 * DAY + 5 * HOUR) }), false);
      assert.deepEqual(await invitations.openInvitation({ token: reissued.token, browserBindingHash: browser("third"), nowUtc: at(8 * DAY + 6 * HOUR) }), { kind: "expired" });
    });
  });

  it("refuses a NIHO account bound elsewhere or a host account bound to another one, records it, and keeps the invitation usable", async () => {
    await withInvitations(async (context) => {
      const { accounts, identities, invitations, pool } = context;
      const first = await provision(accounts, "first@example.com");
      const second = await provision(accounts, "second@example.com");
      assert.deepEqual(await identities.linkNihoIdentity({ hostAccountId: first, nihoUserId: NIHO_A, proof: { kind: "OPS" }, nowUtc: at(MINUTE) }), { kind: "linked" });

      // The invited host signs in with the NIHO account another host account owns: refused, not used up.
      const sent = await invite(context, second, HOUR);
      await invitations.openInvitation({ token: sent.token, browserBindingHash: browser("second"), nowUtc: at(2 * HOUR) });
      assert.deepEqual(await invitations.acceptInvitation({ browserBindingHash: browser("second"), nihoUserId: NIHO_A, nowUtc: at(2 * HOUR + MINUTE) }), { kind: "identity-in-use" });
      assert.deepEqual((await pool.query("SELECT event_kind, via, reason FROM host_account_identity_events WHERE host_account_id = $1", [second])).rows, [{ event_kind: "LINK_REFUSED", via: "INVITATION", reason: "IDENTITY_IN_USE" }]);
      assert.equal(await identities.readNihoIdentity({ hostAccountId: second }), null);
      // With the right NIHO account the same invitation works.
      assert.deepEqual(await invitations.acceptInvitation({ browserBindingHash: browser("second"), nihoUserId: NIHO_B, nowUtc: at(2 * HOUR + 2 * MINUTE) }), { kind: "accepted", hostAccountId: second });

      // A host account bound meanwhile (ops, by hand) is refused for another NIHO account, and no new invitation is created.
      const third = await provision(accounts, "third@example.com");
      const another = await invite(context, third, 3 * HOUR);
      await invitations.openInvitation({ token: another.token, browserBindingHash: browser("third"), nowUtc: at(4 * HOUR) });
      assert.deepEqual(await identities.linkNihoIdentity({ hostAccountId: third, nihoUserId: "niho-user-synthetic-c", proof: { kind: "OPS" }, nowUtc: at(4 * HOUR + MINUTE) }), { kind: "linked" });
      assert.deepEqual(await invitations.acceptInvitation({ browserBindingHash: browser("third"), nihoUserId: "niho-user-synthetic-d", nowUtc: at(4 * HOUR + 2 * MINUTE) }), { kind: "account-has-identity" });
      // The same NIHO account the host account already has is accepted (the invitation is simply used up).
      assert.deepEqual(await invitations.acceptInvitation({ browserBindingHash: browser("third"), nihoUserId: "niho-user-synthetic-c", nowUtc: at(4 * HOUR + 3 * MINUTE) }), { kind: "accepted", hostAccountId: third });
    });
  });

  it("invites only an ACTIVE host account, mints nothing for one that was suspended or bound meanwhile, and validates its input", async () => {
    await withInvitations(async (context) => {
      const { accounts, identities, invitations, pool } = context;
      const suspended = await provision(accounts, "suspended@example.com");
      await accounts.suspendHostAccount({ hostAccountId: suspended, nowUtc: at(MINUTE) });
      assert.deepEqual(await invitations.createInvitation({ hostAccountId: suspended, nowUtc: at(2 * MINUTE) }), { kind: "host-account-not-active" });
      assert.deepEqual(await invitations.createInvitation({ hostAccountId: `hst_${"0".repeat(32)}`, nowUtc: at(2 * MINUTE) }), { kind: "host-account-not-active" });

      // Suspended after the invitation was created, bound before the mail went: no link is minted.
      const late = await provision(accounts, "late@example.com");
      const bound = await provision(accounts, "bound@example.com");
      await invitations.createInvitation({ hostAccountId: late, nowUtc: at(3 * MINUTE) });
      await invitations.createInvitation({ hostAccountId: bound, nowUtc: at(3 * MINUTE) });
      await accounts.suspendHostAccount({ hostAccountId: late, nowUtc: at(4 * MINUTE) });
      assert.deepEqual(await identities.linkNihoIdentity({ hostAccountId: bound, nihoUserId: NIHO_A, proof: { kind: "OPS" }, nowUtc: at(4 * MINUTE) }), { kind: "linked" });
      assert.deepEqual(await invitations.listPendingInvitations({ nowUtc: at(5 * MINUTE), limit: 10 }), (await pool.query("SELECT id::text FROM host_account_invitations WHERE host_account_id = $1", [bound])).rows.map((row) => row.id));
      const [pendingBound] = await invitations.listPendingInvitations({ nowUtc: at(5 * MINUTE), limit: 10 });
      assert.deepEqual(await invitations.issueInvitationLink({ invitationId: pendingBound!, nowUtc: at(5 * MINUTE) }), { kind: "skip" });

      await assert.rejects(invitations.createInvitation({ hostAccountId: "niho-owner", nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(invitations.createInvitation({ hostAccountId: late, nowUtc: "yesterday" }), StoreValidationError);
      await assert.rejects(invitations.issueInvitationLink({ invitationId: "not-a-uuid", nowUtc: at(0) }), StoreValidationError);
      await assert.rejects(invitations.listPendingInvitations({ nowUtc: at(0), limit: 0 }), StoreValidationError);
      // No open invitation belongs to a browser that never opened one, whatever the NIHO account.
      assert.deepEqual(await invitations.acceptInvitation({ browserBindingHash: browser("x"), nihoUserId: NIHO_B, nowUtc: at(0) }), { kind: "invalid" });
      // Invitations are history: never deleted.
      await assert.rejects(pool.query("DELETE FROM host_account_invitations"), /never deleted/);
    });
  });
});
