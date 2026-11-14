import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { badRequest, tooManyRequests } from '../../common/errors';
import { normalizeNigerianPhone } from '../../common/phone';
import { APP_CONFIG, AppConfig } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { OTP_SENDER, OtpSender } from './otp-sender';

export const OTP_TTL_SECONDS = 300;
export const OTP_RESEND_SECONDS = 60;
const OTP_MAX_PER_HOUR = 5;
const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
  ) {}

  private hash(phone: string, code: string): string {
    return createHmac('sha256', this.config.otpPepper).update(`${phone}:${code}`).digest('hex');
  }

  async request(rawPhone: string, ip?: string) {
    const phone = normalizeNigerianPhone(rawPhone);
    const now = new Date();

    const recent = await this.prisma.otpChallenge.findMany({
      where: { phone, createdAt: { gt: new Date(now.getTime() - 3600_000) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent.length >= OTP_MAX_PER_HOUR) {
      throw tooManyRequests('OTP_LIMIT_REACHED', 'Too many codes requested. Try again in an hour.');
    }
    if (recent[0]) {
      const waited = (now.getTime() - recent[0].createdAt.getTime()) / 1000;
      if (waited < OTP_RESEND_SECONDS) {
        throw tooManyRequests(
          'OTP_RESEND_TOO_SOON',
          'Wait a moment before requesting another code.',
          {
            retryAfterSeconds: Math.ceil(OTP_RESEND_SECONDS - waited),
          },
        );
      }
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.prisma.$transaction([
      // Only the newest code is ever valid.
      this.prisma.otpChallenge.updateMany({
        where: { phone, consumedAt: null },
        data: { consumedAt: now },
      }),
      this.prisma.otpChallenge.create({
        data: {
          phone,
          codeHash: this.hash(phone, code),
          expiresAt: new Date(now.getTime() + OTP_TTL_SECONDS * 1000),
          ip,
        },
      }),
    ]);

    await this.sender.send(phone, code); // outside any transaction
    return { expiresInSeconds: OTP_TTL_SECONDS, resendAfterSeconds: OTP_RESEND_SECONDS };
  }

  /** Returns the normalised phone when the code is valid. The code is single use. */
  async verify(rawPhone: string, code: string): Promise<string> {
    const phone = normalizeNigerianPhone(rawPhone);
    const invalid = () => badRequest('OTP_INVALID', 'That code is incorrect or has expired.');

    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge) throw invalid();

    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      throw tooManyRequests(
        'OTP_ATTEMPTS_EXCEEDED',
        'Too many incorrect attempts. Request a new code.',
      );
    }

    const expected = Buffer.from(challenge.codeHash, 'hex');
    const actual = Buffer.from(this.hash(phone, code), 'hex');
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!matches) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw invalid();
    }

    // Atomic single use: only one concurrent verification can consume the challenge.
    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid();
    return phone;
  }
}
