/* eslint-disable @next/next/no-img-element -- authenticated private media cannot use the public image optimizer */
"use client";

import { Fragment, Slice } from "@tiptap/pm/model";
import { Node, type Editor, type JSONContent } from "@tiptap/core";
import { ListItem } from "@tiptap/extension-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { WriteApiError, writeApi, type GuideResponse } from "@/lib/write/api";
import type { WriteMediaAsset } from "@/lib/write/client-types";
import { writeDocumentToMarkdown, writeLinkHref } from "@/lib/write/document";
import { toggleExclusiveMark, WriteKeyboard } from "@/lib/write/keyboard";

const WriteListItem = ListItem.extend({
  addKeyboardShortcuts() {
    return { Enter: () => this.editor.commands.splitListItem(this.name), "Shift-Tab": () => this.editor.commands.liftListItem(this.name) };
  },
});

const GuideFigure = (articleId: string) => Node.create({
  name: "guideFigure",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() { return { assetId: { default: null }, alt: { default: "" }, originalMarkdown: { default: null } }; },
  renderHTML({ HTMLAttributes }) {
    const assetId = typeof HTMLAttributes.assetId === "string" ? HTMLAttributes.assetId : null;
    const alt = typeof HTMLAttributes.alt === "string" ? HTMLAttributes.alt : "";
    if (!assetId) return ["figure", { class: "write-figure write-figure-unresolved" }, ["p", {}, "旧形式の写真です。本文を保存するには差し替えてください。"]];
    return ["figure", { class: "write-figure", "data-asset-id": assetId }, ["img", { src: `/write/api/guides/${encodeURIComponent(articleId)}/media/${encodeURIComponent(assetId)}`, alt, draggable: "false" }], ["figcaption", {}, alt]];
  },
});

