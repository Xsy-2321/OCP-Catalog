/**
 * The fault catalogue is a fixed vocabulary, and the fixture that documents it
 * is checked against the code rather than reviewed by eye.
 *
 * The failure this prevents: `fixtures/shopping/faults.json` describes a fault
 * that no longer exists (or that never did), A writes a scenario against it, and
 * the scenario passes because the name is simply never matched. A demo that
 * "exercised the timeout path" while the timeout branch never ran is worse than
 * no demo.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MERCHANT_FAULTS, faultEnabled, parseFaultList, type MerchantFault } from './faults';

function faultFixture(): { readonly _note: string; readonly faults: Record<string, unknown> } {
  const path = join(import.meta.dir, '../../../fixtures/shopping/faults.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('MERCHANT_FAULTS', () => {
  test('is exactly the set the fixture documents', () => {
    expect([...MERCHANT_FAULTS].sort()).toEqual(Object.keys(faultFixture().faults).sort());
  });

  test('has no duplicates', () => {
    expect(new Set(MERCHANT_FAULTS).size).toBe(MERCHANT_FAULTS.length);
  });
});

describe('parseFaultList', () => {
  test('returns nothing for an absent or empty value', () => {
    expect(parseFaultList(undefined)).toEqual({ faults: [], unknown: [] });
    expect(parseFaultList('')).toEqual({ faults: [], unknown: [] });
    expect(parseFaultList('  ,  , ')).toEqual({ faults: [], unknown: [] });
  });

  test('accepts every name in the catalogue', () => {
    const parsed = parseFaultList(MERCHANT_FAULTS.join(','));

    expect([...parsed.faults].sort()).toEqual([...MERCHANT_FAULTS].sort());
    expect(parsed.unknown).toEqual([]);
  });

  test('tolerates whitespace around names', () => {
    expect(parseFaultList(' payment_declined ,  price_raised_after_quote ').faults).toEqual([
      'payment_declined',
      'price_raised_after_quote',
    ]);
  });

  test('keeps the order given and drops repeats', () => {
    // Order is preserved so the reported list reads back the way it was written;
    // a fault named twice is still one fault, or `faults.size` would lie.
    const parsed = parseFaultList('payment_declined,meltdown,payment_declined');

    expect(parsed.faults).toEqual(['payment_declined']);
    expect(parsed.unknown).toEqual(['meltdown']);
  });

  test('reports unknown names instead of throwing on the first one', () => {
    // Returning them lets `loadConfig` name every mistake in one restart.
    const parsed = parseFaultList('meltdown,payment_declined,explode');

    expect(parsed.faults).toEqual(['payment_declined']);
    expect(parsed.unknown).toEqual(['meltdown', 'explode']);
  });

  test('treats an unknown name as unknown rather than as an absent one', () => {
    // Case matters: a near-miss must be reported, not silently dropped.
    const parsed = parseFaultList('Payment_Declined');

    expect(parsed.faults).toEqual([]);
    expect(parsed.unknown).toEqual(['Payment_Declined']);
  });
});

describe('faultEnabled', () => {
  test('answers from the configured set only', () => {
    const enabled: ReadonlySet<MerchantFault> = new Set<MerchantFault>(['payment_declined']);

    expect(faultEnabled(enabled, 'payment_declined')).toBe(true);
    expect(faultEnabled(enabled, 'price_raised_after_quote')).toBe(false);
    expect(faultEnabled(new Set<MerchantFault>(), 'payment_declined')).toBe(false);
  });
});
