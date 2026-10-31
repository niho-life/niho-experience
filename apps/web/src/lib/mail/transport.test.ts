import { beforeEach, describe, expect, it, vi } from "vitest";

/** The SMTP mailer (#285 slice 5) with a fake transport: never a real server, user or password. */
const mocks = vi.hoisted(() => ({
  config: {
    guestMailEnabled: true,
    guestMailSmtpHost: "smtp.example.com",
    guestMailSmtpPort: 587,
    guestMailFrom: { name: "NIHO Experiences", address: "experiences@example.com" } as { name: string; address: string } | null,
    guestMailReplyTo: { name: "NIHO support", address: "support@example.com" } as { name: string; address: string } | null,
  },
  createTransport: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("nodemailer", () => ({ createTransport: mocks.createTransport }));

import { classifyMailFailure, createMailer, smtpMailer, smtpTransportOptions, type MailTransport } from "./transport";

const mailboxes = { from: { name: "NIHO Experiences", address: "experiences@example.com" }, replyTo: { name: "", address: "support@example.com" } };
const message = { to: "guest@example.com", subject: "Sample subject", text: "Sample text\n", html: "<p>Sample</p>" };
const smtpError = (fields: Record<string, unknown>) => Object.assign(new Error("Recipient address rejected: guest@example.com"), fields);

function fakeTransport(...outcomes: unknown[]) {
  const sendMail = vi.fn<MailTransport["sendMail"]>(async () => {
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return { messageId: "<sample@example.com>" };
  });
  return { sendMail, close: vi.fn<() => void>() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.guestMailEnabled = true;
  vi.unstubAllEnvs();
});

describe("classifyMailFailure", () => {
  it("is transient for the connection, TLS, a timeout, the login, a refused sender and any 4xx", () => {
    for (const fields of [
      { code: "ECONNECTION" }, { code: "ETIMEDOUT" }, { code: "ESOCKET" }, { code: "EDNS" }, { code: "ETLS" },
      { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" }, { code: "ENOAUTH" },
      { code: "EENVELOPE", responseCode: 451, command: "RCPT TO" }, { code: "EENVELOPE", responseCode: 452, command: "RCPT TO" },
      { code: "EENVELOPE", responseCode: 553, command: "MAIL FROM" }, { code: "EMESSAGE", responseCode: 421, command: "DATA" },
      { responseCode: 450 }, {}, { code: "ESTREAM" },
    ]) {
      expect(classifyMailFailure(smtpError(fields)), JSON.stringify(fields)).toBe("transient");
    }
    expect(classifyMailFailure("not an error")).toBe("transient");
    expect(classifyMailFailure(null)).toBe("transient");
  });

  it("is permanent for a 5xx about the recipient or the message, or what nodemailer refused itself", () => {
    for (const fields of [
      { code: "EENVELOPE", responseCode: 550, command: "RCPT TO" }, { code: "EENVELOPE", responseCode: 553, command: "RCPT TO" },
      { code: "EMESSAGE", responseCode: 552, command: "DATA" }, { code: "EMESSAGE", responseCode: 554, command: "DATA" },
      { code: "EENVELOPE", command: "API" }, { code: "EMESSAGE", command: "MAIL FROM" }, { responseCode: 550 },
    ]) {
      expect(classifyMailFailure(smtpError(fields)), JSON.stringify(fields)).toBe("permanent");
    }
  });
});

describe("createMailer", () => {
  it("sends one message with the fixed From and Reply-To, no file or URL content, and marks it automatic", async () => {
    const transport = fakeTransport();
    const mailer = createMailer(mailboxes, transport);
    expect(await mailer.sendMail(message)).toEqual({ ok: true });
    expect(transport.sendMail).toHaveBeenCalledExactlyOnceWith({
      ...mailboxes, ...message, headers: { "Auto-Submitted": "auto-generated" }, disableFileAccess: true, disableUrlAccess: true,
    });
    mailer.close();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("answers the failure's class without throwing or logging what the server said", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = fakeTransport(smtpError({ code: "EENVELOPE", responseCode: 550, command: "RCPT TO" }), smtpError({ code: "EENVELOPE", responseCode: 451, command: "RCPT TO" }));
    const mailer = createMailer(mailboxes, transport);
    expect(await mailer.sendMail(message)).toEqual({ ok: false, failure: "permanent" });
    expect(await mailer.sendMail(message)).toEqual({ ok: false, failure: "transient" });
    // One recipient's refusal does not stop the next email.
    expect(await mailer.sendMail(message)).toEqual({ ok: true });
    expect(transport.sendMail).toHaveBeenCalledTimes(3);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  it("stops trying for the rest of the run once the SMTP session fails", async () => {
    for (const failure of [{ code: "ETIMEDOUT" }, { code: "EAUTH", responseCode: 535 }, { responseCode: 421 }, { code: "EENVELOPE", responseCode: 550, command: "MAIL FROM" }]) {
      const transport = fakeTransport(smtpError(failure));
      const mailer = createMailer(mailboxes, transport);
      expect(await mailer.sendMail(message)).toEqual({ ok: false, failure: "transient" });
      expect(await mailer.sendMail(message)).toEqual({ ok: false, failure: "transient" });
      expect(transport.sendMail, JSON.stringify(failure)).toHaveBeenCalledOnce();
    }
  });

  it("closes quietly a pool that never connected", () => {
    const transport = fakeTransport();
    transport.close.mockImplementation(() => {
      throw new Error("synthetic close failure");
    });
    expect(() => createMailer(mailboxes, transport).close()).not.toThrow();
  });
});

describe("SMTP transport", () => {
  it("never sends in clear text: TLS from the start on 465, STARTTLS required elsewhere, and no logger", () => {
    const credentials = { host: "smtp.example.com", user: "sample-user", password: "sample-password" };
    expect(smtpTransportOptions({ ...credentials, port: 465 })).toMatchObject({ host: "smtp.example.com", port: 465, secure: true, requireTLS: false });
    for (const port of [587, 25, 2525]) {
      expect(smtpTransportOptions({ ...credentials, port })).toMatchObject({ port, secure: false, requireTLS: true });
    }
    expect(smtpTransportOptions({ ...credentials, port: 587 })).toMatchObject({
      auth: { user: "sample-user", pass: "sample-password" }, tls: { minVersion: "TLSv1.2" }, pool: true, maxConnections: 1,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    });
    const timeouts = smtpTransportOptions({ ...credentials, port: 587 });
    expect([timeouts.connectionTimeout, timeouts.greetingTimeout, timeouts.socketTimeout].every((value) => typeof value === "number" && value <= 20_000)).toBe(true);
  });

  it("reads the SMTP user and password from the environment where it builds the transport, and is null while mail is off", async () => {
    const transport = fakeTransport();
    mocks.createTransport.mockReturnValue(transport);
    vi.stubEnv("EXPERIENCE_SMTP_USER", " sample-user ");
    vi.stubEnv("EXPERIENCE_SMTP_PASSWORD", "sample-password\n");
    const mailer = smtpMailer();
    expect(mailer).not.toBeNull();
    expect(mocks.createTransport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      host: "smtp.example.com", port: 587, requireTLS: true, auth: { user: "sample-user", pass: "sample-password" },
    }));
    await mailer!.sendMail(message);
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: mocks.config.guestMailFrom, replyTo: mocks.config.guestMailReplyTo }));

    vi.stubEnv("EXPERIENCE_SMTP_PASSWORD", "");
    expect(smtpMailer()).toBeNull();
    mocks.config.guestMailEnabled = false;
    vi.stubEnv("EXPERIENCE_SMTP_PASSWORD", "sample-password");
    expect(smtpMailer()).toBeNull();
    expect(mocks.createTransport).toHaveBeenCalledOnce();
  });
});
