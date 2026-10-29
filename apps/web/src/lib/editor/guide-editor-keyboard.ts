import { Extension, inputRulesPlugin, textblockTypeInputRule, type Editor } from "@tiptap/core";

export type GuideEditorShortcut = "Mod-b" | "Mod-B" | "Mod-i" | "Mod-I";

export function toggleExclusiveGuideMark(editor: Editor, mark: "bold" | "italic"): boolean {
  const active = editor.isActive(mark);
  const chain = editor.chain().focus();

  if (mark === "bold") {
    if (!active) chain.unsetItalic();
    return chain.toggleBold().run();
  }

  if (!active) chain.unsetBold();
  return chain.toggleItalic().run();
}

export function guideEditorKeyboardShortcuts(editor: Editor): Record<GuideEditorShortcut, () => boolean> {
  return {
    "Mod-b": () => toggleExclusiveGuideMark(editor, "bold"),
    "Mod-B": () => toggleExclusiveGuideMark(editor, "bold"),
    "Mod-i": () => toggleExclusiveGuideMark(editor, "italic"),
    "Mod-I": () => toggleExclusiveGuideMark(editor, "italic"),
  };
}

export const GuideEditorKeyboard = Extension.create({
  name: "guideEditorKeyboard",
  priority: 1_000,
  addKeyboardShortcuts() {
    return guideEditorKeyboardShortcuts(this.editor);
  },
  addProseMirrorPlugins() {
    const heading = this.editor.schema.nodes.heading;
    return heading ? [inputRulesPlugin({
      editor: this.editor,
      rules: [textblockTypeInputRule({
        find: /^(#{2,3})\s$/,
        type: heading,
        getAttributes: (match) => ({ level: match[1]?.length }),
      })],
    })] : [];
  },
});
