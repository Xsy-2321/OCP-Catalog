/**
 * Two things are tested here, and only one of them is storage.
 *
 * The first is redaction. AGENT_B.md §5 forbids the event log from leaking
 * authorization proofs, signing material or payment handles, and a rule enforced
 * by "remember not to pass that field" decays the first time someone is in a
 * hurry. So the guard throws, and these tests prove it fires — including from
 * inside a nested object and from inside an array, because a signature one level
 * down leaks exactly as much as one at the top.
 *
 * The second is ordering. Every event of one checkout happens inside the same
 * transaction and therefore the same millisecond, so ordering by `occurred_at`
 * would shuffle the log. The test records three events with an identical
 * timestamp and asserts they come back in the order they happened.
 */
import { describe, expect, test } from 'bun:test';
import { FORBIDDEN_EVENT_KEYS, assertRedacted, listEvents, listEventsForSubjects, recordEvent } from './events';
import { makeTempDatabasePath, openTestDb, TEST_NOW_MS } from './test-support';

function withDb<T>(work: (db: ReturnType<typeof openTestDb>) => T): T {
  const { path, cleanup } = makeTempDatabasePath();
  const db = openTestDb(path);
  try {
    return work(db);
  } finally {
    db.close();
    cleanup();
  }
}

describe('assertRedacted', () => {
  test('passes ordinary process data', () => {
    expect(() =>
      assertRedacted({ quote_id: 'quote_1', total_minor: 2500, item_count: 1 }),
    ).not.toThrow();
  });

  test('refuses a forbidden key at the top level', () => {
    expect(() => assertRedacted({ quote_id: 'quote_1', signature: 'abc' })).toThrow(
      /would leak "signature" at data/,
    );
  });

  test('refuses one nested inside an object', () => {
    expect(() => assertRedacted({ authorization: { nested: { proof: 'x' } } })).toThrow();
  });

  test('refuses one inside an array', () => {
    expect(() => assertRedacted({ items: [{ name: 'latte' }, { token: 't' }] })).toThrow(
      /data\.items\[1\]\.token/,
    );
  });

  test('refuses one inside an array inside an object inside an array', () => {
    // Depth is not a defence: a walk that stops at the first object level would
    // let this through.
    expect(() => assertRedacted([{ outer: [{ private_key: 'p' }] }])).toThrow(
      /data\[0\]\.outer\[0\]\.private_key/,
    );
  });

  test('matches keys case-insensitively', () => {
    expect(() => assertRedacted({ Signature: 'abc' })).toThrow(/Signature/);
    expect(() => assertRedacted({ PAYMENT_REFERENCE: 'ref' })).toThrow();
  });

  test('names the path so the caller knows which field to fix', () => {
    try {
      assertRedacted({ order: { payment: { payment_key: 'pay_1:att_1' } } });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toContain('data.order.payment.payment_key');
    }
  });

  test('refuses every key on the list', () => {
    for (const key of FORBIDDEN_EVENT_KEYS) {
      expect(() => assertRedacted({ [key]: 'x' })).toThrow();
    }
  });

  test('matches whole keys, so a field that merely mentions one is allowed', () => {
    // The rule is deliberately exact-key rather than substring. Pinning it here
    // means that if the guard is ever tightened into a substring match, this
    // test reports the change instead of the change being discovered when a
    // legitimate field starts throwing.
    expect(() => assertRedacted({ signature_count: 1, key_count: 2 })).not.toThrow();
  });
});

