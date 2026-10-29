"use client";

import type { JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { EditorContent, useEditor } from "@tiptap/react";
import { ListItem } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useState } from "react";
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
  disabled = false,
}: {
  initialContent: JSONContent;
  onChange: (document: JSONContent) => void;
  disabled?: boolean;
}) {
  const [, rerenderToolbar] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState("");
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
    </section>
  );
}
