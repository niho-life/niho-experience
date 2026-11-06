import type { Metadata } from "next";
import { HostBioForm } from "@/components/host/HostBioForm";
import { HostPageBody, PageHead } from "@/components/host/ui";

export const metadata: Metadata = { title: "ホスト紹介" };

export default function HostProfilePage() {
  return <HostPageBody><PageHead title="ホスト紹介" /><p className="mb-4 text-ink-soft">旅行者に向けて、あなた自身を紹介する文章です。日本語で書き、英語は機械翻訳の案を確認してから公開します。体験の公開には必須ではありません。</p><HostBioForm /></HostPageBody>;
}