describe('recordEvent', () => {
  test('stores the event and reads it back unchanged', () => {
    withDb((db) => {
      const written = recordEvent(db, {
        subjectType: 'attempt',
        subjectId: 'att_1',
        type: 'attempt.created',
        nowMs: TEST_NOW_MS,
        data: { quote_id: 'quote_1', attempt_number: 1 },
      });

      const read = listEvents(db, 'att_1');
      expect(read).toHaveLength(1);
      expect(read[0]).toEqual(written);
      expect(read[0]?.occurred_at).toBe(new Date(TEST_NOW_MS).toISOString());
      expect(read[0]?.subject_type).toBe('attempt');
    });
  });

  test('refuses to record an event that would leak, and stores nothing', () => {
    withDb((db) => {
      expect(() =>
        recordEvent(db, {
          subjectType: 'attempt',
          subjectId: 'att_1',
          type: 'payment.succeeded',
          nowMs: TEST_NOW_MS,
          data: { reference: 'mockref_123' },
        }),
      ).toThrow();

      // Nothing partially written: a rejected event leaves no trace, so a
      // redaction bug cannot be diagnosed from the log alone — which is why it
      // throws rather than writing a scrubbed copy.
      expect(listEvents(db, 'att_1')).toEqual([]);
    });
  });

  test('keeps events of one subject separate from another', () => {
    withDb((db) => {
      recordEvent(db, { subjectType: 'attempt', subjectId: 'att_1', type: 'attempt.created', nowMs: TEST_NOW_MS, data: {} });
      recordEvent(db, { subjectType: 'attempt', subjectId: 'att_2', type: 'attempt.created', nowMs: TEST_NOW_MS, data: {} });

      expect(listEvents(db, 'att_1')).toHaveLength(1);
      expect(listEvents(db, 'att_2')).toHaveLength(1);
      expect(listEvents(db, 'att_3')).toEqual([]);
    });
  });

  test('returns the events of one checkout in the order they happened', () => {
    // One checkout writes several events inside one transaction, so
    // `occurred_at_ms` is identical for all of them. Ordering by it would make
    // "payment.succeeded" sort behind "order.created" at random and the log
    // would describe a sequence that never happened.
    withDb((db) => {
      const types = ['attempt.created', 'payment.succeeded', 'order.created'] as const;
      for (const type of types) {
        recordEvent(db, { subjectType: 'attempt', subjectId: 'att_1', type, nowMs: TEST_NOW_MS, data: {} });
      }

      expect(listEvents(db, 'att_1').map((event) => event.type)).toEqual([...types]);
    });
  });
});

describe('listEventsForSubjects', () => {
  test('merges several subjects into the sequence they were written in', () => {
    // An order's story spans two subjects: the attempt and payment records hang
    // off the attempt, then `order.created` hangs off the order. Reading one
    // subject at a time and concatenating would put the attempt's records first
    // and the order's own line last regardless of which actually came first.
    withDb((db) => {
      const written = [
        ['attempt', 'att_1', 'attempt.created'],
        ['attempt', 'att_1', 'payment.succeeded'],
        ['order', 'ord_1', 'order.created'],
        ['attempt', 'att_1', 'attempt.confirmed'],
      ] as const;
      for (const [subjectType, subjectId, type] of written) {
        recordEvent(db, { subjectType, subjectId, type, nowMs: TEST_NOW_MS, data: {} });
      }

      expect(listEventsForSubjects(db, ['ord_1', 'att_1']).map((event) => event.type)).toEqual([
        'attempt.created',
        'payment.succeeded',
        'order.created',
        'attempt.confirmed',
      ]);
    });
  });

  test('drops subjects that have no events instead of inventing rows', () => {
    withDb((db) => {
      recordEvent(db, { subjectType: 'attempt', subjectId: 'att_1', type: 'attempt.created', nowMs: TEST_NOW_MS, data: {} });

      expect(listEventsForSubjects(db, ['att_1', 'att_absent'])).toHaveLength(1);
      expect(listEventsForSubjects(db, ['att_absent'])).toEqual([]);
    });
  });

  test('an empty subject list asks the database nothing', () => {
    // `WHERE subject_id IN ()` is not valid SQL, so the guard is what keeps an
    // order with no subjects from turning into a syntax error at the driver.
    withDb((db) => {
      expect(listEventsForSubjects(db, [])).toEqual([]);
    });
  });
});
