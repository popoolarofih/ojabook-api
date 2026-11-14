import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantMember } from '../auth/auth.types';
import { CurrentMember, RequirePermissions, Tenant } from '../auth/decorators';
import {
  AddConversionDto,
  CategoryDto,
  CreateCategoryDto,
  CreateProductDto,
  ListProductsQuery,
  PosCatalogueQuery,
  ProductDto,
  ProductPage,
  UpdateProductDto,
} from './products.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@Tenant()
@Controller()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @RequirePermissions('products.read')
  @Get('categories')
  @ApiOkResponse({ type: [CategoryDto] })
  categories(@CurrentMember() m: TenantMember) {
    return this.products.listCategories(m);
  }

  @RequirePermissions('products.write')
  @Post('categories')
  @ApiOkResponse({ type: CategoryDto })
  createCategory(@CurrentMember() m: TenantMember, @Body() dto: CreateCategoryDto) {
    return this.products.createCategory(m, dto);
  }

  @RequirePermissions('products.read')
  @Get('products')
  @ApiOkResponse({ type: ProductPage })
  list(@CurrentMember() m: TenantMember, @Query() q: ListProductsQuery) {
    return this.products.list(m, q);
  }

  @RequirePermissions('sales.create')
  @Get('products/pos-catalogue')
  @ApiOperation({ summary: 'Compact catalogue for the POS and the offline cache. Never includes cost.' })
  @ApiOkResponse({ type: [ProductDto] })
  pos(@CurrentMember() m: TenantMember, @Query() q: PosCatalogueQuery) {
    return this.products.posCatalogue(m, q.updatedSince);
  }

  @RequirePermissions('products.write')
  @Post('products')
  @ApiOkResponse({ type: ProductDto })
  create(@CurrentMember() m: TenantMember, @Body() dto: CreateProductDto) {
    return this.products.create(m, dto);
  }

  @RequirePermissions('products.read')
  @Get('products/:id')
  @ApiOkResponse({ type: ProductDto })
  get(@CurrentMember() m: TenantMember, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(m, id);
  }

  @RequirePermissions('products.write')
  @Patch('products/:id')
  @ApiOkResponse({ type: ProductDto })
  update(@CurrentMember() m: TenantMember, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(m, id, dto);
  }

  @RequirePermissions('products.write')
  @Post('products/:id/archive')
  @HttpCode(200)
  @ApiOkResponse({ type: ProductDto })
  archive(@CurrentMember() m: TenantMember, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.setArchived(m, id, true);
  }

  @RequirePermissions('products.write')
  @Post('products/:id/unarchive')
  @HttpCode(200)
  @ApiOkResponse({ type: ProductDto })
  unarchive(@CurrentMember() m: TenantMember, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.setArchived(m, id, false);
  }

  @RequirePermissions('products.write')
  @Post('products/:id/conversions')
  @ApiOkResponse({ type: ProductDto })
  addConversion(@CurrentMember() m: TenantMember, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddConversionDto) {
    return this.products.addConversion(m, id, dto);
  }

  @RequirePermissions('products.write')
  @Post('products/:id/conversions/:conversionId/archive')
  @HttpCode(200)
  @ApiOkResponse({ type: ProductDto })
  archiveConversion(
    @CurrentMember() m: TenantMember,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('conversionId', ParseUUIDPipe) conversionId: string,
  ) {
    return this.products.archiveConversion(m, id, conversionId);
  }
}
