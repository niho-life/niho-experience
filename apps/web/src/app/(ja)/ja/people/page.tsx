import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { config } from "@/lib/config";
import { PeopleListPage } from "@/components/pages/PeoplePages";
import { loadPeople } from "@/lib/ja-people";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "街の人", description: "スタッフが会って、話を聞いて、体験を一緒につくっている鎌倉の人たち。" };

export default async function JapanesePeoplePage() {
  // 街の人のページを止めている間 (#612) は 404。
  if (!config.peoplePagesEnabled) notFound();
  return <PeopleListPage people={await loadPeople()} />;
}
