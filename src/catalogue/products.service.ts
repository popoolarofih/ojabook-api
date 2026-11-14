import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { TenantMember } from '../auth/auth.types';
import { D } from '../common/decimal';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { inventoryValue } from '../common/costing';
import { koboToNumber, roundKobo } from '../common/money';
import { Paged, skipTake } from '../common/pagination';
import { parseFactor, parseQuantity, qtyToString } from '../common/quantity';
import { LedgerService } from '../ledger/ledger.service';
import { StockService } from '../inventory/stock.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AddConversionDto,
  CategoryDto,
  ConversionDto,
  CreateCategoryDto,
  CreateProductDto,
  ListProductsQuery,
  ProductDto,
  UpdateProductDto,
} from './products.dto';

type ProductRow = Prisma.ProductGetPayload<{
  include: { category: true; conversions: true; balance: true };
}>;

const include = {
  category: true,
  conversions: { where: { archivedAt: null }, orderBy: { createdAt: 'asc' } },
  balance: true,
} satisfies Prisma.ProductInclude;

export function toProductDto(p: ProductRow, canSeeCost: boolean): ProductDto {
  const quantity = D(p.balance?.quantity ?? 0);
  const threshold = D(p.reorderThreshold);
  const dto: ProductDto = {
    id: p.id,
    name: p.name,
    sku: p.sku,
    barcode: p.barcode,
    categoryId: p.categoryId,
    categoryName: p.category?.name ?? null,
    baseUnit: p.baseUnit,
    sellingPriceKobo: koboToNumber(p.sellingPriceKobo),
    reorderThreshold: qtyToString(threshold),
    status: p.status,
    quantity: qtyToString(quantity),
    isLowStock: p.status === 'ACTIVE' && quantity.lte(threshold),
    conversions: p.conversions.map((c): ConversionDto => ({
      id: c.id,
      name: c.name,
      factor: D(c.factor).toString(),
      sellingPriceKobo: c.sellingPriceKobo === null ? null : koboToNumber(c.sellingPriceKobo),
    })),
    updatedAt: p.updatedAt.toISOString(),
  };
  if (canSeeCost) {
    const avg = D(p.balance?.avgCostKobo ?? 0);
    dto.avgCostKobo = avg.toFixed(4);
    dto.stockValueKobo = koboToNumber(inventoryValue(quantity, avg));
  }
  return dto;
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── categories ─────────────

  async listCategories(member: TenantMember): Promise<CategoryDto[]> {
    const rows = await this.prisma.category.findMany({
      where: { businessId: member.businessId },
      include: { _count: { select: { products: { where: { status: 'ACTIVE' } } } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((c) => ({ id: c.id, name: c.name, productCount: c._count.products }));
  }

  async createCategory(member: TenantMember, dto: CreateCategoryDto): Promise<CategoryDto> {
    const name = dto.name.trim();
    const dup = await this.prisma.category.findFirst({
      where: { businessId: member.businessId, name: { equals: name, mode: 'insensitive' } },
    });
    if (dup) throw conflict('CATEGORY_EXISTS', 'You already have a category with this name.');
    const c = await this.prisma.category.create({ data: { businessId: member.businessId, name } });
    return { id: c.id, name: c.name, productCount: 0 };
  }

  // ───────────── products ─────────────

  private canSeeCost(member: TenantMember) {
    return member.permissions.has('cost.read');
  }

  private async assertCategory(businessId: string, categoryId?: string | null) {
    if (!categoryId) return;
    const c = await this.prisma.category.findFirst({
      where: { id: categoryId, businessId },
      select: { id: true },
    });
    if (!c) throw badRequest('CATEGORY_NOT_FOUND', 'The selected category does not exist.');
  }

  async create(member: TenantMember, dto: CreateProductDto): Promise<ProductDto> {
    await this.assertCategory(member.businessId, dto.categoryId);
    if (dto.openingStock && !member.permissions.has('inventory.receive')) {
      throw forbidden('PERMISSION_DENIED', 'You do not have permission to record opening stock.');
    }
    const reorder = dto.reorderThreshold
      ? parseQuantity(dto.reorderThreshold, 'reorderThreshold')
      : D(0);
    const conversions = (dto.conversions ?? []).map((c) => ({
      ...c,
      factor: parseFactor(c.factor),
    }));
    this.assertDistinctUnits(
      dto.baseUnit,
      conversions.map((c) => c.name),
    );
    const opening = dto.openingStock
      ? {
          quantity: parseQuantity(dto.openingStock.quantity, 'openingStock.quantity'),
          unitCostKobo: D(dto.openingStock.unitCostKobo),
        }
      : null;
    const name = dto.name.trim();

    const id = await this.prisma.transaction(async (tx) => {
      if (dto.sku) {
        const dupSku = await tx.product.findFirst({
          where: { businessId: member.businessId, sku: dto.sku },
        });
        if (dupSku) throw conflict('SKU_EXISTS', 'Another product already uses this SKU.');
      }
      const product = await tx.product.create({
        data: {
          id: dto.id,
          businessId: member.businessId,
          categoryId: dto.categoryId,
          name,
          sku: dto.sku?.trim() || null,
          barcode: dto.barcode?.trim() || null,
          baseUnit: dto.baseUnit.trim(),
          sellingPriceKobo: BigInt(dto.sellingPriceKobo),
          reorderThreshold: reorder,
          createdById: member.userId,
          conversions: {
            create: conversions.map((c) => ({
              businessId: member.businessId,
              name: c.name.trim(),
              factor: c.factor,
              sellingPriceKobo:
                c.sellingPriceKobo === undefined ? null : BigInt(c.sellingPriceKobo),
            })),
          },
          balance: { create: { businessId: member.businessId } },
        },
      });

      if (opening && opening.quantity.gt(0)) {
        const positions = await this.stock.lock(tx, member.businessId, [product.id]);
        const occurredAt = new Date();
        await this.stock.receive(tx, positions, {
          type: 'OPENING',
          businessId: member.businessId,
          productId: product.id,
          baseQuantity: opening.quantity,
          unitCostKobo: opening.unitCostKobo,
          occurredAt,
          userId: member.userId,
          sourceType: 'OPENING_STOCK',
          sourceId: product.id,
        });
        const value = roundKobo(opening.quantity.mul(opening.unitCostKobo));
        if (value > 0n) {
          await this.ledger.post(tx, {
            businessId: member.businessId,
            entryDate: occurredAt,
            memo: `Opening stock: ${name}`,
            sourceType: 'OPENING_STOCK',
            sourceId: product.id,
            createdById: member.userId,
            lines: [
              { account: 'INVENTORY', debit: value },
              { account: 'OPENING_EQUITY', credit: value },
            ],
          });
        }
      }
      await this.audit.record(tx, {
        businessId: member.businessId,
        actorUserId: member.userId,
        action: 'product.create',
        entityType: 'product',
        entityId: product.id,
        after: {
          name,
          sellingPriceKobo: dto.sellingPriceKobo,
          baseUnit: dto.baseUnit,
          opening: dto.openingStock,
        },
      });
      return product.id;
    });
    return this.get(member, id);
  }

  private assertDistinctUnits(baseUnit: string, conversionNames: string[]) {
    const names = [baseUnit, ...conversionNames].map((n) => n.trim().toLowerCase());
    if (new Set(names).size !== names.length) {
      throw badRequest(
        'DUPLICATE_UNIT',
        'Each unit name must be different, including the base unit.',
      );
    }
  }

  async get(member: TenantMember, id: string): Promise<ProductDto> {
    const p = await this.prisma.product.findFirst({
      where: { id, businessId: member.businessId },
      include,
    });
    if (!p) throw notFound('Product');
    return toProductDto(p, this.canSeeCost(member));
  }

  async list(member: TenantMember, q: ListProductsQuery): Promise<Paged<ProductDto>> {
    const where: Prisma.ProductWhereInput = { businessId: member.businessId };
    const status = q.status ?? 'ACTIVE';
    if (status !== 'ALL') where.status = status;
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.q?.trim()) {
      const term = q.q.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { sku: { contains: term, mode: 'insensitive' } },
        { barcode: { equals: term } },
      ];
    }
    if (q.lowStock === 'true') {
      const low = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM products p JOIN stock_balances b ON b."productId" = p.id
        WHERE p."businessId" = ${member.businessId}::uuid AND p.status = 'ACTIVE' AND b.quantity <= p."reorderThreshold"`;
      where.id = { in: low.map((r) => r.id) };
    }
    const { skip, take, page, pageSize } = skipTake(q);
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, include, orderBy: { name: 'asc' }, skip, take }),
      this.prisma.product.count({ where }),
    ]);
    const cost = this.canSeeCost(member);
    return { items: rows.map((r) => toProductDto(r, cost)), page, pageSize, total };
  }

  /** Everything the POS needs to work offline. Cost data is never included. */
  async posCatalogue(member: TenantMember, updatedSince?: string): Promise<ProductDto[]> {
    const since = updatedSince ? new Date(updatedSince) : undefined;
    if (since && Number.isNaN(since.getTime()))
      throw badRequest('INVALID_DATE', 'updatedSince must be an ISO date.');
    const rows = await this.prisma.product.findMany({
      where: {
        businessId: member.businessId,
        ...(since
          ? { OR: [{ updatedAt: { gt: since } }, { balance: { updatedAt: { gt: since } } }] }
          : { status: 'ACTIVE' }),
      },
      include,
      orderBy: { name: 'asc' },
      take: 5000,
    });
    return rows.map((r) => toProductDto(r, false));
  }

  async update(member: TenantMember, id: string, dto: UpdateProductDto): Promise<ProductDto> {
    const before = await this.prisma.product.findFirst({
      where: { id, businessId: member.businessId },
    });
    if (!before) throw notFound('Product');
    await this.assertCategory(member.businessId, dto.categoryId);
    const reorder = dto.reorderThreshold
      ? parseQuantity(dto.reorderThreshold, 'reorderThreshold')
      : undefined;

    await this.prisma.transaction(async (tx) => {
      if (dto.sku && dto.sku !== before.sku) {
        const dup = await tx.product.findFirst({
          where: { businessId: member.businessId, sku: dto.sku, NOT: { id } },
        });
        if (dup) throw conflict('SKU_EXISTS', 'Another product already uses this SKU.');
      }
      const after = await tx.product.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          sku: dto.sku?.trim(),
          barcode: dto.barcode?.trim(),
          categoryId: dto.categoryId,
          sellingPriceKobo:
            dto.sellingPriceKobo === undefined ? undefined : BigInt(dto.sellingPriceKobo),
          reorderThreshold: reorder,
        },
      });
      // Price edits never touch past sales: sale items snapshot name, unit and price.
      await this.audit.record(tx, {
        businessId: member.businessId,
        actorUserId: member.userId,
        action: 'product.update',
        entityType: 'product',
        entityId: id,
        before: {
          name: before.name,
          sku: before.sku,
          sellingPriceKobo: before.sellingPriceKobo,
          reorderThreshold: before.reorderThreshold.toString(),
        },
        after: {
          name: after.name,
          sku: after.sku,
          sellingPriceKobo: after.sellingPriceKobo,
          reorderThreshold: after.reorderThreshold.toString(),
        },
      });
    });
    return this.get(member, id);
  }

  async setArchived(member: TenantMember, id: string, archived: boolean): Promise<ProductDto> {
    const p = await this.prisma.product.findFirst({ where: { id, businessId: member.businessId } });
    if (!p) throw notFound('Product');
    await this.prisma.transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: {
          status: archived ? 'ARCHIVED' : 'ACTIVE',
          archivedAt: archived ? new Date() : null,
        },
      });
      await this.audit.record(tx, {
        businessId: member.businessId,
        actorUserId: member.userId,
        action: archived ? 'product.archive' : 'product.unarchive',
        entityType: 'product',
        entityId: id,
      });
    });
    return this.get(member, id);
  }

  // ───────────── unit conversions ─────────────

  async addConversion(
    member: TenantMember,
    productId: string,
    dto: AddConversionDto,
  ): Promise<ProductDto> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, businessId: member.businessId },
      include: { conversions: { where: { archivedAt: null } } },
    });
    if (!product) throw notFound('Product');
    this.assertDistinctUnits(product.baseUnit, [
      ...product.conversions.map((c) => c.name),
      dto.name,
    ]);
    const factor = parseFactor(dto.factor);
    await this.prisma.transaction(async (tx) => {
      const c = await tx.unitConversion.create({
        data: {
          businessId: member.businessId,
          productId,
          name: dto.name.trim(),
          factor,
          sellingPriceKobo:
            dto.sellingPriceKobo === undefined ? null : BigInt(dto.sellingPriceKobo),
        },
      });
      await this.audit.record(tx, {
        businessId: member.businessId,
        actorUserId: member.userId,
        action: 'product.conversion_add',
        entityType: 'unit_conversion',
        entityId: c.id,
        after: { productId, name: c.name, factor: factor.toString() },
      });
    });
    return this.get(member, productId);
  }

  /** Conversions are immutable. To change a factor, archive it and add a new one. */
  async archiveConversion(
    member: TenantMember,
    productId: string,
    conversionId: string,
  ): Promise<ProductDto> {
    const res = await this.prisma.unitConversion.updateMany({
      where: { id: conversionId, productId, businessId: member.businessId, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (res.count === 0) throw notFound('Unit conversion');
    await this.audit.record(this.prisma, {
      businessId: member.businessId,
      actorUserId: member.userId,
      action: 'product.conversion_archive',
      entityType: 'unit_conversion',
      entityId: conversionId,
    });
    return this.get(member, productId);
  }
}
