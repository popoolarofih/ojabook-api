import { Prisma } from '@prisma/client';

/**
 * One configured Decimal class for the whole API. Prisma returns its own Decimal
 * (decimal.js) for numeric columns, and decimal.js accepts instances from any clone,
 * so wrap incoming values with D() before doing arithmetic.
 */
export const Decimal = Prisma.Decimal.clone({ precision: 40, rounding: 4 /* ROUND_HALF_UP */ });
export type Decimal = InstanceType<typeof Decimal>;

export const D = (value: Prisma.Decimal.Value | Decimal): Decimal => new Decimal(value as never);

export const ZERO = D(0);
