import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { PageQuery } from '../common/pagination';

export class CreateExpenseCategoryDto {
  @ApiProperty({ example: 'Generator fuel' }) @IsString() @Length(2, 60) name: string;
}

export class ExpenseCategoryDto {
  id: string;
  name: string;
}

export class CreateExpenseDto {
  @ApiPropertyOptional({ description: 'Client generated UUID. Retries and offline sync reuse it.' })
  @IsOptional()
  @IsUUID()
  id?: string;
  @ApiProperty() @IsUUID() categoryId: string;
  @ApiProperty({ description: 'Kobo.' }) @IsInt() @Min(1) amountKobo: number;
  @ApiProperty({ enum: ['CASH', 'TRANSFER'], description: 'How it was paid.' })
  @IsIn(['CASH', 'TRANSFER'])
  method: 'CASH' | 'TRANSFER';
  @ApiPropertyOptional({
    example: '2026-11-14',
    description: 'Business local date. Defaults to today.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expenseDate?: string;
  @ApiProperty({ example: 'Diesel for the generator' })
  @IsString()
  @Length(3, 200)
  description: string;
}

export class UpdateExpenseDto {
  @ApiProperty({
    description:
      'Only the description can be edited. Money changes need a reversal and a new expense.',
  })
  @IsString()
  @Length(3, 200)
  description: string;
}

export class ReverseExpenseDto {
  @ApiProperty() @IsString() @Length(3, 300) reason: string;
}

export class ListExpensesQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ enum: ['POSTED', 'REVERSED'] })
  @IsOptional()
  @IsIn(['POSTED', 'REVERSED'])
  status?: 'POSTED' | 'REVERSED';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) q?: string;
}

export class ExpenseDto {
  id: string;
  categoryId: string;
  categoryName: string;
  amountKobo: number;
  method: 'CASH' | 'TRANSFER';
  expenseDate: string;
  description: string;
  status: 'POSTED' | 'REVERSED';
  reversalReason: string | null;
  createdById: string;
  createdAt: string;
}

export class ExpensePage {
  items: ExpenseDto[];
  page: number;
  pageSize: number;
  total: number;
  /** Sum of POSTED expenses matching the filter. */
  totalPostedKobo: number;
}
