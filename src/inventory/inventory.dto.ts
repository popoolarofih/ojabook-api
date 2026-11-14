import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StockMovementType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { DECIMAL_PATTERN } from '../catalogue/products.dto';
import { PageQuery } from '../common/pagination';

export const ADJUSTMENT_REASONS = ['COUNT_CORRECTION', 'DAMAGED', 'EXPIRED', 'LOST_OR_STOLEN', 'FOUND', 'OTHER'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export class ReceiptLineDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty({ example: '5', description: 'Quantity in the chosen unit.' })
  @Matches(DECIMAL_PATTERN, { message: 'Must be a positive decimal written as a string.' })
  quantity: string;
  @ApiPropertyOptional({ description: 'A product unit conversion. Omit for the base unit.' })
  @IsOptional() @IsUUID() unitId?: string;
  @ApiProperty({ description: 'Cost of ONE of the chosen unit, in kobo.' }) @IsInt() @Min(0) unitCostKobo: number;
}

export class CreateStockReceiptDto {
  @ApiPropertyOptional({ description: 'Client generated receipt id.' }) @IsOptional() @IsUUID() id?: string;
  @ApiProperty({ enum: ['CASH', 'TRANSFER'], description: 'How the supplier was paid.' })
  @IsIn(['CASH', 'TRANSFER']) paymentMethod: 'CASH' | 'TRANSFER';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) supplier?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() receivedAt?: string;
  @ApiProperty({ type: [ReceiptLineDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ReceiptLineDto)
  lines: ReceiptLineDto[];
}

export class StockReceiptResult {
  id: string;
  totalCostKobo: number;
  lines: { productId: string; baseQuantity: string; unitCostKobo: string; lineTotalKobo: number; quantityAfter: string }[];
}

export class CreateStockAdjustmentDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() id?: string;
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty({ enum: ['IN', 'OUT'] }) @IsIn(['IN', 'OUT']) direction: 'IN' | 'OUT';
  @ApiProperty({ enum: ADJUSTMENT_REASONS }) @IsIn(ADJUSTMENT_REASONS) reason: AdjustmentReason;
  @ApiProperty({ example: '3', description: 'Quantity in the product base unit.' })
  @Matches(DECIMAL_PATTERN, { message: 'Must be a positive decimal written as a string.' })
  quantity: string;
  @ApiProperty({ description: 'Required. Explains the adjustment in the audit trail.' }) @IsString() @Length(3, 300) note: string;
}

export class StockAdjustmentResult {
  id: string;
  productId: string;
  movementType: StockMovementType;
  quantityAfter: string;
  valueKobo: number;
}

export class StockMovementQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional({ enum: StockMovementType }) @IsOptional() @IsEnum(StockMovementType) type?: StockMovementType;
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, business timezone.' }) @IsOptional() @IsString() from?: string;
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, business timezone.' }) @IsOptional() @IsString() to?: string;
}

export class StockMovementDto {
  id: string;
  productId: string;
  productName: string;
  type: StockMovementType;
  quantityDelta: string;
  balanceAfter: string;
  reasonCode: string | null;
  note: string | null;
  sourceType: string | null;
  sourceId: string | null;
  occurredAt: string;
  @ApiPropertyOptional() unitCostKobo?: string;
}

export class StockMovementPage {
  items: StockMovementDto[];
  page: number;
  pageSize: number;
  total: number;
}

export class InventorySummary {
  activeProducts: number;
  lowStockCount: number;
  outOfStockCount: number;
  @ApiPropertyOptional({ description: 'Needs cost.read.' }) stockValueKobo?: number;
  lowStock: { productId: string; name: string; quantity: string; reorderThreshold: string; baseUnit: string }[];
}
