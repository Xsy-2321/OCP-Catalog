import { expect, test } from 'bun:test';
import { evaluateAudit, lockfileVersions, type AuditException } from '../../scripts/lib/dependency-audit';

const exception: AuditException = { package: 'demo', advisory: 'GHSA-demo', severity: 'high', versions: ['1.0.0'],
  expires: '2026-11-07', reason: 'Reviewed build-only input', source: 'https://github.com/advisories/GHSA-demo' };
const audit = { demo: [{ url: exception.source, severity: 'high', title: 'Demo advisory' }] };
const installed = new Map([['demo', new Set(['1.0.0'])]]);
const now = Date.parse('2026-10-08T00:00:00+08:00');
test('audit gate accepts only reviewed advisory/severity/installed-version combinations before expiry', () => {
  expect(evaluateAudit(audit, [exception], installed, now).rejected).toEqual([]);
  expect(evaluateAudit(audit, [], installed, now).rejected).toHaveLength(1);
  expect(evaluateAudit(audit, [exception], new Map([['demo', new Set(['1.0.1'])]]), now).rejected).toHaveLength(1);
  expect(evaluateAudit({ demo: [{ ...audit.demo[0]!, severity: 'critical' }] }, [exception], installed, now).rejected).toHaveLength(1);
  expect(evaluateAudit(audit, [exception], installed, Date.parse('2026-11-07T00:00:00+08:00')).rejected).toHaveLength(1);
});
test('lock extraction captures scoped and nested resolved versions without mistaking ranges for installations', () => {
  const result = lockfileVersions(`
    "demo": ["demo@1.0.0", "", {"dependencies":{"other":"^4.0.0"}}],
    "parent/demo": ["demo@1.0.1", ""],
    "@scope/name": ["@scope/name@2.0.0", ""],
  `);
  expect([...result.get('demo')!]).toEqual(['1.0.0', '1.0.1']);
  expect([...result.get('@scope/name')!]).toEqual(['2.0.0']);
  expect(result.has('other')).toBe(false);
});
