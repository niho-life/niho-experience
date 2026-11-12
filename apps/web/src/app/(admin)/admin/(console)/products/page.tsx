import type { Metadata } from "next";
import { AdminProducts } from "@/components/admin/AdminProducts";

export const metadata: Metadata = { title: "提供者" };
export default function AdminProductsPage() { return <AdminProducts />; }
