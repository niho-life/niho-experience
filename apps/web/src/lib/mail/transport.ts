import "server-only";
import { createTransport, type SMTPPoolOptions } from "nodemailer";
import { config } from "@/lib/config";
import type { Mailbox } from "@/lib/resolve-config";

/** One email to one guest. Plain text and HTML of the same words (lib/mail/templates.ts). */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * `transient`: the connection, a timeout or a 4xx answer; trying again later may work. `permanent`: the
 * server refused this recipient or this message for good (5xx), so the same email will not go through.
 */
export type MailFailure = "transient" | "permanent";
export type MailResult = { readonly ok: true } | { readonly ok: false; readonly failure: MailFailure };

export interface Mailer {
  /** Never throws, and never logs: an SMTP answer can quote the recipient's address. */
  sendMail(message: MailMessage): Promise<MailResult>;
  /** Closes the pooled connection at the end of a run. */
  close(): void;
}

/** What the mailer needs from nodemailer's transporter (a fake one in tests). */
export interface MailTransport {
  sendMail(options: {
    readonly from: Mailbox;
    readonly replyTo: Mailbox;
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly html: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly disableFileAccess: true;
    readonly disableUrlAccess: true;
  }): Promise<unknown>;
  close(): void;
}

export interface SmtpConnectionSettings {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
}

/**
 * Port 465 is TLS from the start; any other port must upgrade with STARTTLS (requireTLS), so mail never goes
 * out in clear text. One pooled connection per run, short timeouts, and no logger: nodemailer's logs carry
 * addresses and, with debug, the message itself.
 */
export function smtpTransportOptions(settings: SmtpConnectionSettings): SMTPPoolOptions {
  const implicitTls = settings.port === 465;
  return {
    host: settings.host,
    port: settings.port,
    secure: implicitTls,
    requireTLS: !implicitTls,
    tls: { minVersion: "TLSv1.2" },
    auth: { user: settings.user, pass: settings.password },
    pool: true,
    maxConnections: 1,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/** nodemailer's codes for a session that could not be set up or authenticated: nothing else in the run will go through either. */
const SESSION_CODES: ReadonlySet<string> = new Set([
  "ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ETLS", "EREQUIRETLS", "EPROXY", "EAUTH", "ENOAUTH", "EOAUTH2", "ECONFIG",
]);

function errorFields(error: unknown): { code?: string; responseCode?: number; command?: string } {
  if (!error || typeof error !== "object") return {};
  const record = error as { code?: unknown; responseCode?: unknown; command?: unknown };
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.responseCode === "number" ? { responseCode: record.responseCode } : {}),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
  };
}

/**
 * The session itself failed, not this email: the connection, TLS, the login, a 421, or the server refusing
 * our sender (MAIL FROM). Nothing else in the run would go through either.
 */
function sessionFailed(error: unknown): boolean {
  const { code, responseCode, command } = errorFields(error);
  return responseCode === 421 || (code !== undefined && SESSION_CODES.has(code)) || (code === "EENVELOPE" && command === "MAIL FROM");
}

/**
 * 4xx, or the session failed (a rejected login such as 535 or a refused sender is the account's problem,
 * not this email's): transient. 5xx for the recipient or the message (550, 552, 553, 554…), or an envelope
 * or message nodemailer itself refused: permanent. Anything unknown is transient: the attempt cap ends it.
 */
export function classifyMailFailure(error: unknown): MailFailure {
  const { code, responseCode } = errorFields(error);
  if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) return "transient";
  if (sessionFailed(error)) return "transient";
  if (responseCode !== undefined && responseCode >= 500 && responseCode < 600) return "permanent";
  if (code === "EENVELOPE" || code === "EMESSAGE") return "permanent";
  return "transient";
}

/**
 * A mailer over `transport` with a fixed From and Reply-To. Once the SMTP session fails (the server is
 * unreachable, TLS or the login fails), every later email of the run answers `transient` without trying,
 * so a run with the server down ends after one timeout instead of one per email.
 */
export function createMailer(mailboxes: { readonly from: Mailbox; readonly replyTo: Mailbox }, transport: MailTransport): Mailer {
  let sessionDown = false;
  return {
    async sendMail(message) {
      if (sessionDown) return { ok: false, failure: "transient" };
      try {
        await transport.sendMail({
          from: mailboxes.from,
          replyTo: mailboxes.replyTo,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          // RFC 3834: out-of-office replies should not answer a message sent by a program.
          headers: { "Auto-Submitted": "auto-generated" },
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        return { ok: true };
      } catch (error) {
        if (sessionFailed(error)) sessionDown = true;
        return { ok: false, failure: classifyMailFailure(error) };
      }
    },
    close() {
      try {
        transport.close();
      } catch {
        /* Closing a pool that never connected has nothing to report. */
      }
    },
  };
}

/**
 * The SMTP mailer from configuration, or null while guest mail is off. The user and password are read
 * here, where they are used, and never stored in `config` or logged.
 */
export function smtpMailer(): Mailer | null {
  if (!config.guestMailEnabled || !config.guestMailFrom || !config.guestMailReplyTo) return null;
  const user = process.env.EXPERIENCE_SMTP_USER?.trim() ?? "";
  const password = process.env.EXPERIENCE_SMTP_PASSWORD?.trim() ?? "";
  if (!user || !password) return null;
  const transport = createTransport(smtpTransportOptions({ host: config.guestMailSmtpHost, port: config.guestMailSmtpPort, user, password }));
  return createMailer({ from: config.guestMailFrom, replyTo: config.guestMailReplyTo }, transport);
}
