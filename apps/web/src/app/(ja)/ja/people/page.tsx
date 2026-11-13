import type { Metadata } from "next";
import { PeopleListPage } from "@/components/pages/PeoplePages";
import { loadPeople } from "@/lib/ja-people";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "街の人", description: "スタッフが会って、話を聞いて、体験を一緒につくっている鎌倉の人たち。" };

export default async function JapanesePeoplePage() {
  return <PeopleListPage people={await loadPeople()} />;
}
