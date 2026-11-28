import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreAccessDeniedError, StoreRateLimitedError, StoreValidationError } from "../src/errors.ts";
import { HostAccountIdentities } from "../src/host-account-identities.ts";
import { HOST_TEAM_INVITATION_LIMITS, HostTeamInvitations, type HostTeamInvitationLinkIssue } from "../src/host-team-invitations.ts";
import { HOST_TEAM_RESOLVE_LIMIT, HostTeamRepository } from "../src/host-team.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/** メンバーの招待 (#636, migration 0088): invite → email → open → NIHO sign-in → join, against a real schema, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-14T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const browser = (label: string): Buffer => createHash("sha256").update(`synthetic-team-browser-${label}`, "utf8").digest();

const PROVIDER = "synthetic-invite-provider";
const OTHER = "synthetic-other-provider";
const OWNER = `hst_${"a1".repeat(16)}`;
const COHOST = `hst_${"a2".repeat(16)}`;
const SUSPENDED = `hst_${"a3".repeat(16)}`;
const OTHER_OWNER = `hst_${"a4".repeat(16)}`;
const NIHO_A = "niho-user-synthetic-team-a";
const NIHO_B = "niho-user-synthetic-team-b";
const NIHO_C = "niho-user-synthetic-team-c";

type Sent = Extract<HostTeamInvitationLinkIssue, { kind: "send" }>;

interface Context {
  readonly pool: Pool;
  readonly invitations: HostTeamInvitations;
  readonly team: HostTeamRepository;
  readonly identities: HostAccountIdentities;
}

async function withTeam(run: (context: Context) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "host_team_inv", { max: 6 });
  try {
    const { pool } = db;
    await pool.query("INSERT INTO experience_providers (id) VALUES ($1),($2)", [PROVIDER, OTHER]);
    for (const [id, email] of [[OWNER, "owner@example.test"], [COHOST, "cohost@example.test"], [OTHER_OWNER, "other-owner@example.test"]]) {
      await pool.query("INSERT INTO host_accounts (id,email,email_key,created_at,updated_at) VALUES ($1,$2,$2,$3,$3)", [id, email, at(0)]);
    }
    await pool.query("INSERT INTO host_accounts (id,email,email_key,status,suspended_at,created_at,updated_at) VALUES ($1,'suspended@example.test','suspended@example.test','SUSPENDED',$2,$2,$2)", [SUSPENDED, at(0)]);
    await pool.query(
      `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,'OWNER',true),($1,$3,'COHOST',true),($4,$5,'OWNER',true)`,
      [PROVIDER, OWNER, COHOST, OTHER, OTHER_OWNER],
    );
    await run({ pool, invitations: new HostTeamInvitations(pool), team: new HostTeamRepository(pool), identities: new HostAccountIdentities(pool) });
  } finally {
    await db.dispose();
  }
}

const owner = { providerId: PROVIDER, hostAccountId: OWNER };

/** The OWNER invites at `offsetMs`; the mail job mints the link a minute later: the raw token the email carries. */
async function invite(context: Context, email: string, offsetMs: number): Promise<Sent & { readonly invitationId: string }> {
  const created = await context.invitations.create({ ...owner, email, nowUtc: at(offsetMs) });
  assert.equal(created.kind, "created");
  const invitationId = (created as { invitationId: string }).invitationId;
  const pending = await context.invitations.listPending({ nowUtc: at(offsetMs + MINUTE), limit: 100 });
  assert.ok(pending.includes(invitationId));
  const issued = await context.invitations.issueLink({ invitationId, nowUtc: at(offsetMs + MINUTE) });
  assert.equal(issued.kind, "send");
  return { ...(issued as Sent), invitationId };
}

async function opened(context: Context, email: string, label: string, offsetMs = HOUR): Promise<Sent & { readonly invitationId: string }> {
  const sent = await invite(context, email, offsetMs);
  assert.deepEqual(await context.invitations.open({ token: sent.token, browserBindingHash: browser(label), nowUtc: at(offsetMs + 2 * MINUTE) }), { kind: "opened" });
  return sent;
}

