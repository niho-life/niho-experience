import { publicationRequest, type PublicationProductContext } from "@/lib/experience/publication-http";

export const GET = (request: Request, context: PublicationProductContext) => publicationRequest(request, context, "readSaleTerms");
export const PUT = (request: Request, context: PublicationProductContext) => publicationRequest(request, context, "saveSaleTerms");
