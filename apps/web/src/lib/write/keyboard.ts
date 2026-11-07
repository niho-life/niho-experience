import { Extension, inputRulesPlugin, textblockTypeInputRule, type Editor } from "@tiptap/core";

export function toggleExclusiveMark(editor: Editor, mark: "bold" | "italic"): boolean {
  const active = editor.isActive(mark);
  const chain = editor.chain().focus();
  if (mark === "bold") {
    if (!active) chain.unsetItalic();
    return chain.toggleBold().run();
  }
  if (!active) chain.unsetBold();
  return chain.toggleItalic().run();
}

export function writeKeyboardShortcuts(editor: Editor) {
  return {
    "Mod-b": () => toggleExclusiveMark(editor, "bold"),
    "Mod-B": () => toggleExclusiveMark(editor, "bold"),
    "Mod-i": () => toggleExclusiveMark(editor, "italic"),
    "Mod-I": () => toggleExclusiveMark(editor, "italic"),
  };
}

export const WriteKeyboard = Extension.create({
  name: "writeKeyboard",
  priority: 1_000,
  addKeyboardShortcuts() { return writeKeyboardShortcuts(this.editor); },
  addProseMirrorPlugins() {
    const heading = this.editor.schema.nodes.heading;
    return heading ? [inputRulesPlugin({ editor: this.editor, rules: [textblockTypeInputRule({
      find: /^(#{2,3})\s$/,
      type: heading,
      getAttributes: (match) => ({ level: match[1]?.length }),
    })] })] : [];
  },
});
