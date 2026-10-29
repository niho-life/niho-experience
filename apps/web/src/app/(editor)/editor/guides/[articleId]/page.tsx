import type { Metadata } from "next";
import { EditorAccess } from "@/components/editor/EditorAccess";
import { GuideEditorClient } from "@/components/editor/GuideEditorClient";

export const metadata: Metadata = { title: "記事を編集" };

export default async function EditGuidePage({ params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  return <EditorAccess><GuideEditorClient articleId={articleId} /></EditorAccess>;
}
