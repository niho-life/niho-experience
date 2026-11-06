/**
 * The admin an Admin page or API acts as, whichever login signed them in. Code that only uses the experience DB takes
 * this and nothing else.
 */
export interface AdminActor {
  /**
   * What the `*_niho_user_id` columns record for this admin until they are renamed (ADR 0003): the NIHO user ID with the
   * NIHO admin login, or, with the Google login, `adm_` + 32 hex derived from the Google account's subject (the first
   * 32 hex of SHA-256 of `google:<sub>`, AdminActorId in the store). Never an address; neither shape matches a host
   * account ID (`hst_`) or a seller reference (`sel_`).
   */
  readonly id: string;
  /** For the screen only: NIHO's display name, or the address the admin signed in to Google with. */
  readonly displayName: string | null;
}
