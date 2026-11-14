import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CookieOptions, Request, Response } from 'express';
import { unauthorized } from '../common/errors';
import { Inject } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/env';
import {
  AuthResponse,
  MeResponse,
  OtpRequestDto,
  OtpRequestResponse,
  OtpVerifyDto,
  RefreshResponse,
  SessionInfo,
  UpdateProfileDto,
} from './auth.dto';
import { AuthService } from './auth.service';
import { CsrfGuard } from './csrf.guard';
import { CurrentUser, Public } from './decorators';
import { AuthUser } from './auth.types';
import { OtpService } from './otp/otp.service';
import { IssuedSession, SessionService } from './session.service';

export const REFRESH_COOKIE = 'ojabook_rt';
// Per IP limits are generous on purpose: many Nigerian mobile users share one public address
// through carrier NAT, so a tight limit would lock out real people. The real protections are per
// phone (resend cooldown, hourly cap, attempt lock in OtpService) and the 256 bit refresh secret.
// Relaxed further under test, because every test shares one address.
// Per phone limits (resend cooldown, hourly cap, attempt lock) are enforced in OtpService.
const IS_TEST = process.env.NODE_ENV === 'test';
const OTP_IP_LIMIT = IS_TEST ? 10_000 : 30;
const REFRESH_IP_LIMIT = IS_TEST ? 10_000 : 120;
const REFRESH_PATH = '/api/v1/auth';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private cookieOptions(expires?: Date): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'strict',
      path: REFRESH_PATH,
      domain: this.config.cookieDomain,
      expires,
    };
  }

  private setRefreshCookie(res: Response, session: IssuedSession) {
    res.cookie(REFRESH_COOKIE, session.refreshToken, this.cookieOptions(session.refreshExpiresAt));
  }

  private meta(req: Request, deviceName?: string) {
    return { ip: req.ip, userAgent: req.headers['user-agent'], deviceName };
  }

  @Public()
  @Throttle({ default: { limit: OTP_IP_LIMIT, ttl: 60_000 } })
  @Post('otp/request')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a one time code to a Nigerian phone number' })
  @ApiOkResponse({ type: OtpRequestResponse })
  requestOtp(@Body() dto: OtpRequestDto, @Req() req: Request): Promise<OtpRequestResponse> {
    return this.otp.request(dto.phone, req.ip);
  }

  @Public()
  @Throttle({ default: { limit: OTP_IP_LIMIT, ttl: 60_000 } })
  @Post('otp/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify the code and sign in. Sets the refresh cookie.' })
  @ApiOkResponse({ type: AuthResponse })
  async verifyOtp(
    @Body() dto: OtpVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const { session, me } = await this.auth.verifyOtp(
      dto.phone,
      dto.code,
      this.meta(req, dto.deviceName),
    );
    this.setRefreshCookie(res, session);
    return { ...me, accessToken: session.accessToken, expiresInSeconds: session.expiresInSeconds };
  }

  @Public()
  @UseGuards(CsrfGuard)
  @Throttle({ default: { limit: REFRESH_IP_LIMIT, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Rotate the refresh cookie and get a new access token' })
  @ApiOkResponse({ type: RefreshResponse })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefreshResponse> {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!raw) throw unauthorized('REFRESH_MISSING', 'Sign in to continue.');
    try {
      const session = await this.auth.refresh(raw, this.meta(req));
      this.setRefreshCookie(res, session);
      return { accessToken: session.accessToken, expiresInSeconds: session.expiresInSeconds };
    } catch (e) {
      res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
      throw e;
    }
  }

  @Public()
  @UseGuards(CsrfGuard)
  @Post('logout')
  @HttpCode(204)
  @ApiNoContentResponse()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (raw) await this.sessions.revokeByRawToken(raw);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out of every device' })
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.revokeAllForUser(user.id);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @ApiBearerAuth()
  @Get('sessions')
  @ApiOkResponse({ type: [SessionInfo] })
  listSessions(@CurrentUser() user: AuthUser): Promise<SessionInfo[]> {
    return this.sessions.listActive(user.id, user.sessionId);
  }

  @ApiBearerAuth()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.sessions.revokeOwnSession(user.id, id);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOkResponse({ type: MeResponse })
  me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return this.auth.me(user.id);
  }

  @ApiBearerAuth()
  @Patch('me')
  @ApiOkResponse({ type: MeResponse })
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto): Promise<MeResponse> {
    return this.auth.updateProfile(user.id, dto.name);
  }
}
