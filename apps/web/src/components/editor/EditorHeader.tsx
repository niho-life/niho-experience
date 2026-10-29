/* eslint-disable @next/next/no-html-link-for-pages -- Editor links intentionally trigger beforeunload. */
import type { ReactNode } from "react";
import { EDITOR_LOGOUT_PATH } from "@/lib/editor/routes";

export function EditorHeader({ actions, logoutDisabled = false }: { actions?: ReactNode; logoutDisabled?: boolean }) {
  return (
    <header className="editor-header">
      <div className="editor-header-inner">
        <a href="/editor/guides" className="editor-wordmark" aria-label="記事一覧へ">NIHO <span>記事</span></a>
        <div className="editor-header-actions">
          {actions}
          <form method="post" action={EDITOR_LOGOUT_PATH}>
            <button type="submit" className="editor-text-button" disabled={logoutDisabled}>ログアウト</button>
          </form>
        </div>
      </div>
    </header>
  );
}
