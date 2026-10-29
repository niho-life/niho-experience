import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { guideEditorKeyboardShortcuts } from "./guide-editor-keyboard";

function editorDouble(active: readonly string[] = []) {
  const run = vi.fn(() => true);
  const chain = {
    focus: vi.fn(() => chain),
    unsetBold: vi.fn(() => chain),
    unsetItalic: vi.fn(() => chain),
    toggleBold: vi.fn(() => chain),
    toggleItalic: vi.fn(() => chain),
    run,
  };
  const editor = {
    isActive: vi.fn((name: string) => active.includes(name)),
    chain: vi.fn(() => chain),
    state: { selection: { empty: false } },
  } as unknown as Editor;
  return { editor, chain };
}

describe("guide editor keyboard shortcuts", () => {
  it("removes italic before applying bold", () => {
    const { editor, chain } = editorDouble(["italic"]);
    expect(guideEditorKeyboardShortcuts(editor)["Mod-b"]()).toBe(true);
    expect(chain.unsetItalic).toHaveBeenCalledOnce();
    expect(chain.toggleBold).toHaveBeenCalledOnce();
  });

  it("removes bold before applying italic", () => {
    const { editor, chain } = editorDouble(["bold"]);
    expect(guideEditorKeyboardShortcuts(editor)["Mod-i"]()).toBe(true);
    expect(chain.unsetBold).toHaveBeenCalledOnce();
    expect(chain.toggleItalic).toHaveBeenCalledOnce();
  });

  it("leaves Tab to native focus navigation", () => {
    expect(guideEditorKeyboardShortcuts(editorDouble(["listItem"]).editor)).not.toHaveProperty("Tab");
  });
});
