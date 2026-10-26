import type { MetadataRoute } from "next";
import { config } from "@/lib/config";
import { robotsFor } from "@/lib/robots-policy";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return robotsFor(config);
}
