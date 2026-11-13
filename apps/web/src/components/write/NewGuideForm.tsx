"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WriteProviderChoice } from "@/lib/write/client-types";
import { createSlugFallback, slugFromTitle } from "@/lib/write/document";
import { writeApi } from "@/lib/write/api";

function uuid() {
  return crypto.randomUUID();
}

export function NewGuideForm({ providers, experience, editPath = "/write" }: { readonly providers: readonly WriteProviderChoice[]; readonly experience: string | null; readonly editPath?: string }) {
  const articleId = useRef<string | null>(null);
  const router = useRouter();
  const fallback = useRef<string | null>(null);
  const [providerId, setProviderId] = useState(providers.length === 1 ? providers[0]!.id : "");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 書く言語 (#154): an English guide is shown on the English site; a Japanese one is the Japanese site's 読みもの.
  const [language, setLanguage] = useState<"en" | "ja">("en");

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !providerId) return;
    articleId.current ??= uuid();
    fallback.current ??= createSlugFallback(articleId.current);
    setBusy(true); setError("");
    try {
      const query = experience ? `?experience=${encodeURIComponent(experience)}` : "";
      const response = await writeApi<{ guide: { id: string }; experienceLinked: boolean }>(`/write/api/guides${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: articleId.current,
          providerId,
          slug: slugFromTitle(title, fallback.current),
          title,
          description: "",
          content: { markdown: "", language },
        }),
      });
      router.push(`${editPath}/${encodeURIComponent(response.guide.id)}`);
    } catch {
      setError("記事を作成できませんでした。入力内容はこの画面に残っています。同じ作成IDで再試行できます。");
      setBusy(false);
    }
  };

  return (
    <form className="write-new-card" onSubmit={(event) => void create(event)}>
      {providers.length > 1 ? <label>記事を書く提供者<select required value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">選択してください</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}</select></label> : <p className="write-help">{providers[0]?.displayName}</p>}
      <fieldset className="write-language-choice">
        <legend>記事を書く言語</legend>
        <label><input type="radio" name="guide-language" value="en" checked={language === "en"} onChange={() => setLanguage("en")} /> 英語（英語サイトの記事）</label>
        <label><input type="radio" name="guide-language" value="ja" checked={language === "ja"} onChange={() => setLanguage("ja")} /> 日本語（日本語サイトの「読みもの」。英語サイトには出ません）</label>
      </fieldset>
      <label>記事タイトル<input autoFocus maxLength={110} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={language === "ja" ? "記事のタイトル（あとから入れても大丈夫です）" : "English title (can be added later)"} /></label>
      {experience ? <p className="write-help">体験「{experience}」が同じ提供者の公開中の商品なら関連付けます。見つからなくても記事は作成できます。</p> : null}
      <p className="write-help">作成しても公開はされません。本文や公開設定は次の画面で編集します。</p>
      {error ? <p className="write-error" role="alert">{error}</p> : null}
      <button className="write-primary write-full-action" type="submit" disabled={busy || !providerId}>{busy ? "作成中…" : "下書きを作成"}</button>
    </form>
  );
}
