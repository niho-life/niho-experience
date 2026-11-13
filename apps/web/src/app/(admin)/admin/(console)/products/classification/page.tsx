import type { Metadata } from "next";
import { AdminProductClassifications } from "@/components/admin/AdminProductClassifications";

export const metadata: Metadata = { title: "商品の分類" };
export default function AdminProductClassificationsPage() { return <AdminProductClassifications />; }
