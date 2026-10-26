// このファイルは scripts/gen-types.ts が contract/experience-host-api.openapi.json から生成する。手で編集しない。
// 更新: npm -C packages/api-client run gen:types
export type paths = {
    "/api/auth/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 自分のユーザー情報・所属情報を取得 */
        get: operations["getAuthMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 自分が所属する体験の提供者の一覧
         * @description ログイン中の本人が OWNER / EDITOR として所属する提供者を、登録の古い順に 200 件まで返す（platform ADMIN は全提供者）。
         *     `memberRole` は本人の役割（platform ADMIN で所属していなければ null）。`consent` は提供者の登録の同意、
         *     `paymentReuseConsent` は既存の拠点の販売者口座を売上の受取に再利用するときの同意（版と画面に出す文言）。
         */
        get: operations["listExperienceProviders"];
        put?: never;
        /**
         * 体験の提供者として自己登録する
         * @description 本人を OWNER とする提供者を作る（招待はない）。登録直後の審査の状態は `DRAFT`。
         *     `consentVersion` は一覧・詳細の `consent.version` と一致が必須。予約の通知先には本人の認証のメール（無ければアカウントの登録メール）を使う。
         *     422 の `error.details.reason`: `PROVIDER_CONSENT_OUTDATED`（同意の版が古い）・`PROVIDER_EMAIL_REQUIRED`（通知先のメールが無い）。
         */
        post: operations["registerExperienceProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        /**
         * 体験の提供者の紹介を読む
         * @description OWNER / EDITOR（platform ADMIN は全提供者）が読む。所属していない・存在しない提供者は区別せず 404。
         *     `provider` は読む間に消えたときだけ null。
         */
        get: operations["getExperienceProvider"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * 体験の提供者の紹介を直す
         * @description OWNER / EDITOR（platform ADMIN）が紹介を直す。`sellerDisclosureUrl` を含む変更は OWNER と platform ADMIN だけで、EDITOR は 403。
         *     直すと、審査が `APPROVED` / `SUSPENDED` の提供者は `REQUESTED`（再審査）に戻り、掲載中の体験は止まる（`PAUSED`）。
         *     項目が 1 つも無い本文・知らない項目は 400。所属していない・存在しない提供者は 404。
         */
        patch: operations["updateExperienceProvider"];
        trace?: never;
    };
    "/api/experience-providers/{providerId}/meeting-point": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        /**
         * 提供者の集合場所の既定を読む
         * @description OWNER / EDITOR（platform ADMIN）が、体験ページで上書きしないときに使う集合場所（既定）を読む。未設定の項目は空文字。
         *     所属していない・存在しない提供者は区別せず 404。
         */
        get: operations["getExperienceProviderMeetingPoint"];
        /**
         * 提供者の集合場所の既定を直す
         * @description OWNER / EDITOR（platform ADMIN）が、集合場所の既定を全項目で置き換える。直すと、この提供者の掲載中の体験は止まる（`PAUSED`・再審査）。
         *     形が違う（項目が足りない・知らない項目・上限を超える・`mapUrl` が https の URL でない）と 400。所属していない・存在しない提供者は 404。
         */
        put: operations["updateExperienceProviderMeetingPoint"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        /**
         * 提供者の体験ページの一覧
         * @description OWNER / EDITOR（platform ADMIN）が、提供者の体験ページを更新の新しい順に読む。項目は拠点の企画ページの一覧と同じ
         *     （`bookingCounts` は確定した予約の件数と、そのうち開催日が今日から 7 日以内〈JST〉の件数。`coverUrl` は表紙の w256 の派生の署名 URL）。
         *     `checkoutEnabled` は申込を受け付けるか。所属していない・存在しない提供者は区別せず 404。
         */
        get: operations["listExperienceProviderPages"];
        put?: never;
        /**
         * 提供者の体験ページを作る（下書き）
         * @description OWNER / EDITOR（platform ADMIN）が、型・題名・言語から下書きを作る。商品も既定値で 1 件作る（拠点の企画ページの作成と同じ）。
         *     `slug` を省くと題名から決める。応答は詳細と同じ形。失敗は `error.details.reason`（400 は `field` も）: 400 `PAGE_REQUEST_INVALID` / `PAGE_TITLE_INVALID` / `PAGE_SLUG_INVALID`、
         *     409 `PAGE_SLUG_TAKEN`（`field` = `slug`）。所属していない・存在しない提供者は 404（理由なし）。
         */
        post: operations["createExperienceProviderPage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        /**
         * 提供者の体験ページを読む
         * @description OWNER / EDITOR（platform ADMIN）が、本文・写真・商品・公開状態と、公開の前提を満たしていない理由（`publishBlockers`）を読む。
         *     拠点の企画ページの詳細と同じ項目に、写真の説明（`photoAlts`）が加わる。写真の `url` は w1024 の派生の署名 URL（派生の生成前は null）。
         *     保存・公開で `x-niho-page-updated-at` に送る版は `updatedAt`。別の提供者のページ・無いページは 404（`PAGE_NOT_FOUND`・`details.pageId`）。
         */
        get: operations["getExperienceProviderPage"];
        put?: never;
        post?: never;
        /**
         * 提供者の体験ページ（下書き）を消す
         * @description OWNER / EDITOR（platform ADMIN）が、公開したことの無い下書きだけを消す（商品も消える。写真は消さない）。本文は読まない。
         *     公開したことがあれば 409 `PAGE_DELETE_PUBLISHED`、申込が 1 件でもあれば 409 `PAGE_DELETE_HAS_BOOKINGS`（どちらも公開停止で足りる）。
         *     無いページは 404 `PAGE_NOT_FOUND`。
         */
        delete: operations["deleteExperienceProviderPage"];
        options?: never;
        head?: never;
        /**
         * 提供者の体験ページを直す（部分更新）
         * @description OWNER / EDITOR（platform ADMIN）が、送った項目だけを変える。規則は拠点の企画ページの部分更新と同じで、違いは次だけ。
         *     - `x-niho-page-updated-at` に読んだ `updatedAt` を付けると、違えば 409 `PAGE_UPDATED`（別の操作で更新された。読み直してから直す）。
         *       省くと版を確かめない。
         *     - `photoAlts`（写真の説明）は `photoObjectKeys` と同じ数で一緒に送る（`photoAlts` だけ・数が違えば 400 `PAGE_PHOTOS_INVALID`・
         *       `field` = `photoAlts`）。`photoObjectKeys` だけを送ると、同じ写真の説明を並びに合わせて保つ。
         *     - 写真は、この提供者の上げ口（`POST /api/experience-providers/{providerId}/uploads/policies`）で上げた写真だけ
         *       （ほかは 422 `PAGE_PHOTOS_INVALID`・`field` = `photoObjectKeys.<n>`）。
         *     - 保存すると、この体験の掲載は止まる（掲載中なら `PAUSED`・再審査）。
         *     ほかの失敗は `error.details.reason`（400 は `field` も）: 400 `PAGE_REQUEST_INVALID` / `PAGE_TITLE_INVALID` / `PAGE_SLUG_INVALID` /
         *     `PAGE_CONTENT_INVALID` / `PAGE_PHOTOS_INVALID` / `PAGE_OFFER_INVALID` / `PAGE_OFFER_QUESTIONS_INVALID`、404 `PAGE_NOT_FOUND`、
         *     409 `PAGE_SLUG_TAKEN` / `PAGE_SLUG_LOCKED`（`details.slug` は今の slug）/ `PAGE_OFFER_HAS_BOOKINGS`、
         *     422 `PAGE_PUBLISH_BLOCKED`（公開中のページを公開の前提を満たさない内容へ変えようとした・`details.blockers`）。
         */
        patch: operations["updateExperienceProviderPage"];
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/experience-site-listing": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        /**
         * 体験ページの体験サイトへの掲載を読む
         * @description OWNER（platform ADMIN）が、掲載の状態と、申請の同意の版と文言を読む。掲載が無ければ `listing: null`。
         *     EDITOR・所属していない提供者は 404（理由なし）、別の提供者のページ・無いページは 404 `PROVIDER_PAGE_NOT_FOUND`。
         */
        get: operations["getExperienceProviderPageListing"];
        /**
         * 体験ページの体験サイトへの掲載を申請する
         * @description OWNER（platform ADMIN）が、同意の版（`consent.version`）を送って掲載を申請する。無ければ作り（`REQUESTED`）、取り下げ済みなら
         *     `REQUESTED` に戻す。申請中・掲載中・停止中は同意の版と時刻だけを直す。形が違えば 400。
         *     404 `EXPERIENCE_LISTING_NOT_FOUND`（ページが無い）、409 `EXPERIENCE_LISTING_STATUS_CONFLICT`（今の掲載の状態を扱えない）、
         *     422 `EXPERIENCE_LISTING_CONSENT_OUTDATED`（同意の版が古い）・`EXPERIENCE_LISTING_PAGE_NOT_ELIGIBLE`（公開中で英語の体験ページだけ）。
         */
        put: operations["requestExperienceProviderPageListing"];
        post?: never;
        /**
         * 体験ページの体験サイトへの掲載を取り下げる
         * @description OWNER（platform ADMIN）が掲載を取り下げる（`WITHDRAWN`。直ちに体験サイトの公開 API から消える。申込は残る）。取り下げ済みなら
         *     そのまま返す。掲載が無ければ 404 `EXPERIENCE_LISTING_NOT_FOUND`。
         */
        delete: operations["withdrawExperienceProviderPageListing"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/meeting-point": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        /**
         * 体験ページの集合場所を読む
         * @description OWNER / EDITOR（platform ADMIN）が、体験ページで使う集合場所を読む。`mode` が `INHERIT` なら提供者の既定、`OVERRIDE` なら
         *     このページの上書きで、`meetingPoint` はどちらでも使われる値。無いページ・型 EXPERIENCE でないページは 404 `PROVIDER_PAGE_NOT_FOUND`。
         *     ページの版（`updatedAt`）は返さない（詳細の `updatedAt` を使う）。
         */
        get: operations["getExperienceProviderPageMeetingPoint"];
        /**
         * 体験ページの集合場所を上書きする・既定に戻す
         * @description OWNER / EDITOR（platform ADMIN）が、`mode: OVERRIDE`（`meetingPoint` の全項目）で上書きし、`mode: INHERIT` で提供者の既定に戻す。
         *     `expectedUpdatedAt` はページの `updatedAt`（違えば 409 `PROVIDER_PAGE_CONFLICT`）。保存するとページの版が進むので、続く保存には応答の
         *     `updatedAt` を使う。保存すると、この体験の掲載は止まる（掲載中なら `PAUSED`）。形が違えば 400、無いページは 404 `PROVIDER_PAGE_NOT_FOUND`。
         */
        put: operations["updateExperienceProviderPageMeetingPoint"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/preview": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        /**
         * 提供者の体験ページのプレビュー
         * @description OWNER / EDITOR（platform ADMIN）が、NIHO の公開ページと同じ組み立てを、下書き・停止中でも読む（保存済みの内容だけ）。
         *     開催回は今日（JST）から 90 日で、受取口座の準備ができていなければ全部 `bookable: false`（`reason: unavailable`）。
         *     `Cache-Control: no-store`。無いページ・有効な商品が無いページは 404 `PAGE_NOT_FOUND`。
         */
        get: operations["getExperienceProviderPagePreview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 提供者の体験ページを公開する
         * @description OWNER / EDITOR（platform ADMIN）が、初回の公開と停止からの再公開をする（`publishedAt` は初回のまま）。本文は読まない。
         *     `x-niho-page-updated-at` に読んだ `updatedAt` を付けると、違えば 409 `PAGE_UPDATED`。前提（題名・表紙・料金・定員・曜日・開始・所要・
         *     受取口座の準備・予約の通知先）を満たさなければ 422 `PAGE_PUBLISH_BLOCKED`（`details.blockers`）、写真に使えない画像があれば 422
         *     `PAGE_PHOTOS_INVALID`（`field` = `photoObjectKeys`）。無いページは 404 `PAGE_NOT_FOUND`。体験サイトへの掲載は別の操作
         *     （`experience-site-listing`）。
         */
        post: operations["publishExperienceProviderPage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/pages/{pageId}/unpublish": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 提供者の体験ページの公開を止める
         * @description OWNER / EDITOR（platform ADMIN）が公開を止める（申込は残る）。止めてあればそのまま返す。本文と `x-niho-page-updated-at` は読まない。
         *     止めると、この体験の掲載も止まる（掲載中なら `PAUSED`）。公開したことが無いページは 409 `PAGE_NOT_PUBLISHED`、無いページは 404
         *     `PAGE_NOT_FOUND`。
         */
        post: operations["unpublishExperienceProviderPage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/payments/connect/resume": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 売上の受取口座の Stripe の接続を続ける
         * @description `start` と同じ処理（リンクの期限が切れた・Stripe の画面を途中で離れたときに、新しいリンクを受け取る）。応答・エラーも `start` と同じ。
         */
        post: operations["resumeExperienceProviderPaymentConnect"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/payments/connect/start": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 売上の受取口座の Stripe の接続を始める
         * @description 提供者の OWNER が、Stripe の口座の登録の画面（アカウントリンク）の URL を受け取る。口座が無ければ作る（同じ提供者では冪等）。本文は読まない。
         *     `url` は一度きりで `expiresAt` まで。Stripe から戻る先（`refresh_url` / `return_url`）は API の設定で決まり、体験サイトのホストの画面
         *     （env `EXPERIENCE_HOST_CONSOLE_URL`）があれば `<その URL>?providerId=…&connect=refresh|return`、無ければ niho.life の提供者の画面。
         *     応答には準備の状態（`ready` / `reason`）も入る。
         *     404: 提供者の OWNER でない（所属していなければ理由なし。platform ADMIN でも OWNER でなければ `PROVIDER_NOT_FOUND`）。
         *     409: 決済の接続を使えない（`PROVIDER_CONNECT_UNAVAILABLE`）・
         *     拠点の口座を再利用している（`PROVIDER_PAYMENT_SHARED_ACCOUNT`）・口座が無いまま申込がある（`PROVIDER_PAYMENT_LOCKED`）。
         *     理由は `error.details.reason` に入る。
         */
        post: operations["startExperienceProviderPaymentConnect"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/payments/connect/sync": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 売上の受取口座の状態を Stripe から取り直す
         * @description 提供者の OWNER が、Stripe の口座の状態を取り直して保存し、準備の状態を返す（`url` / `expiresAt` は null）。本文は読まない。
         *     404 と 409 は `start` と同じで、加えて口座がまだ無ければ 409（`PROVIDER_PAYMENT_NOT_CONNECTED`）。
         */
        post: operations["syncExperienceProviderPaymentConnect"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/payments/readiness": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        /**
         * 体験の提供者の売上の受取口座の準備の状態
         * @description OWNER（platform ADMIN）が、売上の受取口座（Stripe の連結アカウント）の準備の状態を読む。口座の ID・本人確認の項目は返さない。
         *     EDITOR・所属していない提供者は 404。
         */
        get: operations["getExperienceProviderPaymentReadiness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/payments/reuse": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 拠点の販売者口座を体験の売上の受取に再利用する
         * @description 提供者の OWNER が、自分が現役の OWNER である拠点（`sourceSpotId`）の準備済みの販売者口座を、この提供者の売上の受取に共有する。
         *     拠点の側の口座・設定は変えない。掲載中の体験は止まる（`PAUSED`）。`consentVersion` は `paymentReuseConsent.version` と一致が必須。
         *     404: 提供者の OWNER でない（所属していなければ理由なし。platform ADMIN でも OWNER でなければ `PROVIDER_NOT_FOUND`）・
         *     `sourceSpotId` の OWNER でない・拠点に口座が無い（`PROVIDER_PAYMENT_SOURCE_FORBIDDEN`）。409: 申込が 1 件でもある（`PROVIDER_PAYMENT_LOCKED`）。
         *     422: 同意の版が古い（`PROVIDER_PAYMENT_CONSENT_OUTDATED`）・拠点の口座の準備が済んでいない（`PROVIDER_PAYMENT_SOURCE_NOT_READY`）。
         *     理由は `error.details.reason` に入る。
         */
        post: operations["reuseExperienceProviderPayment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/payments/reuse-candidates": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        /**
         * 売上の受取に再利用できる拠点の販売者口座の候補
         * @description OWNER（platform ADMIN）が読む。本人が現役の OWNER である通常の拠点ごとに、その販売者口座の準備の状態を返す
         *     （`ready: true` の拠点だけ再利用できる）。EDITOR・所属していない提供者は 404。
         */
        get: operations["listExperienceProviderPaymentReuseCandidates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/submit": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 体験の提供者の審査を申請する
         * @description OWNER（platform ADMIN）が NIHO の審査を申請する。本文は読まない。審査が `DRAFT` / `REQUESTED` で、`sellerDisclosureUrl`（https）があり、
         *     登録の同意が今の版のときだけ `REQUESTED` にする。それ以外は 409（`error.details.reason`: `PROVIDER_REVIEW_STATE_CONFLICT`）。
         *     EDITOR・所属していない提供者は 404。
         */
        post: operations["submitExperienceProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/uploads/policies": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 体験ページの写真を上げる署名つき POST を受け取る
         * @description OWNER / EDITOR（platform ADMIN）が、体験ページの写真を GCS へ直接上げる署名つき POST（multipart/form-data）を受け取る。
         *     `purpose` は `ARTICLE_IMAGE`、形式は JPEG・PNG・WebP、1 枚 10MB まで（ほかは 400）。上げ先の `objectKey` はサーバーが決め、
         *     提供者に属する写真になる（体験ページの `photoObjectKeys` に使う）。署名は 15 分。`upload.fields` を全部 form に入れ、最後に
         *     `file` を足して `upload.url` へ送る。写真の保存が止まっている（`uploads_disabled`）・署名に失敗した（`signing_circuit_open` /
         *     `signing_transient_failure`）ときは 503。
         */
        post: operations["createExperienceProviderUploadPolicy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/experience-providers/{providerId}/uploads/signed-url": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * 体験ページの写真を見る短命の署名つき URL を受け取る
         * @description OWNER / EDITOR（platform ADMIN）が、この提供者の上げ口で上げた写真（`objectKey`）を見る署名つき URL を受け取る。保存前の写真の
         *     表示に使う（保存済みの写真は詳細の `photos[].url`）。別の提供者の写真・無い写真は 404（理由なし）、実体が無ければ 404
         *     `object_missing`、上げる期限が切れて署名を出し直せない写真は 403 `upload_expired`。写真の保存が止まっている（`uploads_disabled`）・
         *     実体の確認に失敗した（`object_lookup_failed`）・署名に失敗したときは 503。
         */
        post: operations["createExperienceProviderUploadSignedUrl"];
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
        AdminCampaignPageBookingCounts: {
            /** @description 確定した予約の件数 */
            confirmed: number;
            /** @description そのうち開催日が今日から 7 日以内（JST）の件数 */
            thisWeek: number;
        };
        AdminCampaignPageCreateRequest: {
            kind: components["schemas"]["SpotCampaignPageKind"];
            language: components["schemas"]["SpotCampaignPageLanguage"];
            /** @description 省くと題名から決める（題名が無ければ短い ID）。小文字化・記号のハイフン化をしてから規則（3〜64 字）を確かめる */
            slug?: string;
            /** @description 題名（前後の空白を除いて 95 字まで）。省くか空なら題名なしの下書き（編集画面でページ名を書く。公開には題名が要る） */
            title?: string;
        };
        AdminCampaignPageDeleteResponse: {
            /** @enum {boolean} */
            deleted: true;
            id: string;
        };
        AdminCampaignPageListItem: {
            bookingCounts: components["schemas"]["AdminCampaignPageBookingCounts"];
            /** @description 表紙の w256 派生の署名 URL（派生の生成前・表紙なしは null） */
            coverUrl: string | null;
            id: string;
            kind: components["schemas"]["SpotCampaignPageKind"];
            language: components["schemas"]["SpotCampaignPageLanguage"];
            listOnEntrance: boolean;
            slug: string;
            status: components["schemas"]["SpotCampaignPageStatus"];
            title: string;
            /** Format: date-time */
            updatedAt: string;
        };
        AdminCampaignPageListResponse: {
            /** @description 拠点で企画ページの申込を受け付ける（先行公開の許可リストによる） */
            checkoutEnabled: boolean;
            pages: components["schemas"]["AdminCampaignPageListItem"][];
        };
        AdminCampaignPagePhoto: {
            objectKey: string;
            /** @description w1024 の派生の署名 URL（派生の生成前は null） */
            url: string | null;
        };
        AdminExperienceSiteListingConsent: {
            /** @description 申請の画面に出す同意の文言（版と対応） */
            text: string;
            version: string;
        };
        AdminExperienceSiteListingRequestBody: {
            consentVersion: string;
        };
        /**
         * @description 体験サイトのホストの画面が `GET /api/auth/me` から読む部分（表示名と顔写真）。応答の正は `AuthMeResponse` で、ほかの項目も入る
         *     （この schema は閉じない）。ホストの契約の書き出しでは、`getAuthMe` の 200 の schema をこれに置き換える。
         *     項目を足すときは `AuthMeResponse` に同じ名前・同じ型の項目があることを確かめる（contracts の test が見る）。
         */
        ExperienceHostAuthMe: {
            user: {
                displayName: string | null;
                id: string;
            };
            /** @description プロフィールの顔写真（短命の署名つき URL）。未設定は null */
            userIconImage: {
                /** Format: date-time */
                expiresAt: string;
                signedUrl: string;
            } | null;
        };
        ExperienceHostError: {
            code: components["schemas"]["ExperienceHostErrorCode"];
            details: components["schemas"]["ExperienceHostErrorDetails"];
            /** @description 人が読む説明（日本語）。画面の分岐には使わない */
            message: string;
            /** @description 問い合わせ用の ID。400 は null、それ以外は値がある（`details.supportId` と同じ） */
            supportId: string | null;
        };
        /**
         * @description status との対応: 400 `VALIDATION_ERROR`・401 `UNAUTHORIZED`・403 `FORBIDDEN` / `ACCOUNT_DELETED`（退会済みのアカウント）・
         *     404 `NOT_FOUND`・409 `CONFLICT`・422 `UNPROCESSABLE_ENTITY`・503 `SERVICE_UNAVAILABLE`。
         * @enum {string}
         */
        ExperienceHostErrorCode: "VALIDATION_ERROR" | "UNAUTHORIZED" | "FORBIDDEN" | "ACCOUNT_DELETED" | "NOT_FOUND" | "CONFLICT" | "UNPROCESSABLE_ENTITY" | "SERVICE_UNAVAILABLE";
        /**
         * @description 失敗の詳しい中身。理由ごとに項目の組が決まっていて、下のどれか 1 つの形になる。400 は `supportId` と `requestId` を持たず、
         *     それ以外の status は問い合わせ用の `supportId` と `requestId` を必ず持つ。
         */
        ExperienceHostErrorDetails: Record<string, never> | {
            field: string;
            reason: components["schemas"]["ExperienceHostErrorReason"];
        } | {
            requestId: string;
            supportId: string;
        } | {
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            supportId: string;
        } | {
            field: string;
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            supportId: string;
        } | {
            field: string;
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            slug: string;
            supportId: string;
        } | {
            pageId: string;
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            supportId: string;
        } | {
            blockers: components["schemas"]["SpotCampaignPagePublishBlocker"][];
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            supportId: string;
        } | {
            objectKey: string;
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            spotId: string;
            supportId: string;
        } | {
            /** @enum {string} */
            purpose: "ARTICLE_IMAGE";
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            signingErrorCode: components["schemas"]["ExperienceHostSigningErrorCode"];
            signingErrorName: string;
            supportId: string;
        } | {
            objectKey: string;
            reason: components["schemas"]["ExperienceHostErrorReason"];
            requestId: string;
            signingErrorCode: components["schemas"]["ExperienceHostSigningErrorCode"];
            signingErrorName: string;
            spotId: string;
            supportId: string;
        };
        /**
         * @description `error.details.reason` の値。どの operation がどの理由を返すかは operation の説明に書く。
         *     - 認証（どの operation でも）: 401 `invalid_token` / `anonymous_provider_not_allowed` / `directory_only_account` / `app_connect_disabled` /
         *       `app_connection_revoked`（接続が解除された。ログインし直す）、403 `app_client_scope`（この接続では呼べない API）、
         *       503 `auth_user_lookup_failed` / `app_connection_lookup_failed`（一時的な失敗）。`GET /api/auth/me` は 401 `user_not_found` も返す。
         *     - 提供者・受取口座・集合場所: `PROVIDER_*`。体験ページ: `PAGE_*`。体験サイトへの掲載: `EXPERIENCE_LISTING_*`。
         *     - 写真: 403 `upload_expired`、404 `object_missing`、503 `uploads_disabled` / `object_lookup_failed` / `signing_circuit_open` /
         *       `signing_transient_failure`。
         * @enum {string}
         */
        ExperienceHostErrorReason: "invalid_token" | "anonymous_provider_not_allowed" | "directory_only_account" | "app_connect_disabled" | "app_connection_revoked" | "user_not_found" | "app_client_scope" | "auth_user_lookup_failed" | "app_connection_lookup_failed" | "PROVIDER_CONSENT_OUTDATED" | "PROVIDER_EMAIL_REQUIRED" | "PROVIDER_REVIEW_STATE_CONFLICT" | "PROVIDER_NOT_FOUND" | "PROVIDER_PAYMENT_SOURCE_FORBIDDEN" | "PROVIDER_PAYMENT_LOCKED" | "PROVIDER_PAYMENT_CONSENT_OUTDATED" | "PROVIDER_PAYMENT_SOURCE_NOT_READY" | "PROVIDER_CONNECT_UNAVAILABLE" | "PROVIDER_PAYMENT_SHARED_ACCOUNT" | "PROVIDER_PAYMENT_NOT_CONNECTED" | "PROVIDER_PAGE_NOT_FOUND" | "PROVIDER_PAGE_CONFLICT" | "PAGE_REQUEST_INVALID" | "PAGE_TITLE_INVALID" | "PAGE_SLUG_INVALID" | "PAGE_CONTENT_INVALID" | "PAGE_PHOTOS_INVALID" | "PAGE_OFFER_INVALID" | "PAGE_OFFER_QUESTIONS_INVALID" | "PAGE_NOT_FOUND" | "PAGE_SLUG_TAKEN" | "PAGE_SLUG_LOCKED" | "PAGE_UPDATED" | "PAGE_OFFER_HAS_BOOKINGS" | "PAGE_NOT_PUBLISHED" | "PAGE_DELETE_PUBLISHED" | "PAGE_DELETE_HAS_BOOKINGS" | "PAGE_PUBLISH_BLOCKED" | "EXPERIENCE_LISTING_NOT_FOUND" | "EXPERIENCE_LISTING_CONSENT_OUTDATED" | "EXPERIENCE_LISTING_PAGE_NOT_ELIGIBLE" | "EXPERIENCE_LISTING_STATUS_CONFLICT" | "uploads_disabled" | "upload_expired" | "object_missing" | "object_lookup_failed" | "signing_circuit_open" | "signing_transient_failure";
        /**
         * @description ホストの API（体験の提供者の API と `GET /api/auth/me`）の失敗の本文。各 operation に書いた status の本文だけを約束する
         *     （書いていない status の 429・500 などは共通の層が返し、この形とは限らない）。画面は `error.code` と `error.details.reason` で分ける。
         */
        ExperienceHostErrorResponse: {
            error: components["schemas"]["ExperienceHostError"];
        };
        /** @description 署名の失敗の元のコード（文字列か数。無ければ null）。調査用で、画面の分岐には使わない */
        ExperienceHostSigningErrorCode: (string | null) | number;
        /** @description 体験の提供者（本人が読む形） */
        ExperienceProvider: {
            /** Format: date-time */
            approvedAt: string | null;
            bio: string;
            /** Format: date-time */
            consentedAt: string;
            /** @description 登録で同意した版 */
            consentVersion: string;
            /** Format: date-time */
            createdAt: string;
            displayName: string;
            id: string;
            kind: components["schemas"]["ExperienceProviderKind"];
            /** @description 登録した人の user ID（記録だけで、権限の根拠にしない。権限は memberRole） */
            ownerUserId: string;
            /** Format: date-time */
            paymentReuseConsentedAt: string | null;
            /** @description 拠点の販売者口座の再利用に同意した版（再利用していなければ null） */
            paymentReuseConsentVersion: string | null;
            /** @description 売上の受取に口座を共有している拠点の ID（再利用していなければ null） */
            paymentReuseSourceSpotId: string | null;
            reviewStatus: components["schemas"]["ExperienceProviderReviewStatus"];
            /** @description 提供者が管理する特定商取引法の表示ページ（https）。未設定は null で、審査を申請できない */
            sellerDisclosureUrl: string | null;
            /**
             * Format: date-time
             * @description 審査を最後に申請した時刻
             */
            submittedAt: string | null;
            /** Format: date-time */
            updatedAt: string;
            /** @description 提供者の体験・予約・売上を入れる内部の器（拠点）の ID。通常の拠点の API の権限は持たない */
            vesselSpotId: string;
        };
        /** @description 同意の版と、画面に出す同意の文言（版と対応）。送るときは `version` をそのまま返す */
        ExperienceProviderConsent: {
            text: string;
            version: string;
        };
        ExperienceProviderDetailResponse: {
            consent: components["schemas"]["ExperienceProviderConsent"];
            paymentReuseConsent: components["schemas"]["ExperienceProviderConsent"];
            /** @description 本人が platform ADMIN か */
            platformAdmin: boolean;
            provider: components["schemas"]["ExperienceProviderWithMemberRole"] | null;
        };
        /**
         * @description 提供者の種別（個人 / 事業者）。Stripe の口座の種別にも使う
         * @enum {string}
         */
        ExperienceProviderKind: "INDIVIDUAL" | "BUSINESS";
        ExperienceProviderListResponse: {
            consent: components["schemas"]["ExperienceProviderConsent"];
            paymentReuseConsent: components["schemas"]["ExperienceProviderConsent"];
            /** @description 本人が platform ADMIN か（全提供者を読める） */
            platformAdmin: boolean;
            providers: components["schemas"]["ExperienceProviderWithMemberRole"][];
        };
        /**
         * @description 集合場所（提供者の既定・体験ページの上書き）。公開の応答に出すのは `overview` だけで、ほかの項目は予約が確定した申込に写して
         *     予約者にだけ案内する。前後の空白を除いて保存する。未設定は空文字。
         */
        ExperienceProviderMeetingPoint: {
            /** @description 行き方 */
            accessNote: string;
            /** @description 集合場所の住所（予約者にだけ案内する） */
            address: string;
            /** @description 入口・当日の案内 */
            entranceNote: string;
            /** @description 地図の URL。空文字か https の URL（ユーザー名・パスワードを含まない） */
            mapUrl: string;
            /** @description 公開してよい大まかな場所 */
            overview: string;
        };
        ExperienceProviderMeetingPointResponse: {
            meetingPoint: components["schemas"]["ExperienceProviderMeetingPoint"];
        };
        /**
         * @description 提供者の中での本人の役割。role enumの正本は選別済み experience-provider-operations v1.0.0。元のhost draft exportはcore baselineに無いため、既存ページDTOを維持したままこのenumだけを同期する。EDITORは紹介と原稿だけ、COHOSTは日常運営、OWNERは販売者・法的同意・受取口座・メンバー管理も行う。
         * @enum {string}
         */
        ExperienceProviderMemberRole: "OWNER" | "EDITOR" | "COHOST";
        /**
         * @description 本文の部分更新（送ったトップレベルのキーだけを今の本文へ重ねる。`facts`・`meetingPoint` は送ると中身ごと置き換える）。null は空と同じ。
         *     上限は本文（`SpotCampaignPageExperienceContent`）と同じで、文字列は前後の空白を除き、配列の空の要素（当日の流れは時刻・題・一言の
         *     どれも無い段）は落としてから数える。当日の流れの写真と外観写真は `photoObjectKeys` の中から選ぶ（保存後の写真に無いものは null になる）。
         *     `hostUserIds` は拠点の運営メンバーだけを残すので、提供者の体験ページでは空になる。
         */
        ExperienceProviderPageContentInput: {
            description?: string | null;
            facts?: {
                language?: string | null;
            } | null;
            highlights?: (string | null)[] | null;
            hostUserIds?: (string | null)[] | null;
            included?: (string | null)[] | null;
            knowBeforeYouGo?: (string | null)[] | null;
            lead?: string | null;
            meetingPoint?: {
                entranceNote?: string | null;
                exteriorPhotoObjectKey?: string | null;
            } | null;
            notIncluded?: (string | null)[] | null;
            notSuitableFor?: (string | null)[] | null;
            timeline?: ({
                photoObjectKey?: string | null;
                text?: string | null;
                /** @description 時刻（"HH:mm"。空・null は時刻なし） */
                time?: string | null;
                title?: string | null;
            } | null)[] | null;
        };
        /**
         * @description 提供者の体験ページの詳細。項目は拠点の企画ページの詳細と同じで、写真の説明 `photoAlts` が加わる。
         *     `publicPath` は NIHO の公開ページの path（体験サイトの URL ではない）。
         */
        ExperienceProviderPageDetail: {
            content: components["schemas"]["SpotCampaignPageExperienceContent"];
            /** @description 表紙（写真の 1 枚目） */
            coverObjectKey: string | null;
            /** Format: date-time */
            createdAt: string;
            id: string;
            kind: components["schemas"]["SpotCampaignPageKind"];
            language: components["schemas"]["SpotCampaignPageLanguage"];
            listOnEntrance: boolean;
            /** @description 受付（作成時に同時に作るので通常は null にならない） */
            offer: components["schemas"]["SpotCampaignPageOffer"] | null;
            offers: components["schemas"]["SpotCampaignPageOffer"][];
            /** @description 写真の説明（`photos` と同じ並び。説明の無い写真は空文字） */
            photoAlts: string[];
            photos: components["schemas"]["AdminCampaignPagePhoto"][];
            /** @description 公開ページの path（`/living/{spot.slug}/pages/{slug}`） */
            publicPath: string;
            /** @description 公開の前提を満たしていない理由（空なら公開できる） */
            publishBlockers: components["schemas"]["SpotCampaignPagePublishBlocker"][];
            /**
             * Format: date-time
             * @description 初回公開（再公開でも変えない）。null は下書き
             */
            publishedAt: string | null;
            slug: string;
            status: components["schemas"]["SpotCampaignPageStatus"];
            title: string;
            /** Format: date-time */
            unpublishedAt: string | null;
            /** Format: date-time */
            updatedAt: string;
        };
        /**
         * @description 体験ページの体験サイトへの掲載（記録そのまま。予約・個人情報を含まない）。`slug` と `regionKey` は初回の承認で決まる。
         *     拠点の掲載の応答と違い、体験サイトの URL は返さない。
         */
        ExperienceProviderPageListing: {
            /** Format: date-time */
            approvedAt: string | null;
            /** @description 体験ページの ID */
            campaignPageId: string;
            /** Format: date-time */
            consentedAt: string;
            /** @description 申請で同意した版 */
            consentVersion: string;
            /** Format: date-time */
            createdAt: string;
            id: string;
            /** Format: date-time */
            pausedAt: string | null;
            regionKey: string | null;
            /** @description 体験サイトでの slug（初回の承認で決まる） */
            slug: string | null;
            /** @description 提供者の器の ID（`vesselSpotId`） */
            spotId: string;
            status: components["schemas"]["ExperienceSiteListingStatus"];
            /** Format: date-time */
            updatedAt: string;
            /** Format: date-time */
            withdrawnAt: string | null;
        };
        ExperienceProviderPageListingResponse: {
            consent: components["schemas"]["AdminExperienceSiteListingConsent"];
            /** @description 掲載（読むときは、まだ申請していなければ null） */
            listing: components["schemas"]["ExperienceProviderPageListing"] | null;
        };
        /**
         * @description 体験ページの集合場所。`INHERIT` は提供者の既定を使う、`OVERRIDE` はこのページで上書きする
         * @enum {string}
         */
        ExperienceProviderPageMeetingPointMode: "INHERIT" | "OVERRIDE";
        ExperienceProviderPageMeetingPointResponse: {
            meetingPoint: components["schemas"]["ExperienceProviderMeetingPoint"];
            mode: components["schemas"]["ExperienceProviderPageMeetingPointMode"];
        };
        /** @description 体験ページの集合場所の上書き（`OVERRIDE`）か、提供者の既定へ戻す（`INHERIT`）。`expectedUpdatedAt` はページの `updatedAt` */
        ExperienceProviderPageMeetingPointUpdateRequest: {
            /** Format: date-time */
            expectedUpdatedAt: string;
            /** @enum {string} */
            mode: "INHERIT";
        } | {
            /** Format: date-time */
            expectedUpdatedAt: string;
            meetingPoint: components["schemas"]["ExperienceProviderMeetingPoint"];
            /** @enum {string} */
            mode: "OVERRIDE";
        };
        /** @description 保存した集合場所と、新しいページの版（`updatedAt`）。`OVERRIDE` のときだけ `meetingPoint`（保存した値）が入る */
        ExperienceProviderPageMeetingPointUpdateResponse: {
            /** @enum {string} */
            mode: "INHERIT";
            /** Format: date-time */
            updatedAt: string;
        } | {
            meetingPoint: components["schemas"]["ExperienceProviderMeetingPoint"];
            /** @enum {string} */
            mode: "OVERRIDE";
            /** Format: date-time */
            updatedAt: string;
        };
        /**
         * @description 体験ページの部分更新（送った項目だけ）。拠点の企画ページの部分更新と同じ項目に `photoAlts` が加わる。
         *     `offer` と `offers` は一緒に送れない（400）。
         */
        ExperienceProviderPagePatchRequest: {
            content?: components["schemas"]["ExperienceProviderPageContentInput"];
            language?: components["schemas"]["SpotCampaignPageLanguage"];
            listOnEntrance?: boolean;
            offer?: components["schemas"]["SpotCampaignPageOfferPatch"];
            /** @description 全商品の置き換え（既存の `id` は更新・省くと新規。予約履歴のある商品は省いて消せない） */
            offers?: components["schemas"]["SpotCampaignPageOfferPatch"][];
            /** @description 写真の説明（`photoObjectKeys` と同じ並び・同じ数で一緒に送る。前後の空白は除く） */
            photoAlts?: string[];
            /** @description 写真の `objectKey`（並び順が表示順・1 枚目が表紙・重複を除いて 20 枚まで）。この提供者の上げ口で上げた写真だけ */
            photoObjectKeys?: string[];
            /** @description 公開したことが無い間だけ変えられる */
            slug?: string;
            /** @description 題名（前後の空白を除いて 95 字まで） */
            title?: string;
        };
        /**
         * @description 開催回。予約できる回は `bookable: true` で `reason` が無い。予約できない回は `bookable: false` と理由（`cutoff` = 締切を過ぎた、
         *     `full` = 満席、`unavailable` = 受取口座の準備ができていない・場所が空いていない）。
         */
        ExperienceProviderPagePreviewOccurrence: {
            /** @enum {boolean} */
            bookable: true;
            /** @description 開催日（JST） */
            date: string;
            /** Format: date-time */
            endAt: string;
            /** @description 残席（0 未満にしない） */
            seatsLeft: number;
            /** Format: date-time */
            startAt: string;
        } | {
            /** @enum {boolean} */
            bookable: false;
            /** @description 開催日（JST） */
            date: string;
            /** Format: date-time */
            endAt: string;
            /** @enum {string} */
            reason: "cutoff" | "full" | "unavailable";
            /** @description 残席（0 未満にしない） */
            seatsLeft: number;
            /** Format: date-time */
            startAt: string;
        };
        /** @description プレビューの商品と、その開催回 */
        ExperienceProviderPagePreviewOffer: {
            acceptanceMode: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["acceptanceMode"];
            adultRequiredForChild: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["adultRequiredForChild"];
            bookingQuestions: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["bookingQuestions"];
            bookingQuestionsFingerprint: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["bookingQuestionsFingerprint"];
            cancellationPolicy: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["cancellationPolicy"];
            capacity: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["capacity"];
            childMaxAge: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["childMaxAge"];
            childMinAge: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["childMinAge"];
            childPriceYen: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["childPriceYen"];
            currency: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["currency"];
            durationMinutes: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["durationMinutes"];
            id: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["id"];
            maxPartySize: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["maxPartySize"];
            minimumParticipants: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["minimumParticipants"];
            name: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["name"];
            /** @description 今日（JST）から 90 日の開催回（日付順） */
            occurrences: components["schemas"]["ExperienceProviderPagePreviewOccurrence"][];
            priceYen: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["priceYen"];
            shortDescription: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["shortDescription"];
            sortOrder: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["sortOrder"];
            startTime: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"]["startTime"];
        };
        /** @description プレビューの商品（開催回を除く。公開ページの商品と同じ項目） */
        ExperienceProviderPagePreviewOfferSummary: {
            acceptanceMode: components["schemas"]["SpotCampaignPageAcceptanceMode"];
            adultRequiredForChild: boolean;
            /** @description 申込時の質問（質問の無い商品は []） */
            bookingQuestions: components["schemas"]["SpotCampaignPageBookingQuestion"][];
            /** @description 申込時の質問のセットの SHA-256（申込で照合する） */
            bookingQuestionsFingerprint: string;
            cancellationPolicy: components["schemas"]["SpotCampaignPageCancellationPolicy"];
            capacity: number;
            childMaxAge: number | null;
            childMinAge: number | null;
            childPriceYen: number | null;
            /** @enum {string} */
            currency: "JPY";
            durationMinutes: number;
            id: string;
            /** @description 1 組の上限人数 */
            maxPartySize: number;
            /** @description 1 組の申込人数の下限 */
            minimumParticipants: number;
            name: string;
            /** @description 大人 1 人あたりの料金（円・税込） */
            priceYen: number;
            shortDescription: string | null;
            sortOrder: number;
            /** @description 開始時刻 `HH:mm`（JST） */
            startTime: string;
        };
        /**
         * @description 体験ページのプレビュー。NIHO の公開ページの組み立てと同じ形で、違いは次だけ。
         *     提供者の器は住所を載せないので `spot.meetingPoint` は常に null（集合場所は `meeting-point` の API で扱う）。体験サイトの正規 URL
         *     （`experienceSiteUrl`）は無い。`offer` と `occurrences` は先頭の商品の写し（旧形式）。
         */
        ExperienceProviderPagePreviewResponse: {
            /** @description 迎える人（提供者の器には運営メンバーがいないので通常は空） */
            hosts: components["schemas"]["PublicLivingCampaignPageHost"][];
            /** @description 先頭の商品の開催回（`offers[0].occurrences` と同じ） */
            occurrences: components["schemas"]["ExperienceProviderPagePreviewOccurrence"][];
            offer: components["schemas"]["ExperienceProviderPagePreviewOfferSummary"];
            offers: components["schemas"]["ExperienceProviderPagePreviewOffer"][];
            page: components["schemas"]["PublicLivingCampaignPage"];
            spot: components["schemas"]["ExperienceProviderPagePreviewSpot"];
        };
        /** @description 提供者の器（公開ページの `spot` と同じ項目。`name` は提供者の表示名） */
        ExperienceProviderPagePreviewSpot: {
            /** @enum {string} */
            landingAccent: "LEAF" | "CORAL" | "TERRACOTTA" | "SAND" | "SUMI";
            /** @enum {string} */
            landingFont: "MARU" | "KAKU" | "MINCHO" | "KYOKASHO" | "MODERN" | "CLASSIC";
            /** @enum {string} */
            landingGround: "LIGHT" | "DARK_WARM";
            logoUrl: string | null;
            /**
             * @description 常に null（提供者の器は住所を載せない）
             * @enum {object|null}
             */
            meetingPoint: never | null;
            name: string;
            slug: string;
            tagline: string | null;
            taglineEn: string | null;
        };
        ExperienceProviderPaymentConnectResponse: {
            /**
             * Format: date-time
             * @description `url` の期限。`sync` では null
             */
            expiresAt: string | null;
            /** @description `reason` が `READY` のときだけ true */
            ready: boolean;
            reason: components["schemas"]["ExperienceProviderPaymentReadinessReason"];
            /** @description Stripe の口座の登録の画面（一度きり）。`sync` では null */
            url: string | null;
        };
        /**
         * @description 受取口座の準備の状態。`NOT_CONNECTED`（口座が無い）・`VERIFICATION_REQUIRED`（本人確認・提出が済んでいない）・
         *     `CHARGES_DISABLED`（決済を受けられない）・`PAYOUTS_DISABLED`（入金を受けられない）・`RESTRICTED`（制限・停止・設定の不整合）・`READY`。
         * @enum {string}
         */
        ExperienceProviderPaymentReadinessReason: "NOT_CONNECTED" | "VERIFICATION_REQUIRED" | "CHARGES_DISABLED" | "PAYOUTS_DISABLED" | "RESTRICTED" | "READY";
        ExperienceProviderPaymentReadinessResponse: {
            paymentReuseConsent: components["schemas"]["ExperienceProviderConsent"];
            /** @description `reason` が `READY` のときだけ true */
            ready: boolean;
            reason: components["schemas"]["ExperienceProviderPaymentReadinessReason"];
        };
        /** @description 本人が現役の OWNER である通常の拠点と、その販売者口座の準備の状態 */
        ExperienceProviderPaymentReuseCandidate: {
            /** @description 拠点の ID（再利用の `sourceSpotId`） */
            id: string;
            name: string;
            /** @description `reason` が `READY` のときだけ true */
            ready: boolean;
            reason: components["schemas"]["ExperienceProviderPaymentReadinessReason"];
        };
        ExperienceProviderPaymentReuseCandidatesResponse: {
            paymentReuseConsent: components["schemas"]["ExperienceProviderConsent"];
            /** @description 本人が現役の OWNER である通常の拠点（提供者の一覧と同じ 200 件まで） */
            spots: components["schemas"]["ExperienceProviderPaymentReuseCandidate"][];
        };
        ExperienceProviderPaymentReuseRequest: {
            /** @description `paymentReuseConsent.version` */
            consentVersion: string;
            /** @description 再利用する拠点（候補の `id`） */
            sourceSpotId: string;
        };
        /** @description 提供者の自己登録。前後の空白は除いてから長さを見る */
        ExperienceProviderRegisterRequest: {
            bio: string;
            /** @description 一覧・詳細の `consent.version` */
            consentVersion: string;
            displayName: string;
            kind: components["schemas"]["ExperienceProviderKind"];
            /** @description 特定商取引法の表示ページ。https の URL（ユーザー名・パスワードを含まない）。後で設定するなら null */
            sellerDisclosureUrl: string | null;
        };
        ExperienceProviderRegisterResponse: {
            consent: components["schemas"]["ExperienceProviderConsent"];
            paymentReuseConsent: components["schemas"]["ExperienceProviderConsent"];
            provider: components["schemas"]["ExperienceProvider"];
        };
        ExperienceProviderResponse: {
            provider: components["schemas"]["ExperienceProvider"];
        };
        /**
         * @description NIHO の審査の状態。`DRAFT`（未申請）→ `REQUESTED`（申請中）→ `APPROVED`（承認）/ `SUSPENDED`（停止）。
         *     承認・停止の後に紹介を直すと `REQUESTED` に戻る。
         * @enum {string}
         */
        ExperienceProviderReviewStatus: "DRAFT" | "REQUESTED" | "APPROVED" | "SUSPENDED";
        ExperienceProviderSubmitResponse: {
            /** @enum {boolean} */
            submitted: true;
        };
        /** @description 紹介の変更（送った項目だけ変える。1 つ以上）。`sellerDisclosureUrl` は OWNER と platform ADMIN だけ */
        ExperienceProviderUpdateRequest: {
            bio?: components["schemas"]["ExperienceProviderRegisterRequest"]["bio"];
            displayName?: components["schemas"]["ExperienceProviderRegisterRequest"]["displayName"];
            sellerDisclosureUrl?: components["schemas"]["ExperienceProviderRegisterRequest"]["sellerDisclosureUrl"];
        };
        /** @description 署名つき POST の form の項目（名前と値は GCS の署名の規則で決まるので閉じない）。全部をそのまま form に入れ、最後に `file` を足す。 */
        ExperienceProviderUploadPolicyFields: {
            [key: string]: string;
        };
        /** @description 体験ページの写真の署名つき POST の要求 */
        ExperienceProviderUploadPolicyRequest: {
            /** @description 任意（申告）。10MB を超えると 400 */
            contentLength?: number | null;
            /** @enum {string} */
            contentType: "image/jpeg" | "image/png" | "image/webp";
            /** @enum {string} */
            purpose: "ARTICLE_IMAGE";
        };
        ExperienceProviderUploadPolicyResponse: {
            /**
             * Format: date-time
             * @description 署名の期限（過ぎたら発行し直す）
             */
            expiresAt: string;
            /** @description 1 枚の上限（10MB） */
            maxSizeBytes: number;
            /** @description 上げる先（体験ページの `photoObjectKeys`・写真の署名つき URL に使う） */
            objectKey: string;
            /** @description GCS の署名つき POST（multipart/form-data で送る） */
            upload: {
                fields: components["schemas"]["ExperienceProviderUploadPolicyFields"];
                /** @description 送り先 */
                url: string;
            };
            uploadId: string;
        };
        /** @description 体験の提供者と、その中での本人の役割（一覧・詳細）。項目は `ExperienceProvider` と同じで、`memberRole` が加わる */
        ExperienceProviderWithMemberRole: {
            approvedAt: components["schemas"]["ExperienceProvider"]["approvedAt"];
            bio: components["schemas"]["ExperienceProvider"]["bio"];
            consentedAt: components["schemas"]["ExperienceProvider"]["consentedAt"];
            consentVersion: components["schemas"]["ExperienceProvider"]["consentVersion"];
            createdAt: components["schemas"]["ExperienceProvider"]["createdAt"];
            displayName: components["schemas"]["ExperienceProvider"]["displayName"];
            id: components["schemas"]["ExperienceProvider"]["id"];
            kind: components["schemas"]["ExperienceProvider"]["kind"];
            /** @description 本人の役割（platform ADMIN で所属していなければ null） */
            memberRole: (string & components["schemas"]["ExperienceProviderMemberRole"]) | null;
            ownerUserId: components["schemas"]["ExperienceProvider"]["ownerUserId"];
            paymentReuseConsentedAt: components["schemas"]["ExperienceProvider"]["paymentReuseConsentedAt"];
            paymentReuseConsentVersion: components["schemas"]["ExperienceProvider"]["paymentReuseConsentVersion"];
            paymentReuseSourceSpotId: components["schemas"]["ExperienceProvider"]["paymentReuseSourceSpotId"];
            reviewStatus: components["schemas"]["ExperienceProvider"]["reviewStatus"];
            sellerDisclosureUrl: components["schemas"]["ExperienceProvider"]["sellerDisclosureUrl"];
            submittedAt: components["schemas"]["ExperienceProvider"]["submittedAt"];
            updatedAt: components["schemas"]["ExperienceProvider"]["updatedAt"];
            vesselSpotId: components["schemas"]["ExperienceProvider"]["vesselSpotId"];
        };
        /**
         * @description 体験サイトへの掲載の状態（申請中・掲載中・停止中・取り下げ済み）
         * @enum {string}
         */
        ExperienceSiteListingStatus: "REQUESTED" | "ACTIVE" | "PAUSED" | "WITHDRAWN";
        PublicLivingCampaignPage: {
            content: components["schemas"]["PublicLivingCampaignPageContent"];
            /** @description 表紙の w1024 派生の署名 URL。表紙が無い・派生が無ければ null。 */
            coverUrl: string | null;
            kind: components["schemas"]["SpotCampaignPageKind"];
            language: components["schemas"]["SpotCampaignPageLanguage"];
            /** @description 写真（並び順が表示順・1 枚目が表紙）。w1024 の派生の署名 URL だけ（解決できない写真は落とす）。 */
            photos: components["schemas"]["PublicLivingCampaignPagePhoto"][];
            slug: string;
            title: string;
            /** @description 日本語原文の鮮度確認済み自動英訳。英語原文・未生成・原文更新後は null。 */
            titleEn: string | null;
        };
        /** @description 型 EXPERIENCE の本文（§4.4）。迎える人と入口の案内は除く（hosts・spot.meetingPoint で返す）。空の項目は Web が出さない。 */
        PublicLivingCampaignPageContent: {
            /** @description 詳しい説明（段落は空行区切り。Markdown ではない） */
            description: string;
            descriptionEn: string | null;
            /** @description 要点の帯のうち本文が持つ項目（所要・人数・キャンセルは offer から導く） */
            facts: {
                language: string;
                languageEn: string | null;
            };
            highlights: string[];
            /** @description highlights と同じ index の鮮度確認済み自動英訳。未生成・原文更新後の要素は null。 */
            highlightsEn: (string | null)[];
            included: string[];
            includedEn: (string | null)[];
            knowBeforeYouGo: string[];
            knowBeforeYouGoEn: (string | null)[];
            /** @description ひとこと紹介 */
            lead: string;
            /** @description lead の鮮度確認済み自動英訳。未生成・原文更新後は null。 */
            leadEn: string | null;
            notIncluded: string[];
            notIncludedEn: (string | null)[];
            notSuitableFor: string[];
            notSuitableForEn: (string | null)[];
            /** @description 当日の流れ（#17619）。空なら Web は見どころ（highlights）の箇条を出す。 */
            timeline: components["schemas"]["PublicLivingCampaignPageTimelineItem"][];
        };
        PublicLivingCampaignPageHost: {
            /** @description プロフィールのアイコン（/api/media/avatar の proxy）。無ければ null。 */
            avatarUrl: string | null;
            displayName: string;
        };
        PublicLivingCampaignPagePhoto: {
            url: string;
        };
        /** @description 当日の流れの 1 段（#17619）。写真は原本の objectKey を返さず、page.photos[] の位置で返す。 */
        PublicLivingCampaignPageTimelineItem: {
            /** @description 写真の page.photos[] の位置。写真が無い・派生の URL を作れなかったときは null。 */
            photoIndex: number | null;
            /** @description 一言 */
            text: string;
            /** @description text の鮮度確認済み自動英訳。未生成・原文更新後は null。 */
            textEn: string | null;
            /** @description 時刻（JST の "HH:mm"。空は時刻なし） */
            time: string;
            title: string;
            /** @description title の鮮度確認済み自動英訳。未生成・原文更新後は null。 */
            titleEn: string | null;
        };
        /**
         * @description 受付の型。INSTANT は申込時決済、APPROVAL はmanual与信後にhost承認でcaptureする。
         * @enum {string}
         */
        SpotCampaignPageAcceptanceMode: "INSTANT" | "APPROVAL";
        /**
         * @description 商品の申込時の質問（Epic #17729 S1 #17730）。ホストが書いた文のまま返す（翻訳しない）。
         *     1 商品 5 問まで。旅行者は申込（checkout の `answers`）で 1 組に 1 つ答える。
         */
        SpotCampaignPageBookingQuestion: {
            /** @description 補足文（無ければ null） */
            description: string | null;
            /** @description 質問の id（商品の中で一意。回答の `questionId` に使う） */
            id: string;
            inputType: components["schemas"]["SpotCampaignPageBookingQuestionInputType"];
            /** @description 選択式の選択肢（2〜8・同じ質問の中でラベルは重複しない）。記述式は [] */
            options: components["schemas"]["SpotCampaignPageBookingQuestionOption"][];
            /** @description 質問文（1 行） */
            prompt: string;
            /** @description 必須（記述式は空でない・選択式は 1 つ以上） */
            required: boolean;
        };
        /**
         * @description 申込時の質問の入力（#17730）。`id` は既存の質問を保つときに送る（無い・形が違えば `q_…` を採番する。同じ商品の中で重複すれば 400）。
         *     質問文は前後の空白を落とし改行を空白にして 1〜120 字、補足文は 0〜300 字（空は null）。選択式は選択肢 2〜8、記述式に送った
         *     `options` は落とす。
         */
        SpotCampaignPageBookingQuestionInput: {
            description?: string | null;
            id?: string;
            inputType: components["schemas"]["SpotCampaignPageBookingQuestionInputType"];
            options?: components["schemas"]["SpotCampaignPageBookingQuestionOptionInput"][];
            prompt: string;
            /** @description 省くと false */
            required?: boolean;
        };
        /**
         * @description 申込時の質問の型（SHORT_TEXT = 短文 1 行、LONG_TEXT = 長文、SINGLE_SELECT = 1 つ選ぶ、MULTI_SELECT = いくつでも選ぶ・#17730）。
         * @enum {string}
         */
        SpotCampaignPageBookingQuestionInputType: "SHORT_TEXT" | "LONG_TEXT" | "SINGLE_SELECT" | "MULTI_SELECT";
        /** @description 選択式の質問の選択肢。 */
        SpotCampaignPageBookingQuestionOption: {
            id: string;
            label: string;
        };
        /** @description 選択肢の入力。`id` は既存の選択肢を保つときに送る（無い・形が違えば `o_…` を採番する）。ラベルは 1 行・1〜80 字・同じ質問の中で重複しない。 */
        SpotCampaignPageBookingQuestionOptionInput: {
            id?: string;
            label: string;
        };
        /**
         * @description 体験の申込のキャンセル規定（FREE_UNTIL_24H / FREE_UNTIL_48H = 開催の 24 / 48 時間前まで無料で取り消せる、NONE = 返金なし）。
         * @enum {string}
         */
        SpotCampaignPageCancellationPolicy: "FREE_UNTIL_24H" | "FREE_UNTIL_48H" | "NONE";
        /** @description 型 EXPERIENCE の本文（§4.4）。書き込み時に検証・正規化したもの。 */
        SpotCampaignPageExperienceContent: {
            description: string;
            facts: {
                language: string;
            };
            highlights: string[];
            /** @description 迎える人（拠点の運営メンバーの User.id） */
            hostUserIds: string[];
            included: string[];
            knowBeforeYouGo: string[];
            lead: string;
            meetingPoint: {
                entranceNote: string;
                /** @description 外観写真（photoObjectKeys の中の 1 枚・#17619）。写真から外すと保存時に null になる。 */
                exteriorPhotoObjectKey: string | null;
            };
            notIncluded: string[];
            notSuitableFor: string[];
            /** @description 当日の流れ（#17619）。空なら公開ページは見どころの箇条を出す。 */
            timeline: components["schemas"]["SpotCampaignPageTimelineItem"][];
        };
        /**
         * @description 企画ページの型。v1 は体験の申込（EXPERIENCE）だけ。
         * @enum {string}
         */
        SpotCampaignPageKind: "EXPERIENCE";
        /**
         * @description 企画ページの言語（1 ページ 1 言語。画面の定型文・旅行者へのメールはこの言語）。
         * @enum {string}
         */
        SpotCampaignPageLanguage: "EN" | "JA";
        /** @description 型 EXPERIENCE の受付（§4.2）。時刻は JST 固定。 */
        SpotCampaignPageOffer: {
            acceptanceMode: components["schemas"]["SpotCampaignPageAcceptanceMode"];
            adultRequiredForChild: boolean;
            /** @description 申込時の質問（質問の無い商品は []・#17730） */
            bookingQuestions: components["schemas"]["SpotCampaignPageBookingQuestion"][];
            cancellationPolicy: components["schemas"]["SpotCampaignPageCancellationPolicy"];
            capacity: number;
            childMaxAge: number | null;
            childMinAge: number | null;
            childPriceYen: number | null;
            /** @description 休みの日（JST・開催回から除く） */
            closedDates: string[];
            /** @description 開催日の N 日前の 23:59 JST まで受け付ける（0 = 当日の開始時刻まで） */
            cutoffDays: number;
            durationMinutes: number;
            id: string;
            isActive: boolean;
            /** @description 1 組の上限人数（定員以下） */
            maxPartySize: number;
            minimumParticipants: number;
            name: string;
            /** @description 大人 1 人あたりの料金（円・税込）。0 は未設定（公開の前提で料金を求める） */
            priceYen: number;
            shortDescription: string | null;
            sortOrder: number;
            /** @enum {string} */
            spaceScope: "ENTIRE_FACILITY" | "DESIGNATED_AREA";
            startTime: string;
            useZone: string[];
            /** @description 開催する曜日（0=日 … 6=土） */
            weekdays: number[];
        };
        /** @description 受付の部分更新（送った項目だけ）。曜日・休みの日は重複を除いて並べ直す。 */
        SpotCampaignPageOfferPatch: {
            acceptanceMode?: components["schemas"]["SpotCampaignPageAcceptanceMode"];
            adultRequiredForChild?: boolean;
            /**
             * @description 申込時の質問（全件の置き換え・#17730）。省くと既存の商品は今の質問を保ち、新しい商品は質問なし（[]）。違反は 400
             *     `PAGE_OFFER_QUESTIONS_INVALID`（`details.field` = `offers.<i>.bookingQuestions.<j>.prompt` など）。MCP（host-agent）からは
             *     送れない。
             */
            bookingQuestions?: components["schemas"]["SpotCampaignPageBookingQuestionInput"][];
            cancellationPolicy?: components["schemas"]["SpotCampaignPageCancellationPolicy"];
            capacity?: number;
            childMaxAge?: number | null;
            childMinAge?: number | null;
            childPriceYen?: number | null;
            closedDates?: string[];
            cutoffDays?: number;
            durationMinutes?: number;
            /** @description 既存商品の更新時に指定。省略は新規商品 */
            id?: string;
            isActive?: boolean;
            maxPartySize?: number;
            minimumParticipants?: number;
            name?: string;
            priceYen?: number;
            shortDescription?: string | null;
            sortOrder?: number;
            /** @enum {string} */
            spaceScope?: "ENTIRE_FACILITY" | "DESIGNATED_AREA";
            startTime?: string;
            useZone?: string[];
            weekdays?: number[];
        };
        /**
         * @description 公開を止める理由。PRICE_BELOW_MINIMUM = 料金が Stripe の JPY の最低額（50 円）未満、
         *     STRIPE_NOT_READY = 拠点の都度決済（Stripe Connect）の受け取り準備ができていない、OPS_EMAIL_REQUIRED = 拠点の運用通知メールが空。
         * @enum {string}
         */
        SpotCampaignPagePublishBlocker: "TITLE_REQUIRED" | "COVER_REQUIRED" | "OFFER_PRICE_REQUIRED" | "PRICE_BELOW_MINIMUM" | "OFFER_CAPACITY_REQUIRED" | "OFFER_WEEKDAYS_REQUIRED" | "OFFER_START_REQUIRED" | "OFFER_DURATION_REQUIRED" | "OFFER_ACTIVE_REQUIRED" | "OFFER_SCHEDULE_CONFLICT" | "OFFER_ZONE_INVALID" | "STRIPE_NOT_READY" | "OPS_EMAIL_REQUIRED";
        /**
         * @description 公開状態（DRAFT = 公開したことが無い、PUBLISHED = 公開中、UNPUBLISHED = 停止中）。
         * @enum {string}
         */
        SpotCampaignPageStatus: "DRAFT" | "PUBLISHED" | "UNPUBLISHED";
        /** @description 当日の流れの 1 段（§4.4・#17619）。時刻・題・一言のどれも無い段は保存しない。 */
        SpotCampaignPageTimelineItem: {
            /** @description 写真（photoObjectKeys の中の 1 枚）。写真から外すと保存時に null になる。 */
            photoObjectKey: string | null;
            /** @description 一言 */
            text: string;
            /** @description 時刻（JST の "HH:mm"。空は時刻なし） */
            time: string;
            title: string;
        };
        UploadSignedUrlRequest: {
            objectKey: string;
        };
        UploadSignedUrlResponse: {
            /** Format: date-time */
            expiresAt: string;
            objectKey: string;
            signedUrl: string;
        };
    };
    responses: {
        /** @description 入力の形が違う（`VALIDATION_ERROR`） */
        ExperienceHostBadRequest: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
        /** @description 今の状態ではできない・別の操作と重なった（`CONFLICT`） */
        ExperienceHostConflict: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
        /** @description この操作はできない（`FORBIDDEN`）・退会済みのアカウント（`ACCOUNT_DELETED`） */
        ExperienceHostForbidden: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
        /** @description 見つからない・権限が無い（`NOT_FOUND`。区別しない） */
        ExperienceHostNotFound: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
        /** @description 一時的に使えない（`SERVICE_UNAVAILABLE`） */
        ExperienceHostServiceUnavailable: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
        /** @description ログインが要る・ログインが切れた（`UNAUTHORIZED`） */
        ExperienceHostUnauthorized: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
        /** @description 内容の条件を満たさない（`UNPROCESSABLE_ENTITY`） */
        ExperienceHostUnprocessableEntity: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "X-Trace-Id": components["headers"]["XTraceId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ExperienceHostErrorResponse"];
            };
        };
    };
    parameters: {
        /** @description 企画ページの ID（SpotCampaignPage.id） */
        CampaignPageId: string;
        /** @description 読んだときのページの `updatedAt`（応答の文字列をそのまま）。今の版と違えば 409（`PAGE_UPDATED`）で保存しない。省くと版を確かめない。 */
        CampaignPageUpdatedAtHeader: string;
        /** @description 提供者の ID（`ExperienceProvider.id`） */
        ExperienceProviderId: string;
    };
    requestBodies: never;
    headers: {
        /**
         * @description API request correlation id.
         *     vX: API は全レスポンスで `X-Request-Id` を返す（client が付与した値を echo するか、server が生成）。
         */
        XRequestId: string;
        /**
         * @description Trace id for correlating Cloud Logging / Cloud Trace.
         *     vX: API は全レスポンスで `X-Trace-Id` を返す（32 hex を想定）。
         */
        XTraceId: string;
    };
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    getAuthMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceHostAuthMe"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
        };
    };
    listExperienceProviders: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderListResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
        };
    };
    registerExperienceProvider: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceProviderRegisterRequest"];
            };
        };
        responses: {
            /** @description 登録した */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderRegisterResponse"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            422: components["responses"]["ExperienceHostUnprocessableEntity"];
        };
    };
    getExperienceProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderDetailResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    updateExperienceProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceProviderUpdateRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderResponse"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    getExperienceProviderMeetingPoint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderMeetingPointResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    updateExperienceProviderMeetingPoint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceProviderMeetingPoint"];
            };
        };
        responses: {
            /** @description 直した（保存した値） */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderMeetingPointResponse"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    listExperienceProviderPages: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminCampaignPageListResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    createExperienceProviderPage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminCampaignPageCreateRequest"];
            };
        };
        responses: {
            /** @description 作った */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPageDetail"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
        };
    };
    getExperienceProviderPage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPageDetail"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    deleteExperienceProviderPage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 消した */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminCampaignPageDeleteResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
        };
    };
    updateExperienceProviderPage: {
        parameters: {
            query?: never;
            header?: {
                /** @description 読んだときのページの `updatedAt`（応答の文字列をそのまま）。今の版と違えば 409（`PAGE_UPDATED`）で保存しない。省くと版を確かめない。 */
                "x-niho-page-updated-at"?: components["parameters"]["CampaignPageUpdatedAtHeader"];
            };
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceProviderPagePatchRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPageDetail"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
            422: components["responses"]["ExperienceHostUnprocessableEntity"];
        };
    };
    getExperienceProviderPageListing: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPageListingResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    requestExperienceProviderPageListing: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminExperienceSiteListingRequestBody"];
            };
        };
        responses: {
            /** @description 申請した（`listing` は null にならない） */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPageListingResponse"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
            422: components["responses"]["ExperienceHostUnprocessableEntity"];
        };
    };
    withdrawExperienceProviderPageListing: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 取り下げた（`listing` は null にならない） */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPageListingResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    getExperienceProviderPageMeetingPoint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPageMeetingPointResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    updateExperienceProviderPageMeetingPoint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceProviderPageMeetingPointUpdateRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPageMeetingPointUpdateResponse"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
        };
    };
    getExperienceProviderPagePreview: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPagePreviewResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    publishExperienceProviderPage: {
        parameters: {
            query?: never;
            header?: {
                /** @description 読んだときのページの `updatedAt`（応答の文字列をそのまま）。今の版と違えば 409（`PAGE_UPDATED`）で保存しない。省くと版を確かめない。 */
                "x-niho-page-updated-at"?: components["parameters"]["CampaignPageUpdatedAtHeader"];
            };
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPageDetail"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
            422: components["responses"]["ExperienceHostUnprocessableEntity"];
        };
    };
    unpublishExperienceProviderPage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 企画ページの ID（SpotCampaignPage.id） */
                pageId: components["parameters"]["CampaignPageId"];
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPageDetail"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
        };
    };
    resumeExperienceProviderPaymentConnect: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPaymentConnectResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
        };
    };
    startExperienceProviderPaymentConnect: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPaymentConnectResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
        };
    };
    syncExperienceProviderPaymentConnect: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPaymentConnectResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
        };
    };
    getExperienceProviderPaymentReadiness: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPaymentReadinessResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    reuseExperienceProviderPayment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceProviderPaymentReuseRequest"];
            };
        };
        responses: {
            /** @description 再利用した */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderResponse"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
            422: components["responses"]["ExperienceHostUnprocessableEntity"];
        };
    };
    listExperienceProviderPaymentReuseCandidates: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderPaymentReuseCandidatesResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
        };
    };
    submitExperienceProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 申請した */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderSubmitResponse"];
                };
            };
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            409: components["responses"]["ExperienceHostConflict"];
        };
    };
    createExperienceProviderUploadPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExperienceProviderUploadPolicyRequest"];
            };
        };
        responses: {
            /** @description 発行した */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExperienceProviderUploadPolicyResponse"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            503: components["responses"]["ExperienceHostServiceUnavailable"];
        };
    };
    createExperienceProviderUploadSignedUrl: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description 提供者の ID（`ExperienceProvider.id`） */
                providerId: components["parameters"]["ExperienceProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UploadSignedUrlRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadSignedUrlResponse"];
                };
            };
            400: components["responses"]["ExperienceHostBadRequest"];
            401: components["responses"]["ExperienceHostUnauthorized"];
            403: components["responses"]["ExperienceHostForbidden"];
            404: components["responses"]["ExperienceHostNotFound"];
            503: components["responses"]["ExperienceHostServiceUnavailable"];
        };
    };
}
