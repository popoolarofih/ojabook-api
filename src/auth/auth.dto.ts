import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class OtpRequestDto {
  @ApiProperty({ example: '0801 234 5678', description: 'Nigerian mobile number in any common format.' })
  @IsString()
  @MaxLength(25)
  phone: string;
}

export class OtpRequestResponse {
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export class OtpVerifyDto {
  @ApiProperty({ example: '0801 234 5678' })
  @IsString()
  @MaxLength(25)
  phone: string;

  @ApiProperty({ example: '123456' })
  @Matches(/^\d{6}$/, { message: 'The code is 6 digits.' })
  code: string;

  @ApiPropertyOptional({ example: 'Chrome on Android' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  deviceName?: string;
}

export class UpdateProfileDto {
  @ApiProperty({ example: 'Amaka Okafor' })
  @IsString()
  @Length(2, 80)
  name: string;
}

export class MembershipSummary {
  businessId: string;
  businessName: string;
  role: string;
  permissions: string[];
  currency: string;
  timezone: string;
}

export class UserSummary {
  id: string;
  phone: string;
  name: string | null;
}

export class MeResponse {
  user: UserSummary;
  memberships: MembershipSummary[];
}

export class AuthResponse extends MeResponse {
  accessToken: string;
  expiresInSeconds: number;
}

export class RefreshResponse {
  accessToken: string;
  expiresInSeconds: number;
}

export class SessionInfo {
  id: string;
  deviceName: string | null;
  userAgent: string | null;
  lastUsedAt: string;
  current: boolean;
}
