import { resolve } from 'node:path';
import { evaluateAudit, lockfileVersions, type AuditAdvisory, type AuditException } from './lib/dependency-audit';

const root = resolve(import.meta.dir, '..');
const child = Bun.spawn([process.execPath, 'audit', '--json'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
let audit: Record<string, AuditAdvisory[]>;
try {
  if (![0, 1].includes(exitCode)) throw new Error(`audit exited ${exitCode}`);
  audit = JSON.parse(stdout);
  if (!audit || Array.isArray(audit) || typeof audit !== 'object'
    || Object.values(audit).some(value => !Array.isArray(value) || value.some(item => typeof item.url !== 'string' || typeof item.severity !== 'string'))) {
    throw new Error('unexpected audit response');
  }
} catch {
  console.error('依赖扫描没有返回有效结果，验收失败。', stderr.trim()); process.exit(1);
}
const exceptions = await Bun.file(resolve(import.meta.dir, 'dependency-audit-exceptions.json')).json() as AuditException[];
const result = evaluateAudit(audit, exceptions, lockfileVersions(await Bun.file(resolve(root, 'bun.lock')).text()));
for (const label of result.accepted) console.log(`Reviewed build-only exception: ${label}`);
for (const label of result.rejected) console.error(`Unreviewed or expired vulnerability: ${label}`);
console.log(`${result.accepted.length} reviewed exceptions; ${result.rejected.length} unreviewed advisories`);
process.exitCode = result.rejected.length ? 1 : 0;
