import { EXIT, OpsError, errorCode, failureOf, writeOne, type Action, type Target } from "./core.ts";

/*
 * 団体・個別の相談の受付一覧 (#532, docs/group-inquiry.md) from the command line: `/admin/api/inquiries`. The list holds the
 * senders' names, addresses and words, so the CLI never prints them: it shows the id, kind, status, due dates, the assignee
 * label and the staff's own note. What it changes is the status, the assignee label, the next due date and the staff note.
 */

const API = "/admin/api/inquiries";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["NEW", "IN_PROGRESS", "WAITING", "DONE"] as const;

interface InquiryRecord {
  readonly id: string;
  readonly inquiryRef: string;
  readonly kind: string;
  readonly locale: string;
  readonly entry: string;
  readonly experienceSlug: string | null;
  readonly replyByOn: string;
  readonly status: string;
  readonly assigneeLabel: string | null;
  readonly nextDueOn: string | null;
  readonly staffNote: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Everything about an inquiry that is not the sender's name, address or message. */
export const projectInquiry = (record: InquiryRecord) => ({
  id: record.id, inquiryRef: record.inquiryRef, kind: record.kind, locale: record.locale, entry: record.entry, experienceSlug: record.experienceSlug,
  status: record.status, assigneeLabel: record.assigneeLabel, nextDueOn: record.nextDueOn, replyByOn: record.replyByOn, staffNote: record.staffNote,
  createdAt: record.createdAt, updatedAt: record.updatedAt,
});

async function readInquiries(context: Parameters<Action["run"]>[0], status?: string): Promise<{ inquiries: InquiryRecord[]; counts: unknown; today: unknown }> {
  const response = await context.api.get(status ? `${API}?status=${encodeURIComponent(status)}` : API);
  if (response.status !== 200) throw failureOf(response, "inquiry list");
  const body = response.body as { inquiries?: InquiryRecord[]; counts?: unknown; today?: unknown } | null;
  return { inquiries: Array.isArray(body?.inquiries) ? body.inquiries : [], counts: body?.counts ?? null, today: body?.today ?? null };
}

const list: Action = {
  tier: "read",
  summary: "Lists the inquiries (--status NEW|IN_PROGRESS|WAITING|DONE, --id <uuid>) without the sender's name, address or message: kind, status, due dates, assignee label, staff note.",
  async run(context) {
    const status = context.args.flags.status;
    if (status !== undefined && (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status))) throw new OpsError("usage", `--status must be one of ${STATUSES.join(", ")}.`, EXIT.usage);
    const { inquiries, counts, today } = await readInquiries(context, status as string | undefined);
    const id = context.args.flags.id;
    const rows = (typeof id === "string" ? inquiries.filter((item) => item.id === id) : inquiries).map(projectInquiry);
    return { count: rows.length, counts, today, inquiries: rows };
  },
};

interface State { readonly status: string; readonly assigneeLabel: string | null; readonly nextDueOn: string | null; readonly staffNote: string | null }

const update: Action = {
  tier: "edit",
  summary: "Changes an inquiry (--id <uuid>) by what is given: --status NEW|IN_PROGRESS|WAITING|DONE, --assignee <label> (\"\" clears it), --due YYYY-MM-DD (\"\" clears it), --note <text> (\"\" clears it). Only the fields given change. It sends nothing to the sender.",
  async run(context) {
    const flags = context.args.flags;
    const id = flags.id;
    if (typeof id !== "string" || !UUID.test(id)) throw new OpsError("usage", "--id <inquiry uuid> is required.", EXIT.usage);
    const given: Record<string, unknown> = {};
    if (flags.status !== undefined) {
      if (typeof flags.status !== "string" || !(STATUSES as readonly string[]).includes(flags.status)) throw new OpsError("usage", `--status must be one of ${STATUSES.join(", ")}.`, EXIT.usage);
      given.status = flags.status;
    }
    const text = (name: string, key: "assigneeLabel" | "staffNote") => { const value = flags[name]; if (value !== undefined) { if (typeof value !== "string") throw new OpsError("usage", `--${name} needs text.`, EXIT.usage); given[key] = value === "" ? null : value; } };
    text("assignee", "assigneeLabel");
    text("note", "staffNote");
    if (flags.due !== undefined) {
      if (typeof flags.due !== "string" || (flags.due !== "" && !DATE.test(flags.due))) throw new OpsError("usage", "--due must be YYYY-MM-DD (or \"\" to clear).", EXIT.usage);
      given.nextDueOn = flags.due === "" ? null : flags.due;
    }
    if (Object.keys(given).length === 0) throw new OpsError("usage", "Give at least one of --status, --assignee, --due, --note.", EXIT.usage);
    const result = await writeOne<State>(context, ["inquiry-update", id, JSON.stringify(given)], {
      key: id,
      read: async () => {
        const found = (await readInquiries(context)).inquiries.find((item) => item.id === id);
        if (!found) throw new OpsError("not_found", "No inquiry has this id.", EXIT.failed);
        return { status: found.status, assigneeLabel: found.assigneeLabel, nextDueOn: found.nextDueOn, staffNote: found.staffNote };
      },
      desired: (current) => ({ ...current, ...given } as State),
      send: async (current, desired, operationId) => context.api.send("POST", API, {
        action: "update", id,
        ...(desired.status !== current.status ? { status: desired.status } : {}),
        ...(desired.assigneeLabel !== current.assigneeLabel ? { assigneeLabel: desired.assigneeLabel } : {}),
        ...(desired.nextDueOn !== current.nextDueOn ? { nextDueOn: desired.nextDueOn } : {}),
        ...(desired.staffNote !== current.staffNote ? { staffNote: desired.staffNote } : {}),
      }, operationId),
    });
    if (result.status === "failed") throw new OpsError(result.error ?? errorCode(null), "The inquiry was not changed.", EXIT.failed, { result });
    return result;
  },
};

export const inquiryTarget: Target = {
  summary: "Inquiries: the office's inbox of group and individual consultations (status, assignee, due date, staff note)",
  actions: { list, update },
};
