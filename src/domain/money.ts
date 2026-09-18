import { Decimal } from 'decimal.js';
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });
export const D = (value: Decimal.Value): Decimal => new Decimal(value);
export const amount = (value: Decimal.Value): string => D(value).toFixed(8);
