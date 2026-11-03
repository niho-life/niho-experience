import { publicationRequest, type PublicationContext } from "@/lib/experience/publication-http";

export const GET = (request: Request, context: PublicationContext) => publicationRequest(request, context, "preview");
