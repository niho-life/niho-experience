"use client";

import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { HostSidebar, type HostWriterArticle } from "@/components/host/HostNav";
import type { WriteGuide, WriteProviderChoice } from "@/lib/write/client-types";
import { writeStatusLabel } from "@/lib/write/client-types";

export interface WriteChromeProps {
  readonly account: { readonly displayName: string; readonly iconUrl: string | null };
  readonly providers: readonly WriteProviderChoice[];
  readonly nihoAppUrl: string;
  readonly articles: readonly WriteGuide[];
  readonly articlesAvailable?: boolean;
}

function articleNavigation(articles: readonly WriteGuide[], current?: WriteGuide): HostWriterArticle[] {
  const items = current ? articles.map((article) => article.id === current.id ? current : article) : articles;
  if (current && !items.some((article) => article.id === current.id)) return articleNavigation([current, ...items]);
  return items.map((article) => ({ id: article.id, title: article.title, status: article.status, statusLabel: writeStatusLabel(article) }));
}

export function WriteWorkspace({ chrome, current, collapsed = false, onNavigate, onNewArticle, writePath = "/write", children }: {
  readonly chrome: WriteChromeProps;
  readonly current?: WriteGuide;
  readonly collapsed?: boolean;
  readonly onNavigate?: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly onNewArticle?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly writePath?: string;
  readonly children: ReactNode;
}) {
  const providers = chrome.providers.map((provider) => ({ ...provider, kind: "MEMBER" as const, memberRole: "OWNER" as const }));
  return (
    <div className={`write-workspace ${collapsed ? "write-workspace-sidebar-closed" : ""}`}>
      {!collapsed ? <HostSidebar
        account={chrome.account}
        providers={providers}
        nihoAppUrl={chrome.nihoAppUrl}
        writePath={writePath}
        providerIdOverride={current?.subject.providerId}
        writerNavigation={{
          articles: articleNavigation(chrome.articles, current),
          articlesAvailable: chrome.articlesAvailable,
          ...(current ? { activeArticleId: current.id } : {}),
          ...(onNavigate ? { onNavigate } : {}),
          ...(onNewArticle ? { onNewArticle } : {}),
        }}
      /> : null}
      <div className="write-workspace-main">{children}</div>
    </div>
  );
}
