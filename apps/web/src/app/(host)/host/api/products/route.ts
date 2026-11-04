import { publicationCollectionRequest } from "@/lib/experience/publication-http";

export const GET = (request: Request) => publicationCollectionRequest(request, "list");
export const POST = (request: Request) => publicationCollectionRequest(request, "create");