function Tool({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className="write-tool" aria-label={label} title={label} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}

function uploadPhoto(articleId: string, file: File, onProgress: (value: number) => void): Promise<{ asset: WriteMediaAsset }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/write/api/guides/${encodeURIComponent(articleId)}/media`);
    request.setRequestHeader("content-type", file.type);
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    request.onerror = () => reject(new Error("network"));
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) { reject(new Error(String(request.status))); return; }
      try { resolve(JSON.parse(request.responseText) as { asset: WriteMediaAsset }); }
      catch { reject(new Error("invalid response")); }
    };
    request.send(file);
  });
}

function removeAssetFigures(editor: Editor, assetId: string) {
  const positions: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "guideFigure" && String(node.attrs.assetId).toLowerCase() === assetId.toLowerCase()) positions.push(position);
  });
  let transaction = editor.state.tr;
  for (const position of positions.reverse()) transaction = transaction.delete(position, position + editor.state.doc.nodeAt(position)!.nodeSize);
  if (transaction.docChanged) editor.view.dispatch(transaction);
}

export function WriteRichTextEditor({
  articleId,
  initialContent,
  revokedAssetId,
  disabled,
  onChange,
  onCompositionChange,
  onMediaBusyChange,
  onValidationError,
  beforeRevisionMutation,
  onRevoked,
  onConflict,
}: {
  readonly articleId: string;
  readonly initialContent: JSONContent;
  readonly revokedAssetId?: string | null;
  readonly disabled?: boolean;
  readonly onChange: (markdown: string) => void;
  readonly onCompositionChange: (composing: boolean) => void;
  readonly onMediaBusyChange: (busy: boolean) => void;
  readonly onValidationError: (message: string | null) => void;
  readonly beforeRevisionMutation: () => Promise<number | null>;
  readonly onRevoked: (guide: GuideResponse["guide"], assetId: string) => void;
  readonly onConflict: () => void;
}) {
  const [, redraw] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState("");
  const [photoOpen, setPhotoOpen] = useState(false);
  const photoOpener = useRef<HTMLButtonElement>(null);
  const [assets, setAssets] = useState<readonly WriteMediaAsset[]>([]);
  const [assetId, setAssetId] = useState("");
  const [alt, setAlt] = useState("");
  const [credit, setCredit] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [photoError, setPhotoError] = useState("");
  const [retryFile, setRetryFile] = useState<File | null>(null);

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    content: initialContent,
    enableInputRules: false,
    enablePasteRules: false,
    extensions: [
      StarterKit.configure({
        blockquote: false, code: false, codeBlock: false, hardBreak: false, heading: { levels: [2, 3] }, horizontalRule: false,
        listItem: false, listKeymap: false, strike: false, underline: false, trailingNode: false,
        link: { autolink: false, linkOnPaste: false, markdownLinks: false, openOnClick: false, enableClickSelection: true, isAllowedUri: (url) => Boolean(writeLinkHref(url)), HTMLAttributes: { rel: "noopener noreferrer" } },
      }),
      WriteListItem,
      WriteKeyboard,
      GuideFigure(articleId),
    ],
    editorProps: {
      attributes: { class: "write-prosemirror", "aria-label": "記事本文" },
      handlePaste(view, event) {
        const plain = event.clipboardData?.getData("text/plain");
        if (plain === undefined) return false;
        event.preventDefault();
        const value = plain.replace(/\r\n?/g, "\n");
        if (!value.includes("\n")) { view.dispatch(view.state.tr.insertText(value).scrollIntoView()); return true; }
        const paragraphs = value.split("\n").map((line) => view.state.schema.nodes.paragraph!.create(null, line ? view.state.schema.text(line) : undefined));
        view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(paragraphs), 0, 0)).scrollIntoView());
        return true;
      },
      handleDOMEvents: {
        compositionstart: () => { onCompositionChange(true); return false; },
        compositionend: () => { onCompositionChange(false); return false; },
      },
    },
    onUpdate: ({ editor: current }) => {
      try { onChange(writeDocumentToMarkdown(current.getJSON())); onValidationError(null); }
      catch (error) { onValidationError(error instanceof Error ? error.message : "本文を保存できる形に直してください。"); }
    },
    onSelectionUpdate: () => redraw((value) => value + 1),
  });

  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);
  useEffect(() => { if (editor && revokedAssetId) removeAssetFigures(editor, revokedAssetId); }, [editor, revokedAssetId]);

  const closePhoto = () => { if (busy) return; setPhotoOpen(false); queueMicrotask(() => photoOpener.current?.focus()); };
  const begin = () => { setBusy(true); onMediaBusyChange(true); };
  const end = () => { setBusy(false); setProgress(null); onMediaBusyChange(false); };
  const loadAssets = async () => {
    const response = await writeApi<{ assets: WriteMediaAsset[] }>(`/write/api/guides/${encodeURIComponent(articleId)}/media`);
    setAssets(response.assets);
    return response.assets;
  };
  const openPhoto = async () => {
    if (!editor || disabled || editor.isActive("listItem")) return;
    const attrs = editor.isActive("guideFigure") ? editor.getAttributes("guideFigure") : {};
    const selected = typeof attrs.assetId === "string" ? attrs.assetId : "";
    setAssetId(selected); setAlt(typeof attrs.alt === "string" ? attrs.alt : ""); setPhotoError(""); setPhotoOpen(true);
    try {
      const next = await loadAssets();
      const asset = next.find((item) => item.id === selected);
      setCredit(asset?.publicCredit ?? ""); setConfirmed(asset?.webConfirmed ?? false);
    } catch { setPhotoError("写真一覧を読み込めませんでした。"); }
  };
  const upload = async (file: File | null) => {
    if (!file || busy) return;
    if (!["image/jpeg", "image/png"].includes(file.type) || file.size > 10 * 1024 * 1024) { setPhotoError("JPEG / PNG（10MB以下）を選んでください。"); return; }
    setRetryFile(file); begin(); setPhotoError(""); setProgress(0);
    try {
      const response = await uploadPhoto(articleId, file, setProgress);
      const next = await loadAssets();
      setAssetId(response.asset.id); setAssets(next); setCredit(""); setConfirmed(false); setRetryFile(null);
    } catch { setPhotoError("アップロードできませんでした。通信を確認して再試行してください。"); }
    finally { end(); }
  };
  const selectAsset = (value: string) => {
    const asset = assets.find((item) => item.id === value);
    setAssetId(value); setCredit(asset?.publicCredit ?? ""); setConfirmed(asset?.webConfirmed ?? false); setPhotoError("");
  };
  const applyPhoto = async () => {
    if (!editor || !assetId || !alt.trim() || !credit.trim() || !confirmed || busy) { setPhotoError("写真、英語alt、公開クレジット、Web掲載許諾を確認してください。"); return; }
    begin(); setPhotoError("");
    try {
      await writeApi(`/write/api/guides/${encodeURIComponent(articleId)}/media/${encodeURIComponent(assetId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicCredit: credit.trim(), webConfirmed: true }) });
      const attrs = { assetId, alt: alt.trim(), originalMarkdown: null };
      if (editor.isActive("guideFigure")) editor.chain().focus().updateAttributes("guideFigure", attrs).run();
      else editor.chain().focus().insertContent({ type: "guideFigure", attrs }).run();
      setPhotoOpen(false); queueMicrotask(() => photoOpener.current?.focus());
    } catch { setPhotoError("写真を配置できませんでした。もう一度お試しください。"); }
    finally { end(); }
  };
  const detach = () => {
    editor?.chain().focus().deleteSelection().run();
    setPhotoOpen(false); queueMicrotask(() => photoOpener.current?.focus());
  };
  const revoke = async () => {
    if (!editor || !assetId || busy || !window.confirm("掲載権利を取り消すと、公開中の記事を含むすべての配置から直ちに外れます。取り消しますか？")) return;
    setBusy(true); setPhotoError("");
    let registered = false;
    try {
      const expectedRevision = await beforeRevisionMutation();
      if (expectedRevision === null) { setPhotoError("保存を完了できないため、権利を取り消せません。"); return; }
      onMediaBusyChange(true); registered = true;
      const response = await writeApi<GuideResponse>(`/write/api/guides/${encodeURIComponent(articleId)}/media/${encodeURIComponent(assetId)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision }) });
      removeAssetFigures(editor, assetId);
      onRevoked(response.guide, assetId);
      setAssets((items) => items.filter((item) => item.id !== assetId)); setAssetId("");
      setPhotoError("掲載権利を取り消しました。");
    } catch (error) {
      if (error instanceof WriteApiError && error.kind === "conflict") onConflict();
      setPhotoError("掲載権利を取り消せませんでした。最新版を確認してください。");
    }
    finally { setBusy(false); setProgress(null); if (registered) onMediaBusyChange(false); }
  };

  return (
    <section className="write-body-field" aria-labelledby="write-body-label">
      <div className="write-toolbar" role="toolbar" aria-label="本文の書式">
        <Tool label="段落" active={editor?.isActive("paragraph")} disabled={!editor || disabled} onClick={() => editor?.chain().focus().setParagraph().run()}>本文</Tool>
        <Tool label="見出し2" active={editor?.isActive("heading", { level: 2 })} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H2</Tool>
        <Tool label="見出し3" active={editor?.isActive("heading", { level: 3 })} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>H3</Tool>
        <Tool label="太字" active={editor?.isActive("bold")} disabled={!editor || disabled} onClick={() => { if (editor) toggleExclusiveMark(editor, "bold"); }}><b>B</b></Tool>
        <Tool label="斜体" active={editor?.isActive("italic")} disabled={!editor || disabled} onClick={() => { if (editor) toggleExclusiveMark(editor, "italic"); }}><i>I</i></Tool>
        <Tool label="リンク" active={editor?.isActive("link")} disabled={!editor || disabled || editor.state.selection.empty} onClick={() => { if (!editor) return; setLinkValue(String(editor.getAttributes("link").href ?? "")); setLinkError(""); setLinkOpen(true); }}>↗</Tool>
        <Tool label="箇条書き" active={editor?.isActive("bulletList")} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleBulletList().run()}>•</Tool>
        <Tool label="番号付きリスト" active={editor?.isActive("orderedList")} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1.</Tool>
        <button ref={photoOpener} type="button" className="write-tool" disabled={!editor || disabled || editor.isActive("listItem")} onClick={() => void openPhoto()}>写真</button>
      </div>
      <span id="write-body-label" className="sr-only">記事本文</span>
      <EditorContent editor={editor} />
      {linkOpen ? <div className="write-popover" role="dialog" aria-label="リンクを設定">
        <label>URL<input autoFocus value={linkValue} onChange={(event) => setLinkValue(event.target.value)} /></label>
        {linkError ? <p role="alert">{linkError}</p> : null}
        <div className="write-popover-actions"><button type="button" onClick={() => setLinkOpen(false)}>キャンセル</button>{editor?.isActive("link") ? <button type="button" onClick={() => { editor.chain().focus().unsetLink().run(); setLinkOpen(false); }}>外す</button> : null}<button type="button" onClick={() => { const href = writeLinkHref(linkValue.trim()); if (!href) { setLinkError("https:// または / で始まる安全なURLを入力してください。"); return; } editor?.chain().focus().extendMarkRange("link").setLink({ href }).run(); setLinkOpen(false); }}>設定</button></div>
      </div> : null}
      {photoOpen ? <div className="write-modal-backdrop"><section className="write-modal" role="dialog" aria-modal="true" aria-labelledby="write-photo-title" onKeyDown={(event) => { if (event.key === "Escape") closePhoto(); }}>
        <h2 id="write-photo-title">本文写真</h2>
        <label>記事専用の写真<select autoFocus value={assetId} disabled={busy} onChange={(event) => selectAsset(event.target.value)}><option value="">選択してください</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.publicCredit ?? `未確認 ${asset.id.slice(0, 8)}`}</option>)}</select></label>
        <label>JPEG / PNGを追加（10MBまで）<input type="file" accept="image/jpeg,image/png" disabled={busy} onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ""; void upload(file); }} /></label>
        {progress !== null ? <p role="status">アップロード中 {progress}%</p> : null}
        {assetId ? <img src={`/write/api/guides/${encodeURIComponent(articleId)}/media/${encodeURIComponent(assetId)}`} alt="選択中の本文写真" /> : null}
        <label>英語alt<input maxLength={300} value={alt} disabled={busy} onChange={(event) => setAlt(event.target.value)} /></label>
        <label>公開クレジット<input maxLength={300} value={credit} disabled={busy || Boolean(assets.find((item) => item.id === assetId)?.webConfirmed)} onChange={(event) => setCredit(event.target.value)} /></label>
        <label className="write-check"><input type="checkbox" checked={confirmed} disabled={busy || Boolean(assets.find((item) => item.id === assetId)?.webConfirmed)} onChange={(event) => setConfirmed(event.target.checked)} />Webサイトへの掲載許諾を確認済み</label>
        <p className="write-help">この同意はWeb記事への掲載だけです。SNS・OG画像への利用許諾とは別です。</p>
        {photoError ? <p className="write-error" role="alert">{photoError} {retryFile ? <button type="button" onClick={() => void upload(retryFile)}>再試行</button> : null}</p> : null}
        <div className="write-modal-actions">{editor?.isActive("guideFigure") ? <button type="button" disabled={busy} onClick={detach}>記事から外す（権利は保持）</button> : null}{assetId ? <button type="button" disabled={busy} onClick={() => void revoke()}>掲載権利を取り消す</button> : null}<button type="button" disabled={busy} onClick={closePhoto}>キャンセル</button><button type="button" className="write-primary" disabled={busy} onClick={() => void applyPhoto()}>配置</button></div>
      </section></div> : null}
    </section>
  );
}
