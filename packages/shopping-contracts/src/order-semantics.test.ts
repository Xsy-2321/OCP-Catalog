import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { orderInconsistency, type Order } from './order';

const fixture: { cases: { name: string; valid: boolean; order: Order }[] } = JSON.parse(
  readFileSync(new URL('../../../fixtures/shopping/order-conformance.json', import.meta.url), 'utf8'),
);

describe('shared order snapshot semantics', () => {
  for (const example of fixture.cases) {
    test(example.name, () => {
      const before = JSON.stringify(example.order);
      const problem = orderInconsistency(example.order);
      if (example.valid) expect(problem).toBeNull();
      else {
        expect(typeof problem).toBe('string');
        expect(problem!.length).toBeGreaterThan(0);
      }
      expect(JSON.stringify(example.order)).toBe(before);
    });
  }
});
