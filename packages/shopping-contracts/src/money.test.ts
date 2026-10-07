import { describe, expect, test } from 'bun:test';
import {
  MINOR_UNITS_PER_MAJOR,
  MoneyError,
  assertMinorAmount,
  minorToYuan,
  sumMinor,
  yuanToMinor,
} from './money';

describe('yuanToMinor', () => {
  test('converts a whole yuan amount to fen', () => {
    // Arrange
    const yuan = 30;

    // Act
    const minor = yuanToMinor(yuan);

    // Assert
    expect(minor).toBe(3000);
  });

  test('converts an amount with two decimal places exactly', () => {
    // Arrange: 0.29 * 100 is 28.999999999999996 in IEEE-754.
    const yuan = 0.29;

    // Act
    const minor = yuanToMinor(yuan);

    // Assert: this must round to 29, not be rejected as "too precise".
    expect(minor).toBe(29);
  });

  test('rejects an amount carrying a third decimal place instead of rounding it', () => {
    // Arrange: 25.005 is ambiguous between 2500 and 2501.
    const yuan = 25.005;

    // Act / Assert: silent rounding would let displayed and quoted prices drift.
    expect(() => yuanToMinor(yuan)).toThrow(MoneyError);
  });

  test('rejects even a tiny actual fraction of a minor unit', () => {
    expect(() => yuanToMinor(25.001)).toThrow(MoneyError);
    expect(() => yuanToMinor(25.0000000001)).toThrow(MoneyError);
    expect(() => yuanToMinor(1e-7)).toThrow(MoneyError);
  });

  test('rejects a conversion outside safe integer minor units', () => {
    expect(() => yuanToMinor(1e14)).toThrow(MoneyError);
    expect(yuanToMinor(1e-2)).toBe(1);
  });

  test('names the offending field in the precision error', () => {
    // Arrange / Act / Assert: the label is what makes the throw site actionable.
    expect(() => yuanToMinor(1.234, 'delivery_fee')).toThrow(/delivery_fee/);
  });

  test('rejects a negative amount', () => {
    // Arrange
    const yuan = -1;

    // Act / Assert
    expect(() => yuanToMinor(yuan)).toThrow(MoneyError);
  });

  test('rejects NaN and Infinity rather than producing NaN minor units', () => {
    // Arrange / Act / Assert
    expect(() => yuanToMinor(Number.NaN)).toThrow(MoneyError);
    expect(() => yuanToMinor(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });

  test('accepts zero', () => {
    // Arrange / Act / Assert: a free item is legitimate.
    expect(yuanToMinor(0)).toBe(0);
  });
});

describe('minorToYuan', () => {
  test('round-trips a value through both representations', () => {
    // Arrange
    const yuan = 25;

    // Act
    const minor = yuanToMinor(yuan);
    const back = minorToYuan(minor);

    // Assert
    expect(back).toBe(25);
  });

  test('rejects a fractional minor amount, which would be a half-fen', () => {
    // Arrange
    const halfFen = 29.5;

    // Act / Assert
    expect(() => minorToYuan(halfFen)).toThrow(MoneyError);
  });
});

describe('assertMinorAmount', () => {
  test('returns the value unchanged when it is a valid amount', () => {
    // Arrange / Act / Assert
    expect(assertMinorAmount(2500)).toBe(2500);
  });

  test('rejects a value outside the safe integer range', () => {
    // Arrange: past 2^53 arithmetic silently loses precision.
    const tooLarge = Number.MAX_SAFE_INTEGER + 2;

    // Act / Assert
    expect(() => assertMinorAmount(tooLarge)).toThrow(MoneyError);
  });

  test('reports non-negativity and integrality as distinct failures', () => {
    // Arrange / Act / Assert: the two rules are separate checks, not one.
    expect(() => assertMinorAmount(-5)).toThrow(/negative/);
    expect(() => assertMinorAmount(5.5)).toThrow(/integer/);
  });
});

describe('sumMinor', () => {
  test('rejects overflow even when every input is individually safe', () => {
    expect(() => sumMinor([Number.MAX_SAFE_INTEGER, 1])).toThrow(MoneyError);
  });
  test('adds the amounts', () => {
    // Arrange
    const amounts = [2500, 300, 1200];

    // Act
    const total = sumMinor(amounts);

    // Assert
    expect(total).toBe(4000);
  });

  test('returns zero for an empty list', () => {
    // Arrange / Act / Assert
    expect(sumMinor([])).toBe(0);
  });

  test('rejects a negative amount, even though fees may legitimately be negative', () => {
    // Arrange: a discount is expressed as a negative fee, not as a negative item.
    const withDiscount = [2500, -100];

    // Act / Assert: this helper sums non-negative amounts only, so a negative
    // here means a sign error upstream — and summing it silently would hide that.
    expect(() => sumMinor(withDiscount)).toThrow(MoneyError);
  });

  test('rejects the whole list when any element is invalid', () => {
    // Arrange: one bad element among good ones.
    const amounts = [2500, 1.5, 300];

    // Act / Assert: skipping the bad element would under-report the total.
    expect(() => sumMinor(amounts)).toThrow(MoneyError);
  });
});

describe('MINOR_UNITS_PER_MAJOR', () => {
  test('is 100 fen per yuan', () => {
    // Arrange / Act / Assert: the constant is the shared definition of "minor".
    expect(MINOR_UNITS_PER_MAJOR).toBe(100);
  });
});
