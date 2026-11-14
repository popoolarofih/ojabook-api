import { Injectable, Logger } from '@nestjs/common';

export interface OtpSender {
  send(phoneE164: string, code: string): Promise<void>;
}

export const OTP_SENDER = Symbol('OTP_SENDER');

/**
 * Development and test only. It logs the code and keeps it in memory for tests.
 * The config loader refuses to start in production with this provider, because the
 * SMS vendor is an open decision (guide section 18) and must not be faked.
 */
@Injectable()
export class ConsoleOtpSender implements OtpSender {
  private readonly logger = new Logger('ConsoleOtpSender');
  readonly sent = new Map<string, string>();

  async send(phoneE164: string, code: string): Promise<void> {
    this.sent.set(phoneE164, code);
    this.logger.warn(`OTP for ${phoneE164}: ${code} (development provider, not delivered by SMS)`);
  }
}
