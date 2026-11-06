// このファイルは scripts/gen-types.ts が contract/experience-public-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/api/public/experiences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 体験サイト: 掲載中の体験の一覧
         * @description 体験サイトに掲載中の体験の一覧（NIHO の審査を通り、提供者が公開中で、英語の原稿のものだけ）。残席は返さない（availability を使う）。掲載の古い順に 200 件まで。登録の無い地域は空の一覧。認証・cookie は使わない。
         */
        get: operations["listPublicExperiences"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/public/experiences/{experienceSlug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 体験サイト: 体験の詳細
         * @description 掲載中の体験の公開本文・商品条件・販売者・同意文書。残席は返さない。画像は不透明な URL。集合場所を公開しない体験は集合場所と外観写真を出さない。
         */
        get: operations["getPublicExperience"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/public/experiences/{experienceSlug}/availability": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 体験サイト: 開催回と残席
         * @description 今日（日本時間）から 90 日の開催回と残席。共有キャッシュしない。表示の目安で、席は checkout が確保する。
         */
        get: operations["getPublicExperienceAvailability"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/public/experiences/{experienceSlug}/checkout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 体験サイト: ゲスト予約の開始
         * @description 旅行者のブラウザから申し込み（`credentials: omit`）、販売者の Stripe Checkout の URL を受け取る。金額・販売者・決済口座は NIHO が決める。画面に表示した合計（`expectedTotalYen`）が今の合計と違えば 409 PRICE_CHANGED（席も申込も作らない）。同じ `clientRequestKey` と同じ内容の再送は同じ URL を返す。決済の完了は NIHO の予約確認ページへ、取りやめは体験サイトの体験ページへ戻る。IP ごとに 10 分 5 回まで。
         */
        post: operations["postPublicExperienceCheckout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/public/experiences/{experienceSlug}/media/{mediaKey}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 体験サイト: 画像
         * @description 掲載中の体験の画像（EXIF を除いた WebP）。`v` が今の画像の版と違えば 404（差し替えた後に古い画像を出し続けない）。URL は詳細・一覧が返すものをそのまま使い、組み立てない。
         */
        get: operations["getPublicExperienceMedia"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/public/experiences/v1.1/{experienceSlug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 体験サイト: 体験の詳細
         * @description 掲載中の体験の公開本文・商品条件・販売者・同意文書。残席は返さない。画像は不透明な URL。集合場所を公開しない体験は集合場所と外観写真を出さない。
         */
        get: operations["getPublicExperienceV11"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/public/experiences/v1.1/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 体験サイト: 掲載中の体験の一覧
         * @description 体験サイトに掲載中の体験の一覧（NIHO の審査を通り、提供者が公開中で、英語の原稿のものだけ）。残席は返さない（availability を使う）。掲載の古い順に 200 件まで。登録の無い地域は空の一覧。認証・cookie は使わない。
         */
        get: operations["listPublicExperiencesV11"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/public/experiences/v1.2/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 体験サイト: テーマ・開催日で絞れる一覧
         * @description テーマは掲載審査時に管理者が明示選択した値で、本文から推定しない。availableOn は日本時間の開催予定日で絞る。残席・予約可否は含まず、予約可能性は no-store の availability と checkout で再確認する。公開原稿・日程の更新後も最大60秒キャッシュされる。
         */
        get: operations["listPublicExperiencesV12"];
        put?: never;
        post?: never;
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
        /**
         * @description 掲載審査時に管理者が明示選択する一覧テーマ。本文から推定しない。
         * @enum {string}
         */
        ExperienceSiteTheme: "FOOD" | "CULTURE" | "CRAFT" | "OUTDOORS" | "LOCAL_LIFE";
        PublicExperienceAvailabilityResponse: {
            /**
             * Format: date-time
             * @description 残席を数えた時刻（UTC）。
             */
            generatedAt: string;
            occurrences: components["schemas"]["PublicExperienceOccurrence"][];
            /** @enum {string} */
            timeZone: "Asia/Tokyo";
            /** @enum {integer} */
            windowDays: 90;
        };
        /** @description 提供者が書いた申込時の質問（翻訳しない）。回答は提供者に届く。 */
        PublicExperienceBookingQuestion: {
            description: string | null;
            id: string;
            /** @enum {string} */
            inputType: "SHORT_TEXT" | "LONG_TEXT" | "SINGLE_SELECT" | "MULTI_SELECT";
            /** @description 記述式は空配列、選択式は 2〜8。 */
            options: components["schemas"]["PublicExperienceBookingQuestionOption"][];
            prompt: string;
            required: boolean;
        };
        PublicExperienceBookingQuestionOption: {
            id: string;
            label: string;
        };
        PublicExperienceBookingTerms: {
            /** @description 今この体験の申込を受け付けるか。false のときは予約の入口を出さない（体験の紹介は出してよい）。 */
            checkoutAvailable: boolean;
            /** @description 旅行者が同意する文書の版。checkout の consent.agreedVersion にそのまま送る。 */
            consentVersion: string;
            /** @enum {string} */
            currency: "JPY";
            legalDocuments: components["schemas"]["PublicExperienceLegalDocument"][];
            /** @enum {string} */
            timeZone: "Asia/Tokyo";
        };
        /** @description 申込時に予約へ固定される。FREE_UNTIL_24H / 48H は開始の 24 / 48 時間前まで全額返金、NONE は返金なし。 */
        PublicExperienceCancellationPolicy: {
            /** @enum {string} */
            code: "FREE_UNTIL_24H" | "FREE_UNTIL_48H" | "NONE";
            /** @enum {integer|null} */
            freeCancellationHoursBefore: 24 | 48 | null;
        };
        PublicExperienceCatalogResponse: {
            experiences: components["schemas"]["PublicExperienceSummary"][];
        };
        PublicExperienceCatalogResponseV11: {
            experiences: components["schemas"]["PublicExperienceSummaryV11"][];
        };
        PublicExperienceCatalogResponseV12: {
            experiences: components["schemas"]["PublicExperienceSummaryV12"][];
        };
        /** @description 答えた質問だけを送る。記述式は text、選択式は optionIds。 */
        PublicExperienceCheckoutAnswer: {
            optionIds?: string[];
            questionId: string;
            text?: string;
        };
        PublicExperienceCheckoutConsent: {
            agreedVersion: string;
        };
        PublicExperienceCheckoutError: {
            code: components["schemas"]["PublicExperienceCheckoutErrorCode"];
            /** @description PRICE_CHANGED のときの今の合計。 */
            currentTotalYen: number | null;
            /** @description INPUT_INVALID / ANSWERS_INVALID の項目（例: guestEmail, adultCount, answers.0.text）。 */
            field: string | null;
            /** @description 開発者向けの英語の説明。画面の文言は code から作る。 */
            message: string;
            /** @enum {string|null} */
            occurrenceReason: "NOT_SCHEDULED" | "CUTOFF" | "UNAVAILABLE" | null;
            questionId: string | null;
            /** @description 同じ clientRequestKey・同じ内容で、時間をおいて再送してよいか。 */
            retryable: boolean;
            seatsLeft: number | null;
        };
        /** @enum {string} */
        PublicExperienceCheckoutErrorCode: "VALIDATION_ERROR" | "INPUT_INVALID" | "CONSENT_OUTDATED" | "OCCURRENCE_INVALID" | "ANSWERS_INVALID" | "UNAVAILABLE" | "FULL" | "HOLD_LIMIT" | "REQUEST_MISMATCH" | "QUESTIONS_CHANGED" | "PRICE_CHANGED" | "RATE_LIMITED" | "CHECKOUT_UNAVAILABLE";
        PublicExperienceCheckoutErrorResponse: {
            error: components["schemas"]["PublicExperienceCheckoutError"];
        };
        /** @description 名前・メール・備考・回答を URL・ログ・計測へ複製しない。UTM 4 項目は任意で、DNT=1 のとき保存しない。 */
        PublicExperienceCheckoutRequest: {
            adultCount: number;
            answers?: components["schemas"]["PublicExperienceCheckoutAnswer"][];
            bookingQuestionsFingerprint: string;
            childCount: number;
            /** @description 申込の試行ごとの乱数（UUID v4 推奨）。通信失敗の再送は同じ値、内容を変えたら新しい値。 */
            clientRequestKey: string;
            consent: components["schemas"]["PublicExperienceCheckoutConsent"];
            /** @description 画面に表示した合計。NIHO の計算と違えば 409 PRICE_CHANGED（請求額は NIHO が決め、この値では決めない）。 */
            expectedTotalYen: number;
            guestEmail: string;
            guestName: string;
            note?: string | null;
            occurrenceDate: components["schemas"]["PublicExperienceLocalDate"];
            offerId: components["schemas"]["PublicExperienceOfferId"];
            /** @description 任意の utm_campaign。小文字英数字・アンダースコア・ハイフンだけ。DNT=1 のとき保存しない。 */
            utmCampaign?: string;
            /** @description 任意の utm_content。小文字英数字・アンダースコア・ハイフンだけ。DNT=1 のとき保存しない。 */
            utmContent?: string;
            /** @description 任意の utm_medium。小文字英数字・アンダースコア・ハイフンだけ。DNT=1 のとき保存しない。 */
            utmMedium?: string;
            /** @description 任意の utm_source。小文字英数字・アンダースコア・ハイフンだけ。DNT=1 のとき保存しない。 */
            utmSource?: string;
        };
        PublicExperienceCheckoutResponse: {
            /** @description 遷移先。https://checkout.stripe.com/ または NIHO の予約確認ページ（決済済みの再送）。それ以外の URL なら遷移しない。 */
            checkoutUrl: string;
        };
        PublicExperienceChildPricing: {
            /** @description 子どもだけの申込を受けない。 */
            adultRequired: boolean;
            maxAge: number;
            minAge: number;
            priceYen: number;
        };
        /**
         * @description 原稿の言語。v1 の体験サイトは EN の体験だけを掲載する。
         * @enum {string}
         */
        PublicExperienceContentLanguage: "EN" | "JA";
        PublicExperienceDetail: {
            booking: components["schemas"]["PublicExperienceBookingTerms"];
            /** @description 検索エンジン向けの正規 URL（NIHO が決める）。体験サイトは link rel=canonical にそのまま使う。 */
            canonicalUrl: string;
            contentLanguage: components["schemas"]["PublicExperienceContentLanguage"];
            cover: components["schemas"]["PublicExperienceImage"] | null;
            /** @description プレーンテキスト。段落は空行区切り。HTML・Markdown として解釈しない。 */
            description: string;
            highlights: string[];
            hosts: components["schemas"]["PublicExperienceHost"][];
            included: string[];
            knowBeforeYouGo: string[];
            /** @description 当日の言語（提供者の記述。例: English & Japanese）。 */
            languageNote: string;
            lead: string;
            meetingPoint: components["schemas"]["PublicExperienceMeetingPoint"] | null;
            /**
             * @description AFTER_BOOKING のときは `meetingPoint` を常に null にし（集合場所は予約確定後に NIHO の状態ページとメールで案内）、画面では「予約確定後に案内」と伝える。
             * @enum {string}
             */
            meetingPointDisclosure: "PUBLIC" | "AFTER_BOOKING";
            notIncluded: string[];
            notSuitableFor: string[];
            offers: components["schemas"]["PublicExperienceOffer"][];
            photos: components["schemas"]["PublicExperienceImage"][];
            provider: components["schemas"]["PublicExperienceProvider"];
            region: components["schemas"]["PublicExperienceRegion"];
            seller: components["schemas"]["PublicExperienceSeller"];
            slug: components["schemas"]["PublicExperienceSlug"];
            timeline: components["schemas"]["PublicExperienceTimelineItem"][];
            title: string;
            /** Format: date-time */
            updatedAt: string;
        };
        PublicExperienceDetailResponse: {
            experience: components["schemas"]["PublicExperienceDetail"];
        };
        PublicExperienceDetailResponseV11: {
            experience: components["schemas"]["PublicExperienceDetailV11"];
        };
        PublicExperienceDetailV11: {
            booking: components["schemas"]["PublicExperienceBookingTerms"];
            /** @description 検索エンジン向けの正規 URL（NIHO が決める）。体験サイトは link rel=canonical にそのまま使う。 */
            canonicalUrl: string;
            contentLanguage: components["schemas"]["PublicExperienceContentLanguage"];
            cover: components["schemas"]["PublicExperienceImageV11"] | null;
            /** @description プレーンテキスト。段落は空行区切り。HTML・Markdown として解釈しない。 */
            description: string;
            highlights: string[];
            hosts: components["schemas"]["PublicExperienceHostV11"][];
            included: string[];
            knowBeforeYouGo: string[];
            /** @description 当日の言語（提供者の記述。例: English & Japanese）。 */
            languageNote: string;
            lead: string;
            /** @description 外部提供者が予約前に公開する集合の概要。住所・アクセス・入口案内・地図URLは含めない。 */
            meetingOverview: string | null;
            meetingPoint: components["schemas"]["PublicExperienceMeetingPoint"] | null;
            /**
             * @description AFTER_BOOKING のときは `meetingPoint` を常に null にし（集合場所は予約確定後に NIHO の状態ページとメールで案内）、画面では「予約確定後に案内」と伝える。
             * @enum {string}
             */
            meetingPointDisclosure: "PUBLIC" | "AFTER_BOOKING";
            notIncluded: string[];
            notSuitableFor: string[];
            offers: components["schemas"]["PublicExperienceOffer"][];
            photos: components["schemas"]["PublicExperienceImageV11"][];
            provider: components["schemas"]["PublicExperienceProviderV11"];
            region: components["schemas"]["PublicExperienceRegion"];
            seller: components["schemas"]["PublicExperienceSeller"];
            slug: components["schemas"]["PublicExperienceSlug"];
            timeline: components["schemas"]["PublicExperienceTimelineItem"][];
            title: string;
            /** Format: date-time */
            updatedAt: string;
        };
        PublicExperienceDurationRange: {
            maxMinutes: number;
            minMinutes: number;
        };
        /** @description 迎える人。表示名と顔写真だけ。 */
        PublicExperienceHost: {
            avatar: components["schemas"]["PublicExperienceImage"] | null;
            displayName: string;
        };
        /** @description 迎える人。表示名と顔写真だけ。 */
        PublicExperienceHostV11: {
            avatar: components["schemas"]["PublicExperienceImageV11"] | null;
            /** @description 迎える人の紹介。提供者本人が入力した本文だけを返す。 */
            bio: string | null;
            displayName: string;
        };
        PublicExperienceImage: {
            /** @description NIHO の公開 Web origin の不透明な画像 URL（`/api/public/experiences/{slug}/media/{mediaKey}?v=`）。EXIF を除いた公開用の画像だけを返し、保存先の名前・署名・期限を含まない。差し替えると URL が変わる。 */
            url: string;
        };
        PublicExperienceImageV11: {
            /** @description 写真の説明。未入力の場合は null。 */
            alt: string | null;
            /** @description NIHO の公開 Web origin の不透明な画像 URL（`/api/public/experiences/{slug}/media/{mediaKey}?v=`）。EXIF を除いた公開用の画像だけを返し、保存先の名前・署名・期限を含まない。差し替えると URL が変わる。 */
            url: string;
        };
        PublicExperienceLegalDocument: {
            /** @enum {string} */
            kind: "TERMS" | "PRIVACY" | "COMMERCIAL_TRANSACTIONS";
            /** @description NIHO が用意する https URL。 */
            url: string;
        };
        /** @description 日本時間（Asia/Tokyo）の日付 `YYYY-MM-DD`。 */
        PublicExperienceLocalDate: string;
        /** @description 日本時間（Asia/Tokyo）の時刻 `HH:mm`。 */
        PublicExperienceLocalTime: string;
        /** @description 集合場所を公開してよい体験だけに入る。 */
        PublicExperienceMeetingPoint: {
            accessNote: string | null;
            address: string | null;
            entranceNote: string | null;
            exteriorPhotoIndex: number | null;
            /** @description 地図サービスへの https リンク。 */
            mapUrl: string | null;
            name: string;
        };
        PublicExperienceOccurrence: {
            bookable: boolean;
            /**
             * Format: date-time
             * @description この回の予約を締め切る時刻（UTC。表示は Asia/Tokyo に換算する）。開催日時から提供者の予約締切を引いたもの。締切が開始時刻と同じ（締切なし）の回は startAt と同じ値。締切時刻が分からない提供元では null。
             */
            bookingClosesAt: string | null;
            date: components["schemas"]["PublicExperienceLocalDate"];
            /** Format: date-time */
            endAt: string;
            offerId: components["schemas"]["PublicExperienceOfferId"];
            /**
             * @description 予約できない理由。bookable が true なら null。CUTOFF は締切後、FULL は満席、UNAVAILABLE は受付停止・休業等。
             * @enum {string|null}
             */
            reason: "CUTOFF" | "FULL" | "UNAVAILABLE" | null;
            seatsLeft: number;
            /**
             * Format: date-time
             * @description UTC。表示は Asia/Tokyo に換算する。
             */
            startAt: string;
        };
        PublicExperienceOffer: {
            /**
             * @description INSTANT は決済で確定。APPROVAL はカードの仮押さえ後に提供者が承認して確定（承認されなければ請求しない）。
             * @enum {string}
             */
            acceptanceMode: "INSTANT" | "APPROVAL";
            bookingQuestions: components["schemas"]["PublicExperienceBookingQuestion"][];
            /** @description 質問の組の SHA-256。checkout へそのまま送る。 */
            bookingQuestionsFingerprint: string;
            cancellationPolicy: components["schemas"]["PublicExperienceCancellationPolicy"];
            /** @description 1 回の定員。 */
            capacity: number;
            durationMinutes: number;
            id: components["schemas"]["PublicExperienceOfferId"];
            /** @description 1 組の上限人数。 */
            maxPartySize: number;
            /** @description 1 組の最少人数。 */
            minimumParticipants: number;
            name: string;
            pricing: components["schemas"]["PublicExperienceOfferPricing"];
            shortDescription: string | null;
            startTime: components["schemas"]["PublicExperienceLocalTime"];
            /** @description 開催する曜日（0=日 … 6=土）。表示の要約用。実際の開催回は availability。 */
            weekdays: number[];
        };
        /** @description 商品の不透明な ID。形を解釈しない。 */
        PublicExperienceOfferId: string;
        /** @description 1 人あたりの料金（税込・円）。合計 = 大人 × adultPriceYen + 子ども × child.priceYen。追加料金は無い。 */
        PublicExperienceOfferPricing: {
            adultPriceYen: number;
            /** @description 子ども料金が無い商品は null（子どもの申込を受けない）。 */
            child: components["schemas"]["PublicExperienceChildPricing"] | null;
            /** @enum {string} */
            currency: "JPY";
            /** @enum {boolean} */
            taxIncluded: true;
        };
        /** @description 掲載中の商品の大人 1 人の料金の最小値。 */
        PublicExperiencePriceFrom: {
            amountYen: number;
            /** @enum {boolean} */
            taxIncluded: true;
            /** @enum {string} */
            unit: "PER_ADULT";
        };
        PublicExperienceProvider: {
            kind: components["schemas"]["PublicExperienceProviderKind"];
            logo: components["schemas"]["PublicExperienceImage"] | null;
            name: string;
            tagline: string | null;
        };
        /**
         * @description 体験を提供する人・場の種類。SPOT は NIHO の拠点、INDIVIDUAL は個人、BUSINESS は店舗・事業者。
         * @enum {string}
         */
        PublicExperienceProviderKind: "SPOT" | "INDIVIDUAL" | "BUSINESS";
        PublicExperienceProviderSummary: {
            kind: components["schemas"]["PublicExperienceProviderKind"];
            name: string;
        };
        PublicExperienceProviderV11: {
            kind: components["schemas"]["PublicExperienceProviderKind"];
            logo: components["schemas"]["PublicExperienceImageV11"] | null;
            name: string;
            tagline: string | null;
        };
        PublicExperienceRegion: {
            key: components["schemas"]["PublicExperienceRegionKey"];
            name: string;
        };
        PublicExperienceRegionKey: string;
        /** @description 決済上の販売者（契約の相手）。体験サイトの運営者・サポート窓口と混同して表示しない。 */
        PublicExperienceSeller: {
            displayName: string;
            /** @description 特定商取引法に基づく表示（NIHO が用意する https URL）。 */
            legalNoticeUrl: string;
        };
        /** @description 英小文字・数字・ハイフン（連続しない）。掲載後は変わらない。 */
        PublicExperienceSlug: string;
        PublicExperienceSummary: {
            contentLanguage: components["schemas"]["PublicExperienceContentLanguage"];
            cover: components["schemas"]["PublicExperienceImage"] | null;
            duration: components["schemas"]["PublicExperienceDurationRange"];
            lead: string;
            priceFrom: components["schemas"]["PublicExperiencePriceFrom"];
            provider: components["schemas"]["PublicExperienceProviderSummary"];
            region: components["schemas"]["PublicExperienceRegion"];
            slug: components["schemas"]["PublicExperienceSlug"];
            title: string;
            /**
             * Format: date-time
             * @description 公開本文・商品条件の最終更新（UTC）。sitemap の lastmod に使える。
             */
            updatedAt: string;
        };
        PublicExperienceSummaryV11: {
            contentLanguage: components["schemas"]["PublicExperienceContentLanguage"];
            cover: components["schemas"]["PublicExperienceImageV11"] | null;
            duration: components["schemas"]["PublicExperienceDurationRange"];
            lead: string;
            priceFrom: components["schemas"]["PublicExperiencePriceFrom"];
            provider: components["schemas"]["PublicExperienceProviderSummary"];
            region: components["schemas"]["PublicExperienceRegion"];
            slug: components["schemas"]["PublicExperienceSlug"];
            title: string;
            /**
             * Format: date-time
             * @description 公開本文・商品条件の最終更新（UTC）。sitemap の lastmod に使える。
             */
            updatedAt: string;
        };
        PublicExperienceSummaryV12: {
            contentLanguage: components["schemas"]["PublicExperienceContentLanguage"];
            cover: components["schemas"]["PublicExperienceImageV11"] | null;
            duration: components["schemas"]["PublicExperienceDurationRange"];
            lead: string;
            priceFrom: components["schemas"]["PublicExperiencePriceFrom"];
            provider: components["schemas"]["PublicExperienceProviderSummary"];
            region: components["schemas"]["PublicExperienceRegion"];
            slug: components["schemas"]["PublicExperienceSlug"];
            themes: components["schemas"]["ExperienceSiteTheme"][];
            title: string;
            /**
             * Format: date-time
             * @description 公開本文・商品条件の最終更新（UTC）。
             */
            updatedAt: string;
        };
        PublicExperienceTimelineItem: {
            /** @description `photos[]` の位置。写真なしは null。 */
            photoIndex: number | null;
            text: string;
            /** @description `HH:mm`（日本時間）または空文字（時刻なし）。 */
            time: string;
            title: string;
        };
        PublicProjectionError: {
            /** @enum {string} */
            code: "VALIDATION_ERROR";
            message: string;
        };
        PublicProjectionErrorResponse: {
            error: components["schemas"]["PublicProjectionError"];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    listPublicExperiences: {
        parameters: {
            query?: {
                /** @description 地域の key（例: kamakura） */
                region?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control"?: "public, max-age=60, stale-while-revalidate=300";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicExperienceCatalogResponse"];
                };
            };
            /** @description path / query の形が不正 */
            400: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicProjectionErrorResponse"];
                };
            };
        };
    };
    getPublicExperience: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験サイトでの体験の slug（掲載の slug。拠点・ページの slug とは別） */
                experienceSlug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control"?: "public, max-age=60, stale-while-revalidate=300";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicExperienceDetailResponse"];
                };
            };
            /** @description path / query の形が不正 */
            400: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicProjectionErrorResponse"];
                };
            };
            /** @description 掲載中でない（不存在・申請中・停止・取り下げ・ページの非公開・拠点の非公開を区別しない）。本文なし */
            404: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getPublicExperienceAvailability: {
        parameters: {
            query?: {
                offerId?: string;
            };
            header?: never;
            path: {
                /** @description 体験サイトでの体験の slug（掲載の slug。拠点・ページの slug とは別） */
                experienceSlug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicExperienceAvailabilityResponse"];
                };
            };
            /** @description path / query の形が不正 */
            400: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicProjectionErrorResponse"];
                };
            };
            /** @description 掲載中でない（不存在・申請中・停止・取り下げ・ページの非公開・拠点の非公開を区別しない）。本文なし */
            404: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    postPublicExperienceCheckout: {
        parameters: {
            query?: never;
            header?: {
                /** @description 1 のとき UTM 4 項目を保存しない。ブラウザの Do Not Track 設定を尊重する。 */
                DNT?: "0" | "1";
            };
            path: {
                /** @description 体験サイトでの体験の slug（掲載の slug。拠点・ページの slug とは別） */
                experienceSlug: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PublicExperienceCheckoutRequest"];
            };
        };
        responses: {
            /** @description 仮押さえ済み。checkoutUrl へ遷移する */
            201: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicExperienceCheckoutResponse"];
                };
            };
            /** @description 本文が JSON でない・path の形が不正 */
            400: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicExperienceCheckoutErrorResponse"];
                };
            };
            /** @description 掲載中でない（不存在・申請中・停止・取り下げ・ページの非公開・拠点の非公開を区別しない）。本文なし */
            404: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description 申込を受け付けなかった（席も申込も作らない） */
            409: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicExperienceCheckoutErrorResponse"];
                };
            };
            /** @description 入力・開催回・回答・同意の版の誤り */
            422: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicExperienceCheckoutErrorResponse"];
                };
            };
            /** @description IP ごとの上限 */
            429: {
                headers: {
                    "Cache-Control"?: "no-store";
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicExperienceCheckoutErrorResponse"];
                };
            };
            /** @description 決済の画面を用意できなかった（同じ key で再送できる） */
            503: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicExperienceCheckoutErrorResponse"];
                };
            };
        };
    };
    getPublicExperienceMedia: {
        parameters: {
            query: {
                v: string;
            };
            header?: never;
            path: {
                /** @description 体験サイトでの体験の slug（掲載の slug。拠点・ページの slug とは別） */
                experienceSlug: string;
                mediaKey: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 画像（WebP） */
            200: {
                headers: {
                    "Cache-Control"?: "public, max-age=3600";
                    [name: string]: unknown;
                };
                content: {
                    "image/webp": string;
                };
            };
            /** @description 掲載中でない（不存在・申請中・停止・取り下げ・ページの非公開・拠点の非公開を区別しない）。本文なし */
            404: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description 画像の保存先を一時的に読めない */
            503: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getPublicExperienceV11: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 体験サイトでの体験の slug（掲載の slug。拠点・ページの slug とは別） */
                experienceSlug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control"?: "public, max-age=60, stale-while-revalidate=300";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicExperienceDetailResponseV11"];
                };
            };
            /** @description path / query の形が不正 */
            400: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicProjectionErrorResponse"];
                };
            };
            /** @description 掲載中でない（不存在・申請中・停止・取り下げ・ページの非公開・拠点の非公開を区別しない）。本文なし */
            404: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listPublicExperiencesV11: {
        parameters: {
            query?: {
                /** @description 地域の key（例: kamakura） */
                region?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control"?: "public, max-age=60, stale-while-revalidate=300";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicExperienceCatalogResponseV11"];
                };
            };
            /** @description path / query の形が不正 */
            400: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicProjectionErrorResponse"];
                };
            };
        };
    };
    listPublicExperiencesV12: {
        parameters: {
            query?: {
                /** @description 日本時間の開催予定日。予約可能・残席ありを保証しない。 */
                availableOn?: components["schemas"]["PublicExperienceLocalDate"];
                /** @description 地域の key（例: kamakura） */
                region?: string;
                /** @description 管理者が明示設定したテーマ */
                theme?: components["schemas"]["ExperienceSiteTheme"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    "Cache-Control"?: "public, max-age=60, stale-while-revalidate=300";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicExperienceCatalogResponseV12"];
                };
            };
            /** @description path / query の形が不正 */
            400: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicProjectionErrorResponse"];
                };
            };
        };
    };
}
