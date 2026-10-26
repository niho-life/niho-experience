// このファイルは scripts/gen-types.ts が contract/experience-provider-operations-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/api/experience-providers/{providerId}/bookings": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
            };
            cookie?: never;
        };
        get: operations["listExperienceProviderBookings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/bookings/{requestId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
            };
            cookie?: never;
        };
        get: operations["getExperienceProviderBooking"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/members": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
            };
            cookie?: never;
        };
        get: operations["listExperienceProviderMembers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/members/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        get?: never;
        put: operations["putExperienceProviderCohost"];
        post?: never;
        delete: operations["deleteExperienceProviderCohost"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/members/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["resolveExperienceProviderMemberByEmail"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/bookings/{requestId}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                pageId: components["parameters"]["PageId"];
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["approveExperienceProviderBooking"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/bookings/{requestId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                pageId: components["parameters"]["PageId"];
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["cancelExperienceProviderBooking"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/bookings/{requestId}/decline": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                pageId: components["parameters"]["PageId"];
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["declineExperienceProviderBooking"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/bookings/{requestId}/message": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                pageId: components["parameters"]["PageId"];
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["messageExperienceProviderGuest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        AnswerSnapshot: {
            /** @enum {string} */
            inputType: "SHORT_TEXT" | "LONG_TEXT" | "SINGLE_SELECT" | "MULTI_SELECT";
            options: components["schemas"]["QuestionOption"][];
            prompt: string;
            questionId: string;
            text: string | null;
        };
        AnswerSnapshots: components["schemas"]["AnswerSnapshot"][] | null;
        BookingDetail: {
            adultCount: number;
            adultPriceYen: number;
            answers: components["schemas"]["AnswerSnapshots"];
            /** Format: date-time */
            approvalDeadlineAt: string | null;
            /** Format: date-time */
            authorizedAt: string | null;
            /** Format: date-time */
            cancelledAt: string | null;
            cancelMessage: string | null;
            cancelReason: string | null;
            childCount: number;
            childPriceYen: number | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            endAt: string;
            guestEmail: string;
            guestMessages: components["schemas"]["GuestMessage"][];
            guestName: string;
            headCount: number;
            hostMessages: components["schemas"]["HostMessage"][];
            id: string;
            languageSnapshot: string;
            note: string | null;
            /** Format: date */
            occurrenceDate: string;
            offerId: string;
            offerName: string;
            page: components["schemas"]["PageTitle"];
            pageId: string;
            /** Format: date-time */
            paidAt: string | null;
            refundedYen: number;
            salesChannel: string;
            /** Format: date-time */
            startAt: string;
            status: components["schemas"]["KnownBookingStatus"];
            totalYen: number;
            /** Format: date-time */
            travelerCancelRequestedAt: string | null;
            unitPriceYen: number;
        };
        BookingDetailResponse: {
            booking: components["schemas"]["BookingDetail"];
            sender: components["schemas"]["Sender"];
        };
        BookingListItem: {
            adultCount: number;
            /** Format: date-time */
            authorizedAt: string | null;
            /** Format: date-time */
            cancelledAt: string | null;
            childCount: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            endAt: string;
            experienceSiteListingId: string | null;
            guestEmail: string;
            guestName: string;
            headCount: number;
            id: string;
            note: string | null;
            /** Format: date */
            occurrenceDate: string;
            offerId: string;
            offerNameSnapshot: string;
            page: components["schemas"]["PageTitle"];
            pageId: string;
            /** Format: date-time */
            paidAt: string | null;
            questionAnswersJson: components["schemas"]["AnswerSnapshots"];
            refundedYen: number;
            salesChannel: components["schemas"]["SalesChannel"];
            sellerDisplayNameSnapshot: string | null;
            spotId: string;
            /** Format: date-time */
            startAt: string;
            status: components["schemas"]["ProjectedBookingStatus"];
            totalYenSnapshot: number;
        };
        BookingListResponse: {
            bookings: components["schemas"]["BookingListItem"][];
            nextCursor: string | null;
        };
        BookingStatusResponse: {
            status: components["schemas"]["KnownBookingStatus"];
        };
        CancelBookingInput: {
            message: string;
            /** @enum {string} */
            reason: "HOST_CANNOT_HOST" | "GUEST_REQUEST" | "OTHER";
            /** @enum {string} */
            refund: "FULL" | "HALF" | "NONE";
        };
        CancelBookingResponse: {
            refundedYen: number;
            status: components["schemas"]["KnownBookingStatus"];
        };
        GuestMessage: {
            body: string;
            /** Format: date-time */
            createdAt: string;
            id: string;
        };
        HostMessage: {
            body: string | null;
            /** Format: date-time */
            createdAt: string;
            /** @enum {string} */
            deliveryStatus: "QUEUED" | "SENT" | "FAILED" | "UNKNOWN";
            failed: boolean;
            id: string;
            /** Format: date-time */
            sentAt: string | null;
            subject: string;
        };
        /** @enum {string} */
        KnownBookingStatus: "PENDING" | "PAYMENT_PENDING" | "PROVISIONAL" | "CONFIRMED" | "DECLINED" | "EXPIRED" | "CANCELLED" | "REFUND_NEEDED";
        Member: {
            displayName: string;
            role: components["schemas"]["ProviderRole"];
            userId: string;
        };
        MemberListResponse: {
            members: components["schemas"]["Member"][];
        };
        MemberResponse: {
            member: components["schemas"]["Member"];
        };
        MessageInput: {
            body: string;
            subject: string;
        };
        MessageReceipt: {
            /** Format: date-time */
            createdAt: string;
            id: string;
            /** Format: date-time */
            sentAt: string | null;
            subject: string;
        };
        MessageResponse: {
            message: components["schemas"]["MessageReceipt"];
        };
        /** @enum {string} */
        OperationalProviderRole: "OWNER" | "COHOST";
        PageTitle: {
            title: string;
        };
        /** @enum {string} */
        ProjectedBookingStatus: "PENDING" | "PAYMENT_PENDING" | "PROVISIONAL" | "CONFIRMED" | "DECLINED" | "EXPIRED" | "CANCELLED" | "REFUND_NEEDED" | "UNKNOWN";
        /** @enum {string} */
        ProviderRole: "OWNER" | "EDITOR" | "COHOST";
        PublicUser: {
            displayName: string;
            userId: string;
        };
        PutMemberInput: {
            /** @enum {string} */
            role: "COHOST";
        };
        QuestionOption: {
            id: string;
            label: string;
        };
        ResolveMemberInput: {
            /** Format: email */
            email: string;
        };
        ResolveMemberResponse: {
            candidate: components["schemas"]["PublicUser"];
        };
        /** @enum {string|null} */
        SalesChannel: "NIHO_PAGE" | "EMBED" | "EXPERIENCE_SITE" | null;
        Sender: {
            displayName: string;
            replyToEmails: string[];
        };
    };
    responses: {
        /** @description booking status */
        BookingStatus: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["BookingStatusResponse"];
            };
        };
    };
    parameters: {
        PageId: string;
        ProviderId: string;
        RequestId: string;
        UserId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    listExperienceProviderBookings: {
        parameters: {
            query?: {
                cursor?: string;
                fromDate?: string;
                pageId?: string;
                status?: components["schemas"]["KnownBookingStatus"];
                toDate?: string;
            };
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description provider-scoped bookings */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BookingListResponse"];
                };
            };
        };
    };
    getExperienceProviderBooking: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description canonical host booking DTO without Stripe identifiers */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BookingDetailResponse"];
                };
            };
        };
    };
    listExperienceProviderMembers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description active members */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberListResponse"];
                };
            };
        };
    };
    putExperienceProviderCohost: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PutMemberInput"];
            };
        };
        responses: {
            /** @description upserted cohost */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberResponse"];
                };
            };
        };
    };
    deleteExperienceProviderCohost: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description cohost absent */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    resolveExperienceProviderMemberByEmail: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                providerId: components["parameters"]["ProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResolveMemberInput"];
            };
        };
        responses: {
            /** @description exactly one active registered account */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResolveMemberResponse"];
                };
            };
        };
    };
    approveExperienceProviderBooking: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                pageId: components["parameters"]["PageId"];
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["BookingStatus"];
        };
    };
    cancelExperienceProviderBooking: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                pageId: components["parameters"]["PageId"];
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CancelBookingInput"];
            };
        };
        responses: {
            /** @description existing booking cancellation service result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CancelBookingResponse"];
                };
            };
        };
    };
    declineExperienceProviderBooking: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                pageId: components["parameters"]["PageId"];
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["BookingStatus"];
        };
    };
    messageExperienceProviderGuest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                pageId: components["parameters"]["PageId"];
                providerId: components["parameters"]["ProviderId"];
                requestId: components["parameters"]["RequestId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MessageInput"];
            };
        };
        responses: {
            /** @description queued host message */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MessageResponse"];
                };
            };
        };
    };
}
