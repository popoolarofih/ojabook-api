import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
import { PageQuery } from '../common/pagination';

export const DECIMAL_PATTERN = /^\d{1,14}(\.\d{1,6})?$/;
const DECIMAL_MESSAGE = 'Must be a positive decimal number written as a string, for example "2.5".';

export class CreateCategoryDto {
  @ApiProperty({ example: 'Drinks' }) @IsString() @Length(2, 60) name: string;
}

export class CategoryDto {
  id: string;
  name: string;
  productCount: number;
}

export class ConversionInput {
  @ApiProperty({ example: 'carton' }) @IsString() @Length(1, 30) name: string;
  @ApiProperty({ example: '12', description: 'How many base units one of this unit contains.' })
  @Matches(DECIMAL_PATTERN, { message: DECIMAL_MESSAGE })
  factor: string;
  @ApiPropertyOptional({ description: 'Optional selling price (kobo) for one of this unit.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sellingPriceKobo?: number;
}

export class OpeningStockInput {
  @ApiProperty({ example: '24' })
  @Matches(DECIMAL_PATTERN, { message: DECIMAL_MESSAGE })
  quantity: string;
  @ApiProperty({ description: 'Cost per base unit in kobo.' })
  @IsInt()
  @Min(0)
  unitCostKobo: number;
}

export class CreateProductDto {
  @ApiPropertyOptional({
    description: 'Client generated UUID, so a retry cannot create a duplicate.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;
  @ApiProperty({ example: 'Peak Milk Tin 170g' }) @IsString() @Length(1, 120) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiProperty({ example: 'piece', description: 'The unit stock is counted in.' })
  @IsString()
  @Length(1, 30)
  baseUnit: string;
  @ApiProperty({ description: 'Selling price per base unit, in kobo.' })
  @IsInt()
  @Min(0)
  sellingPriceKobo: number;
  @ApiPropertyOptional({ example: '10' })
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: DECIMAL_MESSAGE })
  reorderThreshold?: string;
  @ApiPropertyOptional({ type: [ConversionInput] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ConversionInput)
  conversions?: ConversionInput[];
  @ApiPropertyOptional({ type: OpeningStockInput })
  @IsOptional()
  @ValidateNested()
  @Type(() => OpeningStockInput)
  openingStock?: OpeningStockInput;
}

export class UpdateProductDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sellingPriceKobo?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: DECIMAL_MESSAGE })
  reorderThreshold?: string;
}

export class AddConversionDto extends ConversionInput {}

export class ListProductsQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Matches name, SKU or barcode.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED', 'ALL'], default: 'ACTIVE' })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED', 'ALL'])
  status?: 'ACTIVE' | 'ARCHIVED' | 'ALL';
  @ApiPropertyOptional() @IsOptional() @Type(() => String) @IsIn(['true', 'false']) lowStock?:
    'true' | 'false';
}

export class ConversionDto {
  id: string;
  name: string;
  factor: string;
  sellingPriceKobo: number | null;
}

export class ProductDto {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  categoryId: string | null;
  categoryName: string | null;
  baseUnit: string;
  sellingPriceKobo: number;
  reorderThreshold: string;
  status: 'ACTIVE' | 'ARCHIVED';
  quantity: string;
  isLowStock: boolean;
  conversions: ConversionDto[];
  @ApiPropertyOptional({
    description: 'Weighted average cost per base unit (kobo). Needs cost.read.',
  })
  avgCostKobo?: string;
  @ApiPropertyOptional({ description: 'Quantity x average cost, in kobo. Needs cost.read.' })
  stockValueKobo?: number;
  updatedAt: string;
}

export class ProductPage {
  items: ProductDto[];
  page: number;
  pageSize: number;
  total: number;
}

export class PosCatalogueQuery {
  @ApiPropertyOptional({ description: 'Only products changed after this ISO time.' })
  @IsOptional()
  @IsString()
  updatedSince?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() @Type(() => Boolean) includeArchived?: boolean;
}
