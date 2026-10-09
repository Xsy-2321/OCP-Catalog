/** Exercise source-only shopping tests and normal Turbo cache invalidation in
 * an isolated copy. Never remove or change artifacts in the current checkout. */
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const repository = path.resolve(import.meta.dir, '..');
const runId = crypto.randomUUID().slice(0, 12);
const evidence = path.join(repository, '.codex-tmp', 'engineering-inputs', `run-${runId}`);
// Keep dependency paths short on Windows; evidence lives separately so deeply
// nested package files do not inherit the report directory's long name.
const snapshot = path.join(repository, '.codex-tmp', `ei-${runId}`);
const bun = process.execPath;
const environment = { ...process.env };
delete environment.TURBO_FORCE;
const results: Record<string, unknown> = { status: 'running', snapshot, steps: [] };
const steps = results.steps as Record<string, unknown>[];

async function record() {
  await writeFile(path.join(evidence, 'report.json'), `${JSON.stringify(results, null, 2)}\n`);
}
async function run(name: string, command: string[], cwd = snapshot) {
  const child = Bun.spawn(command, { cwd, env: environment, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  await writeFile(path.join(evidence, `${name}.log`), stdout + stderr);
  steps.push({ name, exit });
  await record();
  if (exit !== 0) throw new Error(`${name} failed (${exit}); see ${path.join(evidence, `${name}.log`)}`);
  console.log(`${name}: passed`);
  return stdout;
}
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function removeSnapshotOutput(relative: string) {
  const target = path.resolve(snapshot, relative);
  requireCondition(target.startsWith(`${snapshot}${path.sep}`), 'Output removal escaped the snapshot');
  await rm(target, { recursive: true, force: true });
}
async function hashDirectory(directory: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(current: string) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        hash.update(path.relative(directory, full).replaceAll('\\', '/'));
        hash.update('\0'); hash.update(await readFile(full)); hash.update('\0');
      } else throw new Error(`Unexpected skill payload entry: ${full}`);
    }
  }
  await walk(directory);
  return hash.digest('hex');
}
async function assertPayloads() {
  const canonical = await hashDirectory(path.join(snapshot, 'skills/ocp-catalog'));
  for (const relative of ['packages/ocp-cli/dist/skills/ocp-catalog', 'packages/ocp-skill/skill']) {
    requireCondition(await hashDirectory(path.join(snapshot, relative)) === canonical, `${relative} differs from canonical skill`);
  }
  return canonical;
}
interface TaskSummary { taskId: string; hash: string; cache: { status: string } }
async function build(name: string) {
  const summaries = path.join(snapshot, '.turbo/runs');
  const before = new Set(await readdir(summaries).catch(() => [] as string[]));
  await run(name, [bun, 'run', 'build', '--filter=@ocp-catalog/ocp-cli', '--filter=@ocp-catalog/skill', '--cache=local:rw', '--summarize']);
  const created = (await readdir(summaries)).filter(file => !before.has(file) && file.endsWith('.json'));
  requireCondition(created.length === 1, `${name} did not produce exactly one Turbo summary`);
  const summary = JSON.parse(await readFile(path.join(summaries, created[0]!), 'utf8')) as { tasks: TaskSummary[] };
  const tasks = summary.tasks.filter(task => ['@ocp-catalog/ocp-cli#build', '@ocp-catalog/skill#build'].includes(task.taskId));
  requireCondition(tasks.length === 2, `${name} did not build both distribution packages`);
  const result = { name, payload_hash: await assertPayloads(), tasks: tasks.map(task => ({ id: task.taskId, hash: task.hash, cache: task.cache.status })) };
  steps.push(result); await record();
  return result;
}
function assertCache(result: Awaited<ReturnType<typeof build>>, status: 'HIT' | 'MISS') {
  requireCondition(result.tasks.every(task => task.cache.toUpperCase() === status), `${result.name}: expected both distribution tasks to be ${status}`);
}
function assertChanged(before: Awaited<ReturnType<typeof build>>, after: Awaited<ReturnType<typeof build>>) {
  assertCache(after, 'MISS');
  for (const task of after.tasks) requireCondition(task.hash !== before.tasks.find(previous => previous.id === task.id)?.hash, `${task.id} hash ignored the changed source`);
}

await Promise.all([mkdir(snapshot, { recursive: true }), mkdir(evidence, { recursive: true })]);
try {
  const files = await run('source-inventory', ['git', '-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], repository);
  let copied = 0;
  for (const relative of new Set(files.split('\0').filter(Boolean))) {
    const source = path.join(repository, relative);
    const destination = path.resolve(snapshot, relative);
    requireCondition(destination.startsWith(`${snapshot}${path.sep}`), 'Source file escaped the snapshot');
    if (!await Bun.file(source).exists()) continue;
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination); copied++;
  }
  results.copied_source_files = copied;
  const generated = path.join(snapshot, 'apps/shopping-agent-web/public/contracts.js');
  requireCondition(!await Bun.file(generated).exists(), 'Snapshot unexpectedly contains generated browser contracts');
  results.generated_contracts_before = false;
  await run('snapshot-git', ['git', 'init', '--quiet']);
  await run('frozen-dependencies', [bun, 'install', '--frozen-lockfile', '--ignore-scripts']);
  // This is intentionally before any build and exercises the public root entry.
  await run('shopping-test-clean-source', [bun, 'run', 'shopping:test']);
  requireCondition(await Bun.file(generated).exists(), 'shopping:test failed to prepare browser contracts');
  results.generated_contracts_after = true;
  const first = await build('initial-build');
  assertCache(first, 'MISS');
  await removeSnapshotOutput('packages/ocp-cli/dist');
  await removeSnapshotOutput('packages/ocp-skill/skill');
  const warm = await build('unchanged-cache-restore');
  assertCache(warm, 'HIT');
  requireCondition(warm.payload_hash === first.payload_hash, 'Cache restore changed the skill payload');
  const skillFile = path.join(snapshot, 'skills/ocp-catalog/SKILL.md');
  await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\n<!-- isolated canonical-input probe -->\n`);
  const skillChanged = await build('canonical-skill-changed');
  assertChanged(warm, skillChanged);
  requireCondition(skillChanged.payload_hash !== first.payload_hash, 'Canonical change was not distributed');
  const syncFile = path.join(snapshot, 'scripts/sync-skill-copies.ts');
  await writeFile(syncFile, `${await readFile(syncFile, 'utf8')}\nconsole.log('isolated sync-script probe');\n`);
  const syncChanged = await build('sync-script-changed');
  assertChanged(skillChanged, syncChanged);
  requireCondition((await readFile(path.join(evidence, 'sync-script-changed.log'), 'utf8')).includes('isolated sync-script probe'), 'The changed sync script was not executed');
  await removeSnapshotOutput('packages/ocp-cli/dist');
  await removeSnapshotOutput('packages/ocp-skill/skill');
  const final = await build('final-cache-restore');
  assertCache(final, 'HIT');
  requireCondition(final.payload_hash === syncChanged.payload_hash, 'Final cached payload is stale');
  results.status = 'passed';
  await record();
  console.log(`Engineering input checks passed: ${path.join(evidence, 'report.json')}`);
} catch (error) {
  results.status = 'failed';
  results.error = error instanceof Error ? error.message : String(error);
  await record();
  throw error;
}
