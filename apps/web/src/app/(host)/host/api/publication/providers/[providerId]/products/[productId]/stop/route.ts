import { publicationRequest, type PublicationContext } from "@/lib/experience/publication-http";

export const POST = (request: Request, context: PublicationContext) => publicationRequest(request, context, "stop");
