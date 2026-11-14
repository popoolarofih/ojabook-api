import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const SYNC_OPERATION_TYPES = [
  'customer.create',
  'sale.create',
  'repayment.create',
  'expense.create',
] as const;
export type SyncOperationType = (typeof SYNC_OPERATION_TYPES)[number];

export class SyncOperationInput {
  @ApiProperty({
    description: 'Client generated operation id. Also the idempotency key, so retries are safe.',
  })
  @IsUUID()
  id: string;
  @ApiProperty({ enum: SYNC_OPERATION_TYPES }) @IsIn(SYNC_OPERATION_TYPES) type: SyncOperationType;
  @ApiProperty({
    description:
      'Same body the matching REST endpoint accepts. For repayment.create also send receivableId or customerId.',
  })
  @IsObject()
  payload: Record<string, unknown>;
  @ApiProperty({ description: 'When the user made it on the device.' })
  @IsDateString()
  clientCreatedAt: string;
}

export class SyncBatchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) deviceId?: string;
  @ApiProperty({ type: [SyncOperationInput] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SyncOperationInput)
  operations: SyncOperationInput[];
}

export class SyncOperationResult {
  id: string;
  type: string;
  status: 'SYNCED' | 'CONFLICT' | 'FAILED_RETRYABLE' | 'FAILED_FINAL' | 'DISMISSED';
  errorCode?: string;
  message?: string;
  details?: unknown;
  /** The canonical record the server created, for SYNCED operations. */
  result?: unknown;
}

export class SyncBatchResult {
  results: SyncOperationResult[];
  serverTime: string;
}

export class ResolveOperationDto {
  @ApiProperty({ enum: ['EDIT_AND_POST', 'DISMISS'] }) @IsIn(['EDIT_AND_POST', 'DISMISS']) action:
    'EDIT_AND_POST' | 'DISMISS';
  @ApiPropertyOptional({ description: 'The corrected body, for EDIT_AND_POST.' })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
  @ApiProperty({
    description:
      'Why. Kept in the audit trail. Dismissing means the local transaction is never recorded.',
  })
  @IsString()
  @Length(3, 300)
  reason: string;
}

export class SyncStatusDto {
  counts: Record<string, number>;
  unresolved: {
    id: string;
    type: string;
    status: string;
    errorCode: string | null;
    message: string | null;
    details: unknown;
    payload: unknown;
    clientCreatedAt: string;
    receivedAt: string;
    attempts: number;
  }[];
  serverTime: string;
}
