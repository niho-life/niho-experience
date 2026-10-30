import { ASK_HOST_INPUT_LIMITS } from "@niho-experience/api-client";

/*
 * The guest's reply page (#105, docs/guest-questions.md): the host's reply email links to
 * `/questions/reply#t=<token>`. The token stays in the fragment, which browsers never send to a server
 * or in a Referer; the page reads it, takes it out of the address bar and posts it to this site only.
 */

/** What one answer may hold: as much as a question (ASK_HOST_INPUT_LIMITS). */
export const REPLY_PAGE_MESSAGE_MAX_LENGTH = ASK_HOST_INPUT_LIMITS.messageMaxLength;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** `#t=<token>` from the address; null for anything else. */
export function tokenFromFragment(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("t");
  return token !== null && TOKEN.test(token) ? token : null;
}

export interface ReplyLinkMessage {
  from: "guest" | "host";
  atUtc: string;
  body: string;
}

/** The conversation behind a link: the guest's own words and the host's English. */
export interface ReplyLinkView {
  experienceTitle: string;
  hostDisplayName: string;
  guestName: string;
  messages: ReplyLinkMessage[];
  expiresAtUtc: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isInstant = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));

function isMessage(value: unknown): value is ReplyLinkMessage {
  return isObject(value) && (value.from === "guest" || value.from === "host") && isInstant(value.atUtc) && isText(value.body, 4000);
}

/** The open route's `{ link }`, only in its closed shape. */
export function parseReplyLink(body: unknown): ReplyLinkView | null {
  const link = isObject(body) ? body.link : undefined;
  if (!isObject(link)) return null;
  const { experienceTitle, hostDisplayName, guestName, messages, expiresAtUtc } = link;
  if (!isText(experienceTitle, 300) || !isText(hostDisplayName, 300) || !isText(guestName, 100) || !isInstant(expiresAtUtc)) return null;
  if (!Array.isArray(messages) || messages.length > 500 || !messages.every(isMessage)) return null;
  return {
    experienceTitle,
    hostDisplayName,
    guestName,
    messages: messages.map(({ from, atUtc, body: text }) => ({ from, atUtc, body: text })),
    expiresAtUtc,
  };
}

export type OpenReplyResult = { kind: "open"; link: ReplyLinkView } | { kind: "closed" } | { kind: "failed" };
export type SendReplyResult = { kind: "sent" } | { kind: "closed" } | { kind: "used" } | { kind: "invalid" } | { kind: "failed" };

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Same-origin POSTs only; `same-origin` so the request carries this site's Origin (the site's policy is no-referrer). */
async function post(fetchImpl: Fetch, path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetchImpl(path, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "same-origin",
    });
  } catch {
    return null;
  }
}

/** The link's conversation, or why there is none: unknown, expired and used links all read as closed. */
export async function openReplyLink(token: string, fetchImpl: Fetch = (input, init) => fetch(input, init)): Promise<OpenReplyResult> {
  const response = await post(fetchImpl, "/api/public/questions/reply/open", { token });
  if (!response) return { kind: "failed" };
  if (response.status === 404) return { kind: "closed" };
  if (response.status !== 200) return { kind: "failed" };
  const link = parseReplyLink(await response.json().catch(() => null));
  return link ? { kind: "open", link } : { kind: "failed" };
}

/** The guest's answer. The same key again is the same answer (a retry after a lost response). */
export async function sendGuestReply(token: string, message: string, clientRequestKey: string, fetchImpl: Fetch = (input, init) => fetch(input, init)): Promise<SendReplyResult> {
  const response = await post(fetchImpl, "/api/public/questions/reply", { token, message, clientRequestKey });
  if (!response) return { kind: "failed" };
  if (response.status === 201) return { kind: "sent" };
  if (response.status === 404) return { kind: "closed" };
  if (response.status === 409) return { kind: "used" };
  if (response.status === 422) return { kind: "invalid" };
  return { kind: "failed" };
}
