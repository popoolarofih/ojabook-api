import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min } from 'class-validator';
import { PageQuery } from '../common/pagination';

export class CreateCustomerDto {
  @ApiPropertyOptional({ description: 'Client generated UUID so offline creation is retry safe.' }) @IsOptional() @IsUUID() id?: string;
  @ApiProperty({ example: 'Mama Tunde' }) @IsString() @Length(2, 80) name: string;
  @ApiPropertyOptional({ example: '0805 111 2222' }) @IsOptional() @IsString() @MaxLength(25) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

export class UpdateCustomerDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 80) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(25) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) notes?: string;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] }) @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED']) status?: 'ACTIVE' | 'ARCHIVED';
}

export class ListCustomersQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) q?: string;
  @ApiPropertyOptional({ enum: ['true'] }) @IsOptional() @IsIn(['true']) hasBalance?: 'true';
  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' }) @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED']) status?: 'ACTIVE' | 'ARCHIVED';
}

export class CustomerDto {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  /** Unpaid credit sales as of now. */
  outstandingKobo: number;
  /** The part of outstanding that is past its due date. */
  overdueKobo: number;
  createdAt: string;
}

export class CustomerPage {
  items: CustomerDto[];
  page: number;
  pageSize: number;
  total: number;
  totalOutstandingKobo: number;
}

export class ListReceivablesQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['open', 'overdue', 'settled'], default: 'open' }) @IsOptional() @IsIn(['open', 'overdue', 'settled']) view?: 'open' | 'overdue' | 'settled';
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
}

export class ReceivableDto {
  id: string;
  customerId: string;
  customerName: string;
  saleId: string;
  receiptNumber: string;
  originalKobo: number;
  outstandingKobo: number;
  dueDate: string | null;
  status: 'OPEN' | 'PARTIAL' | 'SETTLED' | 'VOIDED';
  isOverdue: boolean;
  daysOverdue: number;
  saleDate: string;
}

export class ReceivablePage {
  items: ReceivableDto[];
  page: number;
  pageSize: number;
  total: number;
}

export class RepaymentDto {
  @ApiPropertyOptional({ description: 'Client generated payment id.' }) @IsOptional() @IsUUID() id?: string;
  @ApiProperty({ description: 'Kobo. Cannot be more than the amount owed.' }) @IsInt() @Min(1) amountKobo: number;
  @ApiProperty({ enum: ['CASH', 'TRANSFER'], description: 'A transfer stays unverified and does not reduce the balance until it is verified.' })
  @IsIn(['CASH', 'TRANSFER']) method: 'CASH' | 'TRANSFER';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) note?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() occurredAt?: string;
}

export class RepaymentResult {
  paymentId: string;
  status: string;
  verified: boolean;
  amountKobo: number;
  allocations: { receivableId: string; receiptNumber: string; amountKobo: number; remainingKobo: number }[];
  customerOutstandingKobo: number;
}

export class StatementQuery {
  @ApiProperty({ description: 'YYYY-MM-DD' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) from: string;
  @ApiProperty({ description: 'YYYY-MM-DD' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) to: string;
}

export class StatementRow {
  date: string;
  type: 'SALE' | 'REPAYMENT' | 'SALE_REVERSAL' | 'PENDING_TRANSFER';
  reference: string;
  description: string;
  chargedKobo: number;
  paidKobo: number;
  /** Running balance after this row. Pending transfers do not change it. */
  balanceKobo: number;
}

export class StatementDto {
  customer: { id: string; name: string; phone: string | null };
  businessName: string;
  fromDate: string;
  toDate: string;
  openingBalanceKobo: number;
  rows: StatementRow[];
  closingBalanceKobo: number;
  generatedAt: string;
}
