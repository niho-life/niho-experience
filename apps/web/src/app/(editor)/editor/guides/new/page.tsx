import type { Metadata } from "next";
import { EditorAccess } from "@/components/editor/EditorAccess";
import { GuideEditorClient } from "@/components/editor/GuideEditorClient";

export const metadata: Metadata = { title: "新しい記事" };

export default function NewGuidePage() {
  return <EditorAccess><GuideEditorClient /></EditorAccess>;
}
