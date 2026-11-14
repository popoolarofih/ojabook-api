import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, AppConfig } from '../config/env';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BusinessGuard } from './business.guard';
import { CsrfGuard } from './csrf.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ConsoleOtpSender, OTP_SENDER } from './otp/otp-sender';
import { OtpService } from './otp/otp.service';
import { PermissionsGuard } from './permissions.guard';
import { SessionService } from './session.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.jwtAccessSecret }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    OtpService,
    SessionService,
    CsrfGuard,
    BusinessGuard,
    PermissionsGuard,
    ConsoleOtpSender,
    {
      provide: OTP_SENDER,
      inject: [APP_CONFIG, ConsoleOtpSender],
      useFactory: (config: AppConfig, consoleSender: ConsoleOtpSender) => {
        if (config.otpProvider === 'console') return consoleSender;
        throw new Error(`Unknown OTP_PROVIDER "${config.otpProvider}". No adapter is implemented yet.`);
      },
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService, SessionService, BusinessGuard, PermissionsGuard, ConsoleOtpSender, JwtModule],
})
export class AuthModule {}
