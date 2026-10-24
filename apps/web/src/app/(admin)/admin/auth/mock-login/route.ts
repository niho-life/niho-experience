import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { startAdminSession } from "@/admin/session";
import { adminJson, adminMutationAllowed, isAdminPreview, setAdminSessionCookie } from "@/lib/admin/server";

export async function POST(request: Request) {
  if (!isAdminPreview()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
  const response = new NextResponse(null, { status: 303, headers: { location: "/admin/bookings", "cache-control": "private, no-store" } });
  setAdminSessionCookie(response, startAdminSession(randomUUID(), Date.now()));
  return response;
}

