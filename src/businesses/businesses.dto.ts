import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MemberRole, MemberStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import { BUSINESS_CATEGORY_IDS } from './business-categories';

export class CreateBusinessDto {
  @ApiProperty({ example: 'Amaka Provisions' })
  @IsString()
  @Length(2, 80)
  name: string;

  @ApiProperty({ enum: BUSINESS_CATEGORY_IDS })
  @IsIn(BUSINESS_CATEGORY_IDS)
  category: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(25) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(120) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) state?: string;

  @ApiPropertyOptional({ default: 'Africa/Lagos', description: 'IANA timezone. Stored per business.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @ApiPropertyOptional({ enum: ['NGN'], default: 'NGN' })
  @IsOptional()
  @IsIn(['NGN'])
  currency?: 'NGN';
}

export class UpdateBusinessDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 80) name?: string;
  @ApiPropertyOptional({ enum: BUSINESS_CATEGORY_IDS }) @IsOptional() @IsIn(BUSINESS_CATEGORY_IDS) category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(25) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(120) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) timezone?: string;
}

export class BusinessDto {
  id: string;
  name: string;
  category: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  currency: string;
  timezone: string;
}

export class BusinessCategoryDto {
  id: string;
  label: string;
  suggestedUnits: string[];
}

export class InviteMemberDto {
  @ApiProperty({ example: '0803 456 7890' }) @IsString() @MaxLength(25) phone: string;
  @ApiProperty({ enum: ['MANAGER', 'CASHIER', 'INVENTORY_MANAGER'] })
  @IsEnum(MemberRole)
  role: MemberRole;
}

export class InvitationDto {
  id: string;
  phone: string;
  role: MemberRole;
  expiresAt: string;
  status: string;
}

export class CreatedInvitationDto extends InvitationDto {
  @ApiProperty({ description: 'Shown once. Share it with the invited person. It is stored only as a hash.' })
  token: string;
}

export class AcceptInvitationDto {
  @ApiProperty() @IsString() @Length(20, 200) token: string;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ enum: ['MANAGER', 'CASHIER', 'INVENTORY_MANAGER'] })
  @IsOptional()
  @IsEnum(MemberRole)
  role?: MemberRole;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status?: 'ACTIVE' | 'SUSPENDED';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  extraPermissions?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  revokedPermissions?: string[];

  @ApiPropertyOptional({ description: 'Required when changing role, status or permissions.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class TransferOwnershipDto {
  @ApiProperty() @IsUUID() memberId: string;
  @ApiProperty() @IsString() @Length(3, 300) reason: string;
}

export class MemberDto {
  id: string;
  userId: string;
  name: string | null;
  phone: string;
  role: MemberRole;
  status: MemberStatus;
  permissions: string[];
  extraPermissions: string[];
  revokedPermissions: string[];
}
