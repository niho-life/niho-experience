import type { NextRequest } from "next/server";
import {
  EDITOR_SESSION_COOKIE,
  decodeEditorSession,
} from "@/lib/editor/session";
import {
  clearEditorSessionCookie,
  editorAuthClient,
  editorJson,
  editorMutationAllowed,
  editorRefreshDue,
  editorSessionSealer,
  isEditorConsole,
  renewEditorSession,
  setEditorSessionCookie,
} from "@/lib/editor/server";

export async function POST(request: NextRequest) {
  if (!isEditorConsole()) return editorJson({ error: "not_found" }, 404);
  if (!editorMutationAllowed(request)) return editorJson({ error: "cross_site_request" }, 403);
  const now = Date.now();
  const session = decodeEditorSession(editorSessionSealer(), request.cookies.get(EDITOR_SESSION_COOKIE)?.value, now);
  if (!session) {
    const response = editorJson({ error: "session_expired" }, 401);
    clearEditorSessionCookie(response);
    return response;
  }

  if (!editorRefreshDue(session, now)) {
    const verified = await editorAuthClient().verifySession(session.idToken);
    if (
      !verified.ok
      || !verified.data.account.active
      || verified.data.actor.id !== session.actorId
      || verified.data.connection.id !== session.connectionId
      || verified.data.connection.expiresAt <= now
      || verified.data.connection.expiresAt > session.connectionExpiresAt
    ) {
      if (!verified.ok && verified.kind === "unavailable") return editorJson({ error: "niho_unavailable" }, 503);
      const response = editorJson({ error: "session_expired" }, 401);
      clearEditorSessionCookie(response);
      return response;
    }
    return editorJson({ refreshed: false, idTokenExpiresAt: session.idTokenExpiresAt });
  }

  const renewal = await renewEditorSession(session);
  if (renewal.outcome === "invalidated") {
    const response = editorJson(
      { error: renewal.reason === "rejected" ? "session_expired" : "refresh_state_unknown" },
      renewal.reason === "rejected" ? 401 : 503,
    );
    clearEditorSessionCookie(response);
    return response;
  }
  if (renewal.outcome === "retryable") {
    const response = editorJson({ error: "niho_unavailable" }, 503);
    setEditorSessionCookie(response, renewal.session, Date.now());
    return response;
  }
  const response = editorJson({ refreshed: true, idTokenExpiresAt: renewal.session.idTokenExpiresAt });
  setEditorSessionCookie(response, renewal.session, Date.now());
  return response;
}
