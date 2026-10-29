import { NextResponse, type NextRequest } from "next/server";
import { EDITOR_SESSION_COOKIE, decodeEditorSession } from "@/lib/editor/session";
import { EDITOR_LOGIN_PATH } from "@/lib/editor/routes";
import {
  clearEditorLoginCookie,
  clearEditorSessionCookie,
  editorAuthClient,
  editorJson,
  editorMutationAllowed,
  editorSessionSealer,
  isEditorConsole,
  renewEditorSession,
} from "@/lib/editor/server";

function cleared(response: NextResponse): NextResponse {
  clearEditorSessionCookie(response);
  clearEditorLoginCookie(response);
  return response;
}

export async function POST(request: NextRequest) {
  if (!isEditorConsole()) return editorJson({ error: "not_found" }, 404);
  if (!editorMutationAllowed(request)) return editorJson({ error: "cross_site_request" }, 403);

  const session = decodeEditorSession(editorSessionSealer(), request.cookies.get(EDITOR_SESSION_COOKIE)?.value, Date.now());
  if (session) {
    let current = session;
    if (current.idTokenExpiresAt <= Date.now()) {
      const renewal = await renewEditorSession(current);
      if (renewal.outcome === "refreshed") current = renewal.session;
      else if (renewal.outcome === "retryable") current = renewal.session;
    }
    if (current.idTokenExpiresAt > Date.now()) {
      await editorAuthClient().deleteConnection(current.connectionId, current.idToken);
    }
  }

  return cleared(new NextResponse(null, {
    status: 303,
    headers: { location: EDITOR_LOGIN_PATH, "cache-control": "private, no-store" },
  }));
}
