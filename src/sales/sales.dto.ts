import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
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

export class SaleItemInput {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty({ example: '2.5', description: 'Quantity in the chosen unit, a decimal string.' })
  @Matches(DECIMAL_PATTERN, { message: 'Must be a positive decimal written as a string.' })
  quantity: string;
  @ApiPropertyOptional({ description: 'Unit conversion id. Omit for the base unit.' }) @IsOptional() @IsUUID() unitId?: string;
  @ApiPropertyOptional({ description: 'Price per unit in kobo. Differing from the list price needs sales.price_override.' })
  @IsOptional() @IsInt() @Min(0) unitPriceKobo?: number;
  @ApiPropertyOptional({ description: 'Discount on this line in kobo. Needs sales.discount.' })
  @IsOptional() @IsInt() @Min(0) discountKobo?: number;
  @ApiPropertyOptional({ description: 'Optional reason for a discount or override.' })
  @IsOptional() @IsString() @MaxLength(200) overrideReason?: string;
}

export class SalePaymentInput {
  @ApiProperty({ enum: ['CASH', 'TRANSFER', 'CREDIT'] }) @IsIn(['CASH', 'TRANSFER', 'CREDIT']) method: 'CASH' | 'TRANSFER' | 'CREDIT';
  @ApiProperty({ description: 'Kobo. All payments must add up to the sale total.' }) @IsInt() @Min(1) amountKobo: number;
}

export class CreateSaleDto {
  @ApiPropertyOptional({ description: 'Client generated UUID. Offline sales keep the same id when they sync.' })
  @IsOptional() @IsUUID() id?: string;
  @ApiPropertyOptional({ description: 'When the sale happened. Defaults to now. Offline sales send their original time.' })
  @IsOptional() @IsDateString() occurredAt?: string;
  @ApiPropertyOptional({ description: 'Required for credit. Walk in sales leave it out.' }) @IsOptional() @IsUUID() customerId?: string;
  @ApiProperty({ type: [SaleItemInput] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SaleItemInput)
  items: SaleItemInput[];
  @ApiProperty({ type: [SalePaymentInput] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => SalePaymentInput)
  payments: SalePaymentInput[];
  @ApiPropertyOptional({ example: '2026-12-01', description: 'Due date for the credit part.' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class ReverseSaleDto {
  @ApiProperty() @IsString() @Length(3, 300) reason: string;
}

export class ListSalesQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD in the business timezone.' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() cashierId?: string;
  @ApiPropertyOptional({ description: 'Receipt number search.' }) @IsOptional() @IsString() @MaxLength(30) receipt?: string;
  @ApiPropertyOptional({ enum: ['COMPLETED', 'REVERSED'] }) @IsOptional() @IsIn(['COMPLETED', 'REVERSED']) status?: 'COMPLETED' | 'REVERSED';
}

export class SaleItemDto {
  id: string;
  productId: string | null;
  productName: string;
  sku: string | null;
  unitName: string;
  unitFactor: string;
  quantity: string;
  baseQuantity: string;
  listPriceKobo: number;
  unitPriceKobo: number;
  discountKobo: number;
  lineTotalKobo: number;
  @ApiPropertyOptional({ description: 'Needs cost.read.' }) unitCostKobo?: string;
  @ApiPropertyOptional({ description: 'Needs cost.read.' }) cogsKobo?: number;
}

export class SalePaymentDto {
  id: string;
  method: 'CASH' | 'TRANSFER';
  status: string;
  amountKobo: number;
  /** True only when the money is verified as settled. Transfers entered by hand are not. */
  verified: boolean;
}

export class SaleDto {
  id: string;
  receiptNumber: string;
  status: 'COMPLETED' | 'REVERSED';
  customer: { id: string; name: string } | null;
  cashier: { id: string; name: string | null };
  items: SaleItemDto[];
  payments: SalePaymentDto[];
  subtotalKobo: number;
  discountKobo: number;
  totalKobo: number;
  creditKobo: number;
  outstandingKobo: number;
  dueDate: string | null;
  note: string | null;
  occurredAt: string;
  reversal: { reason: string; at: string } | null;
  @ApiPropertyOptional({ description: 'Needs cost.read.' }) cogsKobo?: number;
  @ApiPropertyOptional({ description: 'Needs cost.read.' }) grossProfitKobo?: number;
}

export class SalePage {
  items: SaleDto[];
  page: number;
  pageSize: number;
  total: number;
}
