import { publicationRequest, type PublicationContext } from "@/lib/experience/publication-http";

export const GET = (request: Request, context: PublicationContext) => publicationRequest(request, context, "readSaleTerms");
export const PATCH = (request: Request, context: PublicationContext) => publicationRequest(request, context, "saveSaleTerms");