const membership = async (pool: Pool, hostAccountId: string) =>
  (await pool.query("SELECT role, active FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2", [PROVIDER, hostAccountId])).rows[0];
const revision = async (pool: Pool): Promise<number> =>
  Number((await pool.query("SELECT COALESCE((SELECT version FROM provider_team_revisions WHERE provider_id=$1), 0) AS v", [PROVIDER])).rows[0]!.v);
const invitationRow = async (pool: Pool, id: string) => (await pool.query("SELECT * FROM provider_team_invitations WHERE id=$1::uuid", [id])).rows[0]!;

describe("provider team invitations", { skip: databaseUrl === undefined }, () => {
  it("brings in a person with no host account: a new account, bound to NIHO, added as COHOST, the address dropped", async () => {
    await withTeam(async (context) => {
      const { pool, invitations, team, identities } = context;
      await pool.query("INSERT INTO experience_provider_public_profiles (provider_id,public_display_name,consent_version,consented_at,consent_source,consented_by_admin_niho_user_id) VALUES ($1,'Synthetic Farm','v1',$2,'ADMIN','niho-admin-synthetic')", [PROVIDER, at(0)]);
      const before = await revision(pool);
      const sent = await invite(context, "  New.Person@Example.test ", HOUR);
      assert.match(sent.token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(sent.toEmail, "New.Person@Example.test");
      assert.equal(sent.providerDisplayName, "Synthetic Farm");
      assert.equal(sent.expiresAtUtc, at(HOUR + HOST_TEAM_INVITATION_LIMITS.ttlDays * DAY));
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_team_invitations WHERE token_hash=$1", [createHash("sha256").update(sent.token).digest()])).rows[0]!.n, 1);
      // Minted once.
      assert.deepEqual(await invitations.issueLink({ invitationId: sent.invitationId, nowUtc: at(HOUR + 2 * MINUTE) }), { kind: "skip" });
      assert.deepEqual((await invitations.list({ ...owner, nowUtc: at(HOUR + 2 * MINUTE) })).map(({ email, state }) => [email, state]), [["New.Person@Example.test", "SENT"]]);

      assert.deepEqual(await invitations.open({ token: sent.token, browserBindingHash: browser("new"), nowUtc: at(2 * HOUR) }), { kind: "opened" });
      assert.deepEqual(await invitations.open({ token: sent.token, browserBindingHash: browser("new"), nowUtc: at(2 * HOUR + MINUTE) }), { kind: "opened" });
      assert.equal((await invitations.list({ ...owner, nowUtc: at(2 * HOUR) }))[0]!.state, "OPENED");
      const accepted = await invitations.accept({ browserBindingHash: browser("new"), nihoUserId: NIHO_A, nowUtc: at(2 * HOUR + 2 * MINUTE) });
      assert.equal(accepted.kind, "accepted");
      const { hostAccountId, joined, providerId } = accepted as { hostAccountId: string; joined: boolean; providerId: string };
      assert.match(hostAccountId, /^hst_[0-9a-f]{32}$/);
      assert.equal(joined, true);
      assert.equal(providerId, PROVIDER);

      const account = (await pool.query("SELECT email, email_key, email_verified_at FROM host_accounts WHERE id=$1", [hostAccountId])).rows[0]!;
      assert.equal(account.email, "New.Person@Example.test");
      assert.equal(account.email_key, "new.person@example.test");
      assert.equal(new Date(account.email_verified_at).toISOString(), at(2 * HOUR + 2 * MINUTE));
      assert.deepEqual(await identities.readNihoIdentity({ hostAccountId }), { linkedAtUtc: at(2 * HOUR + 2 * MINUTE), lastLoginAtUtc: null, linkedVia: "INVITATION" });
      assert.deepEqual(await membership(pool, hostAccountId), { role: "COHOST", active: true });
      assert.equal(await revision(pool), before + 1);
      const row = await invitationRow(pool, sent.invitationId);
      assert.equal(row.email, null);
      assert.equal(row.email_key, null);
      assert.equal(row.accepted_host_account_id, hostAccountId);
      assert.equal(new Date(row.accepted_at).toISOString(), at(2 * HOUR + 2 * MINUTE));
      assert.deepEqual((await team.list(owner)).members.map(({ hostAccountId: id, role }) => `${role}:${id}`).sort(), [`COHOST:${COHOST}`, `COHOST:${hostAccountId}`, `OWNER:${OWNER}`].sort());
      assert.equal((await invitations.list({ ...owner, nowUtc: at(3 * HOUR) })).length, 0);
      // The session opens for the account the invitation made.
      const session = await identities.startSessionForNihoIdentity({ nihoUserId: NIHO_A, authenticatedAtUtc: at(2 * HOUR + 2 * MINUTE), nowUtc: at(2 * HOUR + 3 * MINUTE) });
      assert.equal(session.kind, "ok");
      assert.equal((session as { hostAccountId: string }).hostAccountId, hostAccountId);
      // The link and the browser get nothing more.
      assert.deepEqual(await invitations.open({ token: sent.token, browserBindingHash: browser("new"), nowUtc: at(3 * HOUR) }), { kind: "used" });
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("new"), nihoUserId: NIHO_A, nowUtc: at(3 * HOUR) }), { kind: "invalid" });
    });
  });

  it("adds the host account the NIHO account is already bound to, whatever the address, without making another", async () => {
    await withTeam(async (context) => {
      const { pool, invitations } = context;
      const bound = `hst_${"b1".repeat(16)}`;
      await pool.query("INSERT INTO host_accounts (id,email,email_key,created_at,updated_at) VALUES ($1,'bound@example.test','bound@example.test',$2,$2)", [bound, at(0)]);
      await pool.query("INSERT INTO host_account_identities (host_account_id,provider,subject,linked_via,linked_at) VALUES ($1,'NIHO',$2,'OPS',$3)", [bound, NIHO_B, at(0)]);
      const accounts = Number((await pool.query("SELECT count(*)::int AS n FROM host_accounts")).rows[0]!.n);
      const sent = await opened(context, "someone-else@example.test", "bound");
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("bound"), nihoUserId: NIHO_B, nowUtc: at(2 * HOUR) }), { kind: "accepted", hostAccountId: bound, providerId: PROVIDER, joined: true });
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM host_accounts")).rows[0]!.n), accounts);
      assert.deepEqual(await membership(pool, bound), { role: "COHOST", active: true });
      // The account keeps its own address: the invited one is not written over it.
      assert.equal((await pool.query("SELECT email FROM host_accounts WHERE id=$1", [bound])).rows[0]!.email, "bound@example.test");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM host_accounts WHERE email_key=$1", ["someone-else@example.test"])).rows[0]!.n, 0);
      assert.equal((await invitationRow(pool, sent.invitationId)).email, null);
    });
  });

  it("binds the NIHO account to the unbound host account that has the invited address", async () => {
    await withTeam(async (context) => {
      const { pool, invitations, identities } = context;
      const registered = `hst_${"b2".repeat(16)}`;
      await pool.query("INSERT INTO host_accounts (id,email,email_key,created_at,updated_at) VALUES ($1,'Registered@Example.test','registered@example.test',$2,$2)", [registered, at(0)]);
      await opened(context, "registered@example.test", "registered");
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("registered"), nihoUserId: NIHO_A, nowUtc: at(2 * HOUR) }), { kind: "accepted", hostAccountId: registered, providerId: PROVIDER, joined: true });
      assert.equal((await identities.readNihoIdentity({ hostAccountId: registered }))?.linkedVia, "INVITATION");
      assert.notEqual((await pool.query("SELECT email_verified_at FROM host_accounts WHERE id=$1", [registered])).rows[0]!.email_verified_at, null);
      assert.deepEqual(await membership(pool, registered), { role: "COHOST", active: true });
    });
  });

  it("refuses an address whose host account belongs to another NIHO account, changes nothing and records nothing", async () => {
    await withTeam(async (context) => {
      const { pool, invitations } = context;
      const taken = `hst_${"b3".repeat(16)}`;
      await pool.query("INSERT INTO host_accounts (id,email,email_key,created_at,updated_at) VALUES ($1,'taken@example.test','taken@example.test',$2,$2)", [taken, at(0)]);
      await pool.query("INSERT INTO host_account_identities (host_account_id,provider,subject,linked_via,linked_at) VALUES ($1,'NIHO',$2,'OPS',$3)", [taken, NIHO_B, at(0)]);
      const sent = await opened(context, "taken@example.test", "taken");
      const revisionBefore = await revision(pool);
      const events = Number((await pool.query("SELECT count(*)::int AS n FROM host_account_identity_events")).rows[0]!.n);
      const accounts = Number((await pool.query("SELECT count(*)::int AS n FROM host_accounts")).rows[0]!.n);
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("taken"), nihoUserId: NIHO_C, nowUtc: at(2 * HOUR) }), { kind: "email-account-has-identity" });
      assert.equal(await revision(pool), revisionBefore);
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM host_account_identity_events")).rows[0]!.n), events);
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM host_accounts")).rows[0]!.n), accounts);
      assert.equal(await membership(pool, taken), undefined);
      // Still open and usable: the right NIHO account can come back with it.
      assert.equal((await invitationRow(pool, sent.invitationId)).accepted_at, null);
      assert.equal((await invitations.accept({ browserBindingHash: browser("taken"), nihoUserId: NIHO_B, nowUtc: at(2 * HOUR + MINUTE) })).kind, "accepted");
      // A suspended account's address, and a suspended bound account, are refused too.
      await opened(context, "suspended@example.test", "suspended", 3 * HOUR);
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("suspended"), nihoUserId: NIHO_C, nowUtc: at(4 * HOUR) }), { kind: "host-account-not-active" });
      await pool.query("INSERT INTO host_account_identities (host_account_id,provider,subject,linked_via,linked_at) VALUES ($1,'NIHO','niho-user-synthetic-suspended','OPS',$2)", [SUSPENDED, at(0)]);
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("suspended"), nihoUserId: "niho-user-synthetic-suspended", nowUtc: at(4 * HOUR) }), { kind: "host-account-not-active" });
    });
  });

  it("gives an address-less writer account the invited address when it is free, and joins it either way", async () => {
    await withTeam(async (context) => {
      const { pool, invitations, team } = context;
      const writer = async (id: string, subject: string) => {
        await pool.query("INSERT INTO host_accounts (id,email,email_key,created_at,updated_at) VALUES ($1,NULL,NULL,$2,$2)", [id, at(0)]);
        await pool.query("INSERT INTO host_account_identities (host_account_id,provider,subject,linked_via,linked_at) VALUES ($1,'NIHO',$2,'WRITER',$3)", [id, subject, at(0)]);
      };
      const first = `hst_${"c1".repeat(16)}`;
      const second = `hst_${"c2".repeat(16)}`;
      await writer(first, NIHO_A);
      await writer(second, NIHO_B);
      await opened(context, "writer@example.test", "w1");
      assert.equal((await invitations.accept({ browserBindingHash: browser("w1"), nihoUserId: NIHO_A, nowUtc: at(2 * HOUR) })).kind, "accepted");
      const row = (await pool.query("SELECT email, email_key, email_verified_at FROM host_accounts WHERE id=$1", [first])).rows[0]!;
      assert.equal(row.email, "writer@example.test");
      assert.equal(row.email_key, "writer@example.test");
      assert.notEqual(row.email_verified_at, null);
      // The address is taken now (by an account that is no member): the second writer joins without one, and the member list does not break.
      await pool.query("INSERT INTO host_accounts (id,email,email_key,created_at,updated_at) VALUES ($1,'held@example.test','held@example.test',$2,$2)", [`hst_${"c3".repeat(16)}`, at(0)]);
      await opened(context, "held@example.test", "w2", 3 * HOUR);
      assert.equal((await invitations.accept({ browserBindingHash: browser("w2"), nihoUserId: NIHO_B, nowUtc: at(4 * HOUR) })).kind, "accepted");
      assert.equal((await pool.query("SELECT email FROM host_accounts WHERE id=$1", [second])).rows[0]!.email, null);
      const members = (await team.list(owner)).members;
      assert.deepEqual(members.find((member) => member.hostAccountId === second), { hostAccountId: second, role: "COHOST", label: "メールアドレス未登録のメンバー" });
      assert.equal(members.find((member) => member.hostAccountId === first)?.label, "writer@example.test");
    });
  });

  it("brings a removed COHOST back, and leaves an active OWNER, COHOST or EDITOR as they are", async () => {
    await withTeam(async (context) => {
      const { pool, invitations } = context;
      const editor = `hst_${"d1".repeat(16)}`;
      const former = `hst_${"d2".repeat(16)}`;
      for (const [id, subject, role, active] of [[editor, "niho-user-synthetic-editor", "EDITOR", true], [former, "niho-user-synthetic-former", "COHOST", false]] as const) {
        await pool.query("INSERT INTO host_accounts (id,email,email_key,created_at,updated_at) VALUES ($1,$2,$2,$3,$3)", [id, `${id}@example.test`, at(0)]);
        await pool.query("INSERT INTO host_account_identities (host_account_id,provider,subject,linked_via,linked_at) VALUES ($1,'NIHO',$2,'OPS',$3)", [id, subject, at(0)]);
        await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,$3,$4)", [PROVIDER, id, role, active]);
      }
      for (const [id, subject] of [[OWNER, "niho-user-synthetic-owner"], [COHOST, "niho-user-synthetic-cohost"]] as const) {
        await pool.query("INSERT INTO host_account_identities (host_account_id,provider,subject,linked_via,linked_at) VALUES ($1,'NIHO',$2,'OPS',$3)", [id, subject, at(0)]);
      }
      // A removed COHOST comes back.
      await opened(context, "again@example.test", "former");
      const beforeFormer = await revision(pool);
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("former"), nihoUserId: "niho-user-synthetic-former", nowUtc: at(2 * HOUR) }), { kind: "accepted", hostAccountId: former, providerId: PROVIDER, joined: true });
      assert.deepEqual(await membership(pool, former), { role: "COHOST", active: true });
      assert.equal(await revision(pool), beforeFormer + 1);
      // Active members keep their role and the team does not change.
      let offset = 3 * HOUR;
      for (const [id, subject, role] of [[OWNER, "niho-user-synthetic-owner", "OWNER"], [COHOST, "niho-user-synthetic-cohost", "COHOST"], [editor, "niho-user-synthetic-editor", "EDITOR"]] as const) {
        offset += HOUR;
        await opened(context, `invitee-${role.toLowerCase()}@example.test`, `role-${role}`, offset);
        const before = await revision(pool);
        assert.deepEqual(await invitations.accept({ browserBindingHash: browser(`role-${role}`), nihoUserId: subject, nowUtc: at(offset + 5 * MINUTE) }), { kind: "accepted", hostAccountId: id, providerId: PROVIDER, joined: false });
        assert.deepEqual(await membership(pool, id), { role, active: true });
        assert.equal(await revision(pool), before);
      }
    });
  });

  it("tells a link that ran out, was used, was revoked, opened elsewhere or never existed (open and accept)", async () => {
    await withTeam(async (context) => {
      const { pool, invitations } = context;
      const sent = await invite(context, "states@example.test", 0);
      assert.deepEqual(await invitations.open({ token: sent.token, browserBindingHash: browser("first"), nowUtc: at(HOUR) }), { kind: "opened" });
      assert.deepEqual(await invitations.open({ token: sent.token, browserBindingHash: browser("second"), nowUtc: at(HOUR + MINUTE) }), { kind: "other-browser" });
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("second"), nihoUserId: NIHO_A, nowUtc: at(HOUR + 2 * MINUTE) }), { kind: "invalid" });
      assert.deepEqual(await invitations.open({ token: "x".repeat(43), browserBindingHash: browser("first"), nowUtc: at(HOUR) }), { kind: "invalid" });
      assert.deepEqual(await invitations.open({ token: "short", browserBindingHash: browser("first"), nowUtc: at(HOUR) }), { kind: "invalid" });
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("unknown"), nihoUserId: NIHO_A, nowUtc: at(HOUR) }), { kind: "invalid" });
      // Ran out.
      const late = at(HOST_TEAM_INVITATION_LIMITS.ttlDays * DAY + HOUR);
      assert.deepEqual(await invitations.open({ token: sent.token, browserBindingHash: browser("first"), nowUtc: late }), { kind: "expired" });
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("first"), nihoUserId: NIHO_A, nowUtc: late }), { kind: "invalid" });
      // Revoked.
      const revoked = await opened(context, "revoked@example.test", "revoked", 10 * DAY);
      assert.equal(await invitations.revoke({ ...owner, invitationId: revoked.invitationId, nowUtc: at(10 * DAY + 3 * MINUTE) }), true);
      assert.equal(await invitations.revoke({ ...owner, invitationId: revoked.invitationId, nowUtc: at(10 * DAY + 4 * MINUTE) }), false);
      assert.deepEqual(await invitations.open({ token: revoked.token, browserBindingHash: browser("revoked"), nowUtc: at(10 * DAY + 5 * MINUTE) }), { kind: "expired" });
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("revoked"), nihoUserId: NIHO_A, nowUtc: at(10 * DAY + 5 * MINUTE) }), { kind: "invalid" });
      assert.equal((await invitationRow(pool, revoked.invitationId)).email, null);
      // Another provider's owner cannot revoke it, and a used one says so.
      const used = await opened(context, "used@example.test", "used", 20 * DAY);
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("used"), nihoUserId: NIHO_B, nowUtc: at(20 * DAY + 5 * MINUTE) }), { kind: "accepted", hostAccountId: (await pool.query("SELECT accepted_host_account_id AS id FROM provider_team_invitations WHERE id=$1::uuid", [used.invitationId])).rows[0]!.id, providerId: PROVIDER, joined: true });
      assert.deepEqual(await invitations.open({ token: used.token, browserBindingHash: browser("used"), nowUtc: at(20 * DAY + 6 * MINUTE) }), { kind: "used" });
      assert.equal(await invitations.revoke({ ...owner, invitationId: used.invitationId, nowUtc: at(20 * DAY + 7 * MINUTE) }), false);
    });
  });

  it("lets only one of two simultaneous accepts through, and only one of an accept and a revoke", async () => {
    await withTeam(async (context) => {
      const { pool, invitations } = context;
      await opened(context, "race@example.test", "race");
      const both = await Promise.all([
        invitations.accept({ browserBindingHash: browser("race"), nihoUserId: NIHO_A, nowUtc: at(2 * HOUR) }),
        invitations.accept({ browserBindingHash: browser("race"), nihoUserId: NIHO_A, nowUtc: at(2 * HOUR) }),
      ]);
      assert.deepEqual(both.map(({ kind }) => kind).sort(), ["accepted", "invalid"]);
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM provider_memberships WHERE provider_id=$1 AND role='COHOST'", [PROVIDER])).rows[0]!.n), 2);

      for (let round = 0; round < 3; round += 1) {
        const offset = (4 + round * 2) * HOUR;
        const sent = await opened(context, `race-revoke-${round}@example.test`, `rr-${round}`, offset);
        const [accepted, revoked] = await Promise.all([
          invitations.accept({ browserBindingHash: browser(`rr-${round}`), nihoUserId: `niho-user-synthetic-rr-${round}`, nowUtc: at(offset + 5 * MINUTE) }),
          invitations.revoke({ ...owner, invitationId: sent.invitationId, nowUtc: at(offset + 5 * MINUTE) }),
        ]);
        assert.notEqual(accepted.kind === "accepted", revoked, "exactly one of accept and revoke wins");
        const row = await invitationRow(pool, sent.invitationId);
        assert.equal(row.accepted_at !== null, accepted.kind === "accepted");
        assert.equal(row.revoked_at !== null, revoked);
        if (revoked) assert.equal(accepted.kind, "invalid");
      }
    });
  });

  it("is for the current OWNER only", async () => {
    await withTeam(async (context) => {
      const { pool, invitations } = context;
      const sent = await invite(context, "guard@example.test", 0);
      const base = { email: "x@example.test", nowUtc: at(HOUR) };
      for (const actor of [{ providerId: PROVIDER, hostAccountId: COHOST }, { providerId: PROVIDER, hostAccountId: OTHER_OWNER }, { providerId: OTHER, hostAccountId: OWNER }]) {
        await assert.rejects(invitations.create({ ...actor, ...base }), StoreAccessDeniedError);
        await assert.rejects(invitations.list({ ...actor, nowUtc: base.nowUtc }), StoreAccessDeniedError);
        await assert.rejects(invitations.revoke({ ...actor, invitationId: sent.invitationId, nowUtc: base.nowUtc }), StoreAccessDeniedError);
      }
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,'OWNER',true)", [PROVIDER, SUSPENDED]);
      await assert.rejects(invitations.create({ providerId: PROVIDER, hostAccountId: SUSPENDED, ...base }), StoreAccessDeniedError);
      await pool.query("UPDATE provider_memberships SET active=false WHERE provider_id=$1 AND niho_user_id=$2", [PROVIDER, OWNER]);
      await assert.rejects(invitations.create({ ...owner, ...base }), StoreAccessDeniedError);
      await assert.rejects(invitations.create({ ...owner, email: "not-an-address", nowUtc: at(HOUR) }), StoreValidationError);
    });
  });

  it("replaces an open invitation to the same address, refuses members, caps open invitations and shares the lookup limit", async () => {
    await withTeam(async (context) => {
      const { pool, invitations } = context;
      const first = await invite(context, "again@example.test", 0);
      const second = await invitations.create({ ...owner, email: "AGAIN@example.test", nowUtc: at(HOUR) });
      assert.equal(second.kind, "created");
      assert.equal((second as { superseded: boolean }).superseded, true);
      const old = await invitationRow(pool, first.invitationId);
      assert.equal(old.email, null);
      assert.notEqual(old.revoked_at, null);
      assert.deepEqual(await invitations.open({ token: first.token, browserBindingHash: browser("old"), nowUtc: at(2 * HOUR) }), { kind: "expired" });
      assert.equal((await invitations.list({ ...owner, nowUtc: at(2 * HOUR) })).length, 1);
      // A current OWNER or COHOST's address is refused (also in another case), and nothing is written.
      const rows = Number((await pool.query("SELECT count(*)::int AS n FROM provider_team_invitations")).rows[0]!.n);
      assert.deepEqual(await invitations.create({ ...owner, email: "Cohost@Example.test", nowUtc: at(HOUR) }), { kind: "already-member" });
      assert.deepEqual(await invitations.create({ ...owner, email: "owner@example.test", nowUtc: at(HOUR) }), { kind: "already-member" });
      assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM provider_team_invitations")).rows[0]!.n), rows);
      // A former member's address is not a member.
      await pool.query("UPDATE provider_memberships SET active=false WHERE provider_id=$1 AND niho_user_id=$2", [PROVIDER, COHOST]);
      assert.equal((await invitations.create({ ...owner, email: "cohost@example.test", nowUtc: at(HOUR) })).kind, "created");
      await pool.query("UPDATE provider_memberships SET active=true WHERE provider_id=$1 AND niho_user_id=$2", [PROVIDER, COHOST]);

      // The cap: expired ones and replaced ones do not count.
      const open = Number((await pool.query("SELECT count(*)::int AS n FROM provider_team_invitations WHERE provider_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL", [PROVIDER])).rows[0]!.n);
      for (let index = open; index < HOST_TEAM_INVITATION_LIMITS.openPerProviderMax; index += 1) {
        await pool.query(
          "INSERT INTO provider_team_invitations (provider_id,role,invited_by_host_account_id,email,email_key,created_at,expires_at) VALUES ($1,'COHOST',$2,$3,$3,$4,$5)",
          [PROVIDER, OWNER, `filler-${index}@example.test`, at(0), at(7 * DAY)],
        );
      }
      assert.deepEqual(await invitations.create({ ...owner, email: "one-more@example.test", nowUtc: at(2 * HOUR) }), { kind: "too-many-open" });
      // Inviting an address that already has an open invitation replaces it: the count does not grow.
      assert.equal((await invitations.create({ ...owner, email: "filler-5@example.test", nowUtc: at(2 * HOUR) })).kind, "created");
      // Past their days they stop counting.
      assert.equal((await invitations.create({ ...owner, email: "one-more@example.test", nowUtc: at(8 * DAY) })).kind, "created");
    });
    await withTeam(async (context) => {
      const { invitations, team } = context;
      // Finding a member by address and inviting use up the same hourly allowance.
      for (let index = 0; index < HOST_TEAM_RESOLVE_LIMIT - 2; index += 1) await team.resolve({ ...owner, email: `unknown-${index}@example.test` });
      assert.equal((await invitations.create({ ...owner, email: "limit-a@example.test", nowUtc: at(0) })).kind, "created");
      assert.equal((await invitations.create({ ...owner, email: "limit-b@example.test", nowUtc: at(0) })).kind, "created");
      await assert.rejects(invitations.create({ ...owner, email: "limit-c@example.test", nowUtc: at(0) }), StoreRateLimitedError);
      await assert.rejects(team.resolve({ ...owner, email: "limit-d@example.test" }), StoreRateLimitedError);
    });
  });

  it("closes the invitations that ran out, with their addresses", async () => {
    await withTeam(async (context) => {
      const { pool, invitations } = context;
      const sent = await opened(context, "expiring@example.test", "exp", 0);
      const fresh = await invite(context, "fresh@example.test", 6 * DAY);
      assert.equal(await invitations.closeExpired({ nowUtc: at(7 * DAY - MINUTE), limit: 100 }), 0);
      assert.equal(await invitations.closeExpired({ nowUtc: at(8 * DAY), limit: 100 }), 1);
      const row = await invitationRow(pool, sent.invitationId);
      assert.equal(row.email, null);
      assert.equal(row.email_key, null);
      assert.equal(new Date(row.revoked_at).toISOString(), new Date(row.expires_at).toISOString());
      assert.deepEqual(await invitations.open({ token: sent.token, browserBindingHash: browser("exp"), nowUtc: at(8 * DAY) }), { kind: "expired" });
      assert.deepEqual(await invitations.accept({ browserBindingHash: browser("exp"), nihoUserId: NIHO_A, nowUtc: at(8 * DAY) }), { kind: "invalid" });
      assert.equal(await invitations.closeExpired({ nowUtc: at(8 * DAY), limit: 100 }), 0);
      assert.equal((await invitationRow(pool, fresh.invitationId)).email, "fresh@example.test");
      await assert.rejects(invitations.closeExpired({ nowUtc: at(8 * DAY), limit: 0 }), StoreValidationError);
    });
  });

  it("never deletes a row, and changes only the team's membership when someone joins", async () => {
    await withTeam(async (context) => {
      const { pool, invitations } = context;
      const watched = ["experience_host_seller_profiles", "experience_provider_public_profiles", "provider_publication_readiness", "provider_seller_disclosures", "provider_payout_account_consents", "experience_products"];
      const counts = async () => Promise.all(watched.map(async (table) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n)));
      const before = await counts();
      const others = (await pool.query("SELECT * FROM provider_memberships WHERE provider_id <> $1 ORDER BY niho_user_id", [PROVIDER])).rows;
      const sent = await opened(context, "delete@example.test", "del");
      assert.equal((await invitations.accept({ browserBindingHash: browser("del"), nihoUserId: NIHO_A, nowUtc: at(2 * HOUR) })).kind, "accepted");
      assert.deepEqual(await counts(), before);
      assert.deepEqual((await pool.query("SELECT * FROM provider_memberships WHERE provider_id <> $1 ORDER BY niho_user_id", [PROVIDER])).rows, others);
      await assert.rejects(pool.query("DELETE FROM provider_team_invitations WHERE id=$1::uuid", [sent.invitationId]), /never deleted/);
      await assert.rejects(pool.query("DELETE FROM provider_team_invitations"), /never deleted/);
    });
  });
});
