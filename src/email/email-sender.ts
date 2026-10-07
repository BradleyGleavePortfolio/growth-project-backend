// B-EMAILFROM-126 — the one place every outbound email gets its From: address.
//
// Every sender (EmailService templates, the digest crons, the guest-checkout
// welcome email) reads the address from ONE env var, EMAIL_FROM_ADDRESS. It
// must be an address on the domain verified with the email provider
// (Resend). When a real provider is in use there is no fallback: an unset or
// malformed value throws EmailSenderConfigError, whose message names the
// variable, so the send fails closed with a clear log line instead of going
// out from an unverified domain and being rejected by the provider.
//
// The dev/test 'log' transport never contacts a provider, so it falls back to
// DEV_EMAIL_FROM_ADDRESS and keeps working with no email env at all.

import { ConfigService } from '@nestjs/config';

export const EMAIL_FROM_ENV = 'EMAIL_FROM_ADDRESS';
export const DEV_EMAIL_FROM_ADDRESS = 'The Growth Project <noreply@growthprojectapp.com>';

export class EmailSenderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailSenderConfigError';
  }
}

// Accepts "addr@domain" or "Display Name <addr@domain>" (both are valid
// Resend `from` values). One address only: no CR/LF, no commas.
export function parseEmailSender(
  raw: unknown,
): { value: string; address: string; domain: string } | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || /[\r\n,]/.test(value)) return null;
  const angle = /^[^<>]*<([^<>]+)>$/.exec(value);
  const address = (angle ? angle[1] : value).trim();
  const m = /^[^\s@<>]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/.exec(address);
  if (!m) return null;
  return { value, address, domain: m[1].toLowerCase() };
}

// `transport` is the provider about to be used: 'log' (dev/test, nothing is
// sent) or a live provider name ('resend', 'sendgrid', 'postmark').
export function resolveEmailSender(config: ConfigService, transport: string): string {
  const raw = config.get<string>('EMAIL_FROM_ADDRESS');
  const parsed = parseEmailSender(raw);
  if (parsed) return parsed.value;
  if (transport.trim().toLowerCase() === 'log') return DEV_EMAIL_FROM_ADDRESS;
  const state =
    typeof raw === 'string' && raw.trim().length > 0 ? 'is not a valid sender address' : 'is not set';
  throw new EmailSenderConfigError(
    `${EMAIL_FROM_ENV} ${state}; no email is sent through ${transport} without it. Set ${EMAIL_FROM_ENV} to an address on the domain verified with the email provider (for example "The Growth Project <noreply@growthprojectapp.com>").`,
  );
}
