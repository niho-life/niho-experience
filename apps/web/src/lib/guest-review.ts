/** The guest's one-time review link is kept in memory, never in a path, query or storage. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function reviewTokenFromFragment(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("t");
  return token !== null && TOKEN.test(token) ? token : null;
}

export interface ReviewInvitationView {
  experienceTitle: string;
  hostDisplayName: string;
  sessionStartUtc: string;
  expiresAtUtc: string;
}

export interface ReviewSubmission {
  language: "EN" | "JA";
  rating: number;
  body: string;
  displayName: string;
  tags: string[];
  originLabel: string | null;
  noteToHost: string | null;
  clientRequestKey: string;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const instant = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));

export function parseReviewInvitation(body: unknown): ReviewInvitationView | null {
  const invitation = object(body) ? body.invitation : null;
  if (!object(invitation) || !text(invitation.experienceTitle, 300) || !text(invitation.hostDisplayName, 300)
    || !instant(invitation.sessionStartUtc) || !instant(invitation.expiresAtUtc)) return null;
  return {
    experienceTitle: invitation.experienceTitle,
    hostDisplayName: invitation.hostDisplayName,
    sessionStartUtc: invitation.sessionStartUtc,
    expiresAtUtc: invitation.expiresAtUtc,
  };
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

async function post(fetchImpl: Fetch, path: string, body: object): Promise<Response | null> {
  try {
    return await fetchImpl(path, {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body),
      cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "same-origin",
    });
  } catch {
    return null;
  }
}

export type OpenReviewResult = { kind: "open"; invitation: ReviewInvitationView } | { kind: "closed" | "failed" };
export type SubmitReviewResult = { kind: "sent" | "closed" | "used" | "invalid" | "failed" };

export async function openReviewInvitation(token: string, fetchImpl: Fetch = (input, init) => fetch(input, init)): Promise<OpenReviewResult> {
  const response = await post(fetchImpl, "/api/public/reviews/open", { token });
  if (!response) return { kind: "failed" };
  if (response.status === 404) return { kind: "closed" };
  if (response.status !== 200) return { kind: "failed" };
  const invitation = parseReviewInvitation(await response.json().catch(() => null));
  return invitation ? { kind: "open", invitation } : { kind: "failed" };
}

export async function submitGuestReview(
  token: string, review: ReviewSubmission, fetchImpl: Fetch = (input, init) => fetch(input, init),
): Promise<SubmitReviewResult> {
  const response = await post(fetchImpl, "/api/public/reviews", { token, ...review });
  if (!response) return { kind: "failed" };
  if (response.status === 201) return { kind: "sent" };
  if (response.status === 404) return { kind: "closed" };
  if (response.status === 409) return { kind: "used" };
  if (response.status === 422) return { kind: "invalid" };
  return { kind: "failed" };
}
