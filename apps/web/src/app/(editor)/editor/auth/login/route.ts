import { NextResponse } from "next/server";
import { experienceEditorConnectUrl } from "@niho-experience/api-client/editor-auth";
import { config } from "@/lib/config";
import { createLoginState, createPkceVerifier, pkceChallenge } from "@/lib/host/pkce";
import { EDITOR_LOGIN_MAX_AGE_SECONDS } from "@/lib/editor/session";
import { editorJson, isEditorConsole, setEditorLoginCookie } from "@/lib/editor/server";

export function GET() {
  if (!isEditorConsole()) return editorJson({ error: "not_found" }, 404);
  const verifier = createPkceVerifier();
  const state = createLoginState();
  const response = new NextResponse(null, {
    status: 303,
    headers: {
      location: experienceEditorConnectUrl(config.nihoWebOrigin, {
        challenge: pkceChallenge(verifier),
        state,
      }),
      "cache-control": "private, no-store",
    },
  });
  setEditorLoginCookie(response, {
    verifier,
    state,
    expiresAt: Date.now() + EDITOR_LOGIN_MAX_AGE_SECONDS * 1000,
  });
  return response;
}
