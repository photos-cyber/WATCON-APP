import { env } from "@/lib/env";

export type MailMessage = { to: string; subject: string; text: string };

/** True only when real email delivery (SMTP) is configured. */
export function emailDeliveryConfigured() {
  return env().MAIL_TRANSPORT === "smtp";
}

/**
 * Sends and reports honestly: `delivered` is true only when the SMTP server accepted the message.
 * With the console transport nothing leaves the server, so `delivered` is false (dev: logged).
 */
export async function sendMailReported(message: MailMessage): Promise<{ delivered: boolean; reason?: string }> {
  if (!emailDeliveryConfigured()) {
    await sendMail(message);
    return { delivered: false, reason: "Email is not configured on this server (MAIL_TRANSPORT=smtp and SMTP settings are needed)." };
  }
  await sendMail(message);
  return { delivered: true };
}

/**
 * Outgoing mail. `console` transport writes the message to the server log
 * (development only); `smtp` uses nodemailer with the SMTP_* settings.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  const config = env();
  if (config.MAIL_TRANSPORT === "console") {
    if (config.NODE_ENV === "production") {
      console.warn("[mail] MAIL_TRANSPORT=console in production — email to %s was NOT delivered.", message.to);
      return;
    }
    console.info(`[mail:console] To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`);
    return;
  }
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
  });
  await transport.sendMail({ from: config.MAIL_FROM, to: message.to, subject: message.subject, text: message.text });
}
