import type { Metadata } from "next";
import { AdminProducts } from "@/components/admin/AdminProducts";

export const metadata: Metadata = { title: "商品の代理登録" };
export default function AdminProductsPage() { return <AdminProducts />; }
