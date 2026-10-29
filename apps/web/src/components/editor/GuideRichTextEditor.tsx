/* eslint-disable @next/next/no-img-element -- authenticated private images cannot use the public Next image pipeline */
"use client";

import { Node, type JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { EditorContent, useEditor } from "@tiptap/react";
import { ListItem } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useState } from "react";
import {
  EditorApiError,
  editorApiRequest,
  type EditorGuideArticle,
  type GuideCoverUploadResponse,
  type GuideMediaAsset,
  type GuideMediaAssetsResponse,
  type GuideMediaRightsResponse,
  type GuideResponse,
} from "@/lib/editor/guide-editor-api";
import { guideEditorLinkHref } from "@/lib/editor/guide-editor-document";
import { GuideEditorKeyboard, toggleExclusiveGuideMark } from "@/lib/editor/guide-editor-keyboard";

const GuideListItem = ListItem.extend({
  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      "Shift-Tab": () => this.editor.commands.liftListItem(this.name),
    };
  },
});

function figureOperationError(error: unknown, action: "upload" | "confirm" | "revoke"): string {
  if (error instanceof EditorApiError) {
    if (error.kind === "signed-out" || error.kind === "reconnect") return "ログインを更新してから、もう一度お試しください。";
    if (error.kind === "forbidden") return "この記事の写真を操作する権限がありません。";
    if (error.kind === "not-found") return "写真が見つかりません。選び直してください。";
    if (error.kind === "conflict") return action === "revoke"
      ? "別の画面で記事が更新されました。最新版を確認してください。"
      : "この写真の公開クレジットは確定済みです。別の写真を選んでください。";
    if (error.kind === "invalid") return action === "upload"
      ? "JPEGまたはPNGを選んでください（10MB・16MPまで）。HEICには対応していません。"
      : action === "revoke" ? "写真を選び直してください。" : "英語alt、公開クレジット、掲載確認を見直してください。";
  }
  return action === "upload" ? "写真を追加できませんでした。もう一度お試しください。"
    : action === "revoke" ? "掲載権利を取り消せませんでした。もう一度お試しください。"
      : "写真を配置できませんでした。もう一度お試しください。";
}

function guideFigureExtension(articleId?: string) {
  return Node.create({
    name: "guideFigure",
    group: "block",
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes() {
      return {
        assetId: { default: null },
        alt: { default: "" },
        unresolvedSource: { default: null },
        originalMarkdown: { default: null },
      };
    },
    renderHTML({ HTMLAttributes }) {
      const assetId = typeof HTMLAttributes.assetId === "string" ? HTMLAttributes.assetId : null;
      const alt = typeof HTMLAttributes.alt === "string" ? HTMLAttributes.alt : "";
      if (!assetId || !articleId) {
        return [
          "figure",
          { class: "editor-guide-figure editor-guide-figure-unresolved", "data-guide-figure": "unresolved" },
          ["div", { class: "editor-guide-figure-placeholder" }, "旧形式の写真です。保存・公開前に差し替えてください。"],
          ["figcaption", {}, alt || "写真の代替文がありません"],
        ];
      }
      const src = `/editor/api/guides/${encodeURIComponent(articleId)}/media/assets/${encodeURIComponent(assetId)}`;
      return [
        "figure",
        { class: "editor-guide-figure", "data-guide-figure": assetId },
        ["img", { src, alt, draggable: "false" }],
        ["figcaption", {}, alt],
      ];
    },
  });
}

type ToolbarButtonProps = {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
};

