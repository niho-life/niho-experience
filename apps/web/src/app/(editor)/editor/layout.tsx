import "../../globals.css";
import "./editor.css";
import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { default: "記事 | NIHO Experience", template: "%s | NIHO Experience" },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: "#ffffff", width: "device-width", initialScale: 1 };

export default function EditorLayout({ children }: { children: React.ReactNode }) {
  void children;
  redirect("/write");
}
