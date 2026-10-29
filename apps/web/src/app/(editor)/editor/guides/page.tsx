import type { Metadata } from "next";
import { EditorAccess } from "@/components/editor/EditorAccess";
import { GuideListClient } from "@/components/editor/GuideListClient";

export const metadata: Metadata = { title: "記事" };

export default function EditorGuidesPage() {
  return (
    <EditorAccess><GuideListClient /></EditorAccess>
  );
}