function ToolbarButton({ label, active, disabled, onClick, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className="editor-toolbar-button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function GuideRichTextEditor({
  initialContent,
  onChange,
  articleId,
  revision,
  onRevoked,
  onRevisionConflict,
  disabled = false,
}: {
  initialContent: JSONContent;
  onChange: (document: JSONContent) => void;
  articleId?: string;
  revision: number | null;
  onRevoked: (guide: EditorGuideArticle, assetId: string) => void;
  onRevisionConflict: () => void;
  disabled?: boolean;
}) {
  const [, rerenderToolbar] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState("");
  const [figureOpen, setFigureOpen] = useState(false);
  const [figureAssets, setFigureAssets] = useState<readonly GuideMediaAsset[]>([]);
  const [figureAssetId, setFigureAssetId] = useState("");
  const [figureAlt, setFigureAlt] = useState("");
  const [figureCredit, setFigureCredit] = useState("");
  const [figureConfirmed, setFigureConfirmed] = useState(false);
  const [figureBusy, setFigureBusy] = useState(false);
  const [figureError, setFigureError] = useState("");
  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    content: initialContent,
    enableInputRules: false,
    enablePasteRules: false,
    extensions: [
      StarterKit.configure({
        blockquote: false,
        code: false,
        codeBlock: false,
        hardBreak: false,
        heading: { levels: [2, 3] },
        horizontalRule: false,
        listItem: false,
        listKeymap: false,
        strike: false,
        underline: false,
        trailingNode: false,
        link: {
          autolink: false,
          linkOnPaste: false,
          markdownLinks: false,
          openOnClick: false,
          enableClickSelection: true,
          isAllowedUri: (url) => Boolean(guideEditorLinkHref(url)),
          HTMLAttributes: { rel: "noopener noreferrer" },
        },
      }),
      GuideListItem,
      GuideEditorKeyboard,
      guideFigureExtension(articleId),
    ],
    editorProps: {
      attributes: {
        class: "guide-prosemirror",
        "aria-label": "記事本文",
      },
      handlePaste(view, event) {
        const plain = event.clipboardData?.getData("text/plain");
        if (plain === undefined) return false;
        event.preventDefault();
        const value = plain.replace(/\r\n?/g, "\n");
        const { $from, $to } = view.state.selection;
        const inList = [$from, $to].some(($position) => {
          for (let depth = $position.depth; depth > 0; depth--) {
            if ($position.node(depth).type.name === "listItem") return true;
          }
          return false;
        });
        if (inList && value.includes("\n")) {
          view.dispatch(view.state.tr.insertText(value.replace(/\n+/g, " ")).scrollIntoView());
          return true;
        }
        if (!value.includes("\n")) {
          view.dispatch(view.state.tr.insertText(value).scrollIntoView());
          return true;
        }
        const paragraphs = value.split("\n").map((line) => view.state.schema.nodes.paragraph!.create(
          null,
          line ? view.state.schema.text(line) : undefined,
        ));
        view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(paragraphs), 0, 0)).scrollIntoView());
        return true;
      },
    },
    onUpdate: ({ editor: current }) => onChange(current.getJSON()),
    onSelectionUpdate: () => rerenderToolbar((value) => value + 1),
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  const openLink = () => {
    if (!editor || disabled || editor.state.selection.empty) return;
    const href = editor.getAttributes("link").href;
    setLinkValue(typeof href === "string" ? href : "");
    setLinkError("");
    setLinkOpen(true);
  };

  const applyLink = () => {
    if (!editor || disabled) return;
    const safe = guideEditorLinkHref(linkValue.trim());
    if (!safe) {
      setLinkError("https:// または / で始まるURLを入力してください。");
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: safe }).run();
    setLinkOpen(false);
  };

  const loadFigureAssets = async () => {
    if (!articleId) return [];
    const response = await editorApiRequest<GuideMediaAssetsResponse>(
      `/editor/api/guides/${encodeURIComponent(articleId)}/media`,
    );
    setFigureAssets(response.assets);
    return response.assets;
  };

  const openFigure = async () => {
    if (!editor || !articleId || disabled) return;
    const attrs = editor.isActive("guideFigure") ? editor.getAttributes("guideFigure") : {};
    const selectedId = typeof attrs.assetId === "string" ? attrs.assetId : "";
    setFigureAssetId(selectedId);
    setFigureAlt(typeof attrs.alt === "string" ? attrs.alt : "");
    setFigureCredit("");
    setFigureConfirmed(false);
    setFigureError("");
    setFigureOpen(true);
    try {
      const assets = await loadFigureAssets();
      const selected = assets.find((asset) => asset.id === selectedId);
      if (selected?.publicCredit) {
        setFigureCredit(selected.publicCredit);
        setFigureConfirmed(selected.webConfirmed);
      }
    } catch {
      setFigureError("写真一覧を読み込めませんでした。");
    }
  };

  const selectFigureAsset = (assetId: string) => {
    setFigureAssetId(assetId);
    const asset = figureAssets.find((candidate) => candidate.id === assetId);
    setFigureCredit(asset?.publicCredit ?? "");
    setFigureConfirmed(asset?.webConfirmed ?? false);
    setFigureError("");
  };

  const uploadFigure = async (file: File | undefined) => {
    if (!articleId || !file || figureBusy) return;
    setFigureBusy(true);
    setFigureError("");
    try {
      const response = await editorApiRequest<GuideCoverUploadResponse>(
        `/editor/api/guides/${encodeURIComponent(articleId)}/media`,
        { method: "POST", headers: { "content-type": file.type }, body: file },
      );
      const assets = await loadFigureAssets();
      setFigureAssetId(response.asset.id);
      setFigureAssets(assets);
      setFigureCredit("");
      setFigureConfirmed(false);
    } catch (error) {
      setFigureError(figureOperationError(error, "upload"));
    } finally {
      setFigureBusy(false);
    }
  };

  const applyFigure = async () => {
    if (!editor || !articleId || disabled || figureBusy) return;
    if (!figureAssetId || !figureAlt.trim() || !figureCredit.trim() || !figureConfirmed) {
      setFigureError("写真、英語alt、公開クレジット、Web掲載確認をすべて設定してください。");
      return;
    }
    let figureCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "guideFigure") figureCount++;
    });
    if (!editor.isActive("guideFigure") && figureCount >= 10) {
      setFigureError("本文写真は1記事10か所以内にしてください。");
      return;
    }
    setFigureBusy(true);
    setFigureError("");
    try {
      const response = await editorApiRequest<GuideMediaRightsResponse>(
        `/editor/api/guides/${encodeURIComponent(articleId)}/media/assets/${encodeURIComponent(figureAssetId)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ publicCredit: figureCredit.trim(), webConfirmed: true }),
        },
      );
      const attrs = {
        assetId: response.asset.id,
        alt: figureAlt.trim(),
        unresolvedSource: null,
        originalMarkdown: null,
      };
      if (editor.isActive("guideFigure")) editor.chain().focus().updateAttributes("guideFigure", attrs).run();
      else editor.chain().focus().insertContent({ type: "guideFigure", attrs }).run();
      setFigureOpen(false);
    } catch (error) {
      setFigureError(figureOperationError(error, "confirm"));
    } finally {
      setFigureBusy(false);
    }
  };

  const revokeFigure = async () => {
    if (!articleId || !figureAssetId || revision === null || figureBusy) return;
    if (!window.confirm("この写真の掲載権利を取り消しますか？公開中の記事からも直ちに外れます。")) return;
    setFigureBusy(true);
    setFigureError("");
    const assetId = figureAssetId;
    try {
      const response = await editorApiRequest<GuideResponse>(
        `/editor/api/guides/${encodeURIComponent(articleId)}/media/assets/${encodeURIComponent(assetId)}`,
        { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: revision }) },
      );
      onRevoked(response.guide, assetId);
      setFigureAssets((assets) => assets.filter((asset) => asset.id !== assetId));
      setFigureAssetId("");
      setFigureCredit("");
      setFigureConfirmed(false);
      setFigureError("掲載権利を取り消しました。本文の写真を差し替えてください。");
    } catch (error) {
      if (error instanceof EditorApiError && error.kind === "conflict") onRevisionConflict();
      setFigureError(figureOperationError(error, "revoke"));
    } finally {
      setFigureBusy(false);
    }
  };

  return (
    <section className="editor-body-field" aria-labelledby="guide-body-label" inert={disabled}>
      <div className="editor-toolbar" role="toolbar" aria-label="本文の書式">
        <ToolbarButton label="段落" active={editor?.isActive("paragraph")} disabled={!editor || disabled} onClick={() => editor?.chain().focus().setParagraph().run()}>本文</ToolbarButton>
        <ToolbarButton label="見出し2" active={editor?.isActive("heading", { level: 2 })} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H2</ToolbarButton>
        <ToolbarButton label="見出し3" active={editor?.isActive("heading", { level: 3 })} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>H3</ToolbarButton>
        <span className="editor-toolbar-divider" aria-hidden="true" />
        <ToolbarButton label="太字" active={editor?.isActive("bold")} disabled={!editor || disabled} onClick={() => {
          if (!editor) return;
          toggleExclusiveGuideMark(editor, "bold");
        }}><strong>B</strong></ToolbarButton>
        <ToolbarButton label="斜体" active={editor?.isActive("italic")} disabled={!editor || disabled} onClick={() => {
          if (!editor) return;
          toggleExclusiveGuideMark(editor, "italic");
        }}><em>I</em></ToolbarButton>
        <ToolbarButton label="リンク" active={editor?.isActive("link")} disabled={!editor || disabled || editor.state.selection.empty} onClick={openLink}>↗</ToolbarButton>
        <span className="editor-toolbar-divider" aria-hidden="true" />
        <ToolbarButton label="箇条書き" active={editor?.isActive("bulletList")} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleBulletList().run()}>•</ToolbarButton>
        <ToolbarButton label="番号付きリスト" active={editor?.isActive("orderedList")} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1.</ToolbarButton>
        <span className="editor-toolbar-divider" aria-hidden="true" />
        <ToolbarButton label="本文写真（最大10か所）" active={editor?.isActive("guideFigure")} disabled={!editor || disabled || !articleId} onClick={() => void openFigure()}>写真</ToolbarButton>
      </div>
      <span id="guide-body-label" className="sr-only">記事本文</span>
      <EditorContent editor={editor} />
      {linkOpen && (
        <div className="editor-link-popover" role="dialog" aria-label="リンクを設定" onKeyDown={(event) => {
          if (event.key === "Escape") setLinkOpen(false);
        }}>
          <label htmlFor="guide-link-url">URL</label>
          <input id="guide-link-url" value={linkValue} onChange={(event) => setLinkValue(event.target.value)} disabled={disabled} autoFocus />
          {linkError && <p role="alert">{linkError}</p>}
          <div>
            {editor?.isActive("link") && <button type="button" disabled={disabled} onClick={() => { editor.chain().focus().unsetLink().run(); setLinkOpen(false); }}>リンクを外す</button>}
            <button type="button" disabled={disabled} onClick={() => setLinkOpen(false)}>キャンセル</button>
            <button type="button" className="editor-link-apply" disabled={disabled} onClick={applyLink}>設定</button>
          </div>
        </div>
      )}
      {figureOpen && (
        <div className="editor-figure-popover" role="dialog" aria-label="本文写真を設定" onKeyDown={(event) => {
          if (event.key === "Escape" && !figureBusy) setFigureOpen(false);
        }}>
          <label>記事専用の写真
            <select value={figureAssetId} disabled={figureBusy} onChange={(event) => selectFigureAsset(event.target.value)}>
              <option value="">選択してください</option>
              {figureAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.publicCredit ?? `未確認 ${asset.id.slice(0, 8)}`}</option>)}
            </select>
          </label>
          <label>JPEG / PNGを追加（10MBまで）
            <input type="file" accept="image/jpeg,image/png" disabled={figureBusy} onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void uploadFigure(file);
            }} />
          </label>
          {figureAssetId && <img src={`/editor/api/guides/${encodeURIComponent(articleId!)}/media/assets/${encodeURIComponent(figureAssetId)}`} alt="選択中の本文写真" />}
          <label>英語alt
            <input maxLength={300} value={figureAlt} disabled={figureBusy} onChange={(event) => setFigureAlt(event.target.value)} />
          </label>
          <label>公開クレジット
            <input maxLength={300} value={figureCredit} disabled={figureBusy || figureAssets.find((asset) => asset.id === figureAssetId)?.webConfirmed} onChange={(event) => setFigureCredit(event.target.value)} />
          </label>
          <label className="editor-figure-confirm">
            <input type="checkbox" checked={figureConfirmed} disabled={figureBusy || figureAssets.find((asset) => asset.id === figureAssetId)?.webConfirmed} onChange={(event) => setFigureConfirmed(event.target.checked)} />
            Webサイトへの掲載許諾を確認済み
          </label>
          <p className="editor-cover-note">確認後の公開クレジットは固定されます。SNS・OG画像には使用しません。</p>
          {figureError && <p className="editor-figure-error" role="alert">{figureError}</p>}
          <div>
            {editor?.isActive("guideFigure") && <button type="button" disabled={figureBusy} onClick={() => {
              editor.chain().focus().deleteSelection().run();
              setFigureOpen(false);
            }}>記事から外す</button>}
            {figureAssetId && <button type="button" disabled={figureBusy} onClick={() => void revokeFigure()}>掲載権利を取り消す</button>}
            <button type="button" disabled={figureBusy} onClick={() => setFigureOpen(false)}>キャンセル</button>
            <button type="button" className="editor-link-apply" disabled={figureBusy} onClick={() => void applyFigure()}>配置</button>
          </div>
        </div>
      )}
    </section>
  );
}
