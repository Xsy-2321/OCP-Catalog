#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';
import {
  OcpClient,
  OcpClientError,
  OcpClientValidationError,
  createCorrelationId,
  validateCatalogQueryRequest,
} from '@ocp-catalog/ocp-client';
import {
  catalogManifestSchema,
  catalogQueryRequestSchema,
  objectSyncRequestSchema,
  providerRegistrationSchema,
  resolveRequestSchema,
  type CatalogManifest,
} from '@ocp-catalog/ocp-schema';
import { doctorOcpSkill, installOcpSkill, uninstallOcpSkill, type SkillTarget } from './skill-installer';
import { CLI_HELP, FULL_CLI_HELP, findCommandHelp, findDomainHelp } from './help';
import { redactSavedProviderApiKey } from './provider-output';
import { updateOcpCliAndSkill } from './update';

const CLI_PACKAGE_NAME = '@ocp-catalog/ocp-cli';
const CLI_VERSION = '0.1.3';
const args = process.argv.slice(2);

try {
  const result = await run(args);
  if (result !== undefined) printJson(result);
} catch (error) {
  const payload = error instanceof OcpClientValidationError
    ? { error: { code: 'validation_error', message: error.message, details: error.details } }
    : isZodLikeError(error)
    ? { error: { code: 'validation_error', message: 'Request does not match the OCP protocol schema', details: formatZodLikeError(error) } }
    : error instanceof OcpClientError
    ? { error: { code: 'ocp_client_error', message: error.message, details: error.details } }
    : { error: { code: 'cli_error', message: error instanceof Error ? error.message : String(error) } };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

async function run(argv: string[]) {
  const [domain, command, ...rest] = argv;
  if (domain === 'version' || domain === '--version' || domain === '-v') {
    return {
      name: CLI_PACKAGE_NAME,
      version: CLI_VERSION,
    };
  }
  if (!domain || domain === 'help' || domain === '--help' || domain === '-h') {
    return help(domain === 'help' ? [command, ...rest].filter((item): item is string => !!item) : []);
  }
  if (command === 'help' || command === '--help' || command === '-h') return help([domain]);
  if (rest.includes('help') || rest.includes('--help') || rest.includes('-h')) return help([domain, command].filter(Boolean));

  if (domain === 'setup') {
    const flags = parseFlags([command, ...rest].filter((item): item is string => !!item));
    return installOcpSkill({
      target: skillTargetFromFlags(flags),
      dryRun: booleanFlag(flags, 'dry-run', false),
      force: booleanFlag(flags, 'force', false),
      sourceDir: stringFlag(flags, 'source-dir'),
    });
  }

  if (domain === 'skill' && (command === 'install' || command === 'update')) {
    const flags = parseFlags(rest);
    return installOcpSkill({
      target: skillTargetFromFlags(flags),
      dryRun: booleanFlag(flags, 'dry-run', false),
      force: booleanFlag(flags, 'force', false),
      sourceDir: stringFlag(flags, 'source-dir'),
    });
  }

  if (domain === 'skill' && command === 'uninstall') {
    const flags = parseFlags(rest);
    return uninstallOcpSkill({
      target: skillTargetFromFlags(flags),
      dryRun: booleanFlag(flags, 'dry-run', false),
      force: booleanFlag(flags, 'force', false),
    });
  }

  if (domain === 'skill' && command === 'doctor') {
    const flags = parseFlags(rest);
    return doctorOcpSkill(skillTargetFromFlags(flags));
  }

  if (domain === 'update') {
    const flags = parseFlags([command, ...rest].filter((item): item is string => !!item));
    return updateOcpCliAndSkill({
      manager: stringFlag(flags, 'manager', 'bun'),
      dryRun: booleanFlag(flags, 'dry-run', false),
      target: skillTargetFromFlags(flags),
    });
  }

  const flags = parseFlags(rest);
  const client = new OcpClient({
    timeoutMs: numberFlag(flags, 'timeout-ms', 10_000),
    userAgent: stringFlag(flags, 'user-agent', `ocp-cli/${CLI_VERSION}`),
    apiKey: stringFlag(flags, 'api-key'),
    correlationId: stringFlag(flags, 'correlation-id', createCorrelationId('cli')),
  });

  if (domain === 'registration' && command === 'discover') {
    const url = flags.positionals[0] ?? requiredFlag(flags, 'url');
    return client.discoverRegistration(url);
  }

  if (domain === 'registration' && command === 'search') {
    const registrationUrl = requiredFlag(flags, 'registration-url');
    return client.searchCatalogs(registrationUrl, {
      ocp_version: '1.0',
      kind: 'CatalogSearchRequest',
      query: stringFlag(flags, 'query') ?? '',
      limit: numberFlag(flags, 'limit', 20),
      explain: booleanFlag(flags, 'explain', true),
      filters: jsonFlag(flags, 'filters', {}),
    });
  }

  if (domain === 'registration' && command === 'resolve') {
    return client.resolveCatalogRoute(requiredFlag(flags, 'registration-url'), requiredFlag(flags, 'catalog-id'));
  }

  if (domain === 'catalog' && command === 'inspect') {
    const manifestUrl = flags.positionals[0] ?? requiredFlag(flags, 'manifest-url');
    return client.inspectCatalog(manifestUrl);
  }

  if (domain === 'provider' && command === 'register') {
    const request = providerRegistrationSchema.parse(await loadJsonFile(requiredFlag(flags, 'input')));
    const result = await client.registerProvider(requiredFlag(flags, 'register-url'), request);
    const saveApiKeyPath = stringFlag(flags, 'save-api-key');
    if (saveApiKeyPath && result.provider_api_key) {
      await writeFile(saveApiKeyPath, `${result.provider_api_key}\n`, { mode: 0o600 });
      return redactSavedProviderApiKey(result, saveApiKeyPath);
    }
    return result;
  }

  if (domain === 'provider' && command === 'sync') {
    requiredFlag(flags, 'api-key');
    const request = objectSyncRequestSchema.parse(await loadJsonFile(requiredFlag(flags, 'input')));
    return client.syncObjects(requiredFlag(flags, 'sync-url'), request);
  }

  if (domain === 'catalog' && command === 'query') {
    const queryPack = stringFlag(flags, 'query-pack');
    const queryMode = stringFlag(flags, 'query-mode');
    let request = catalogQueryRequestSchema.parse({
      ocp_version: '1.0',
      kind: 'CatalogQueryRequest',
      ...(queryPack ? { query_pack: queryPack } : {}),
      ...(queryMode ? { query_mode: queryMode } : {}),
      query: stringFlag(flags, 'query') ?? '',
      filters: jsonFlag(flags, 'filters', {}),
      limit: numberFlag(flags, 'limit', 20),
      offset: numberFlag(flags, 'offset', 0),
      ...(stringFlag(flags, 'cursor') ? { cursor: stringFlag(flags, 'cursor') } : {}),
      explain: booleanFlag(flags, 'explain', true),
    });

    const manifestTarget = stringFlag(flags, 'manifest');
    if (manifestTarget) {
      const manifest = catalogManifestSchema.parse(await loadManifestTarget(client, manifestTarget));
      request = validateCatalogQueryRequest(manifest, request, {
        queryUrl: requiredFlag(flags, 'query-url'),
      }).request;
    }

    return client.queryCatalog(requiredFlag(flags, 'query-url'), request);
  }

  if (domain === 'catalog' && command === 'resolve') {
    const request = resolveRequestSchema.parse({
      ocp_version: '1.0',
      kind: 'ResolveRequest',
      entry_id: requiredFlag(flags, 'entry-id'),
      purpose: stringFlag(flags, 'purpose') ?? 'view',
    });
    return client.resolveCatalogEntry(requiredFlag(flags, 'resolve-url'), request);
  }

  if (domain === 'validate' && command === 'manifest') {
    const target = flags.positionals[0] ?? requiredFlag(flags, 'input');
    const payload = await loadManifestTarget(client, target);
    return {
      ok: true,
      manifest: catalogManifestSchema.parse(payload),
    };
  }

  if (domain === 'validate' && command === 'query') {
    const manifestTarget = requiredFlag(flags, 'manifest');
    const manifest = catalogManifestSchema.parse(await loadManifestTarget(client, manifestTarget));
    const queryPack = stringFlag(flags, 'query-pack');
    const queryMode = stringFlag(flags, 'query-mode');
    const request = catalogQueryRequestSchema.parse({
      ocp_version: '1.0',
      kind: 'CatalogQueryRequest',
      ...(queryPack ? { query_pack: queryPack } : {}),
      ...(queryMode ? { query_mode: queryMode } : {}),
      query: stringFlag(flags, 'query') ?? '',
      filters: jsonFlag(flags, 'filters', {}),
      limit: numberFlag(flags, 'limit', 20),
      offset: numberFlag(flags, 'offset', 0),
      ...(stringFlag(flags, 'cursor') ? { cursor: stringFlag(flags, 'cursor') } : {}),
      explain: booleanFlag(flags, 'explain', true),
    });

    return validateCatalogQueryRequest(manifest, request);
  }

  if (domain === 'events' && command === 'tail') {
    return client.listActivityEvents(requiredFlag(flags, 'activity-url'), numberFlag(flags, 'limit', 50));
  }

  throw new Error(`Unknown command: ${[domain, command].filter(Boolean).join(' ')}`);
}

function help(tokens: string[] = []) {
  const command = findCommandHelp(tokens);
  if (command) return { ...command, workflow: CLI_HELP.workflow };
  const domain = findDomainHelp(tokens);
  if (domain) return { ...domain, workflow: CLI_HELP.workflow };
  return FULL_CLI_HELP;
}

async function loadManifestTarget(client: OcpClient, target: string): Promise<CatalogManifest | unknown> {
  return target.startsWith('http://') || target.startsWith('https://')
    ? client.inspectCatalog(target)
    : JSON.parse(await readFile(target, 'utf8'));
}

async function loadJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

function skillTargetFromFlags(flags: ParsedFlags): SkillTarget {
  const explicitDir = stringFlag(flags, 'dir');
  if (explicitDir) return explicitDir;

  const explicitTarget = stringFlag(flags, 'target');
  if (explicitTarget) return explicitTarget;

  const agent = stringFlag(flags, 'agent');

  const scope = stringFlag(flags, 'scope', 'user');
  if (scope === 'project') {
    // Project scope writes into the repo, using the layout the chosen agent
    // reads: Claude Code looks in .claude/skills, the others in .agents/skills.
    return agent === 'claude'
      ? pathJoin(process.cwd(), '.claude', 'skills')
      : pathJoin(process.cwd(), '.agents', 'skills');
  }

  if (agent === 'all') return 'all';
  if (agent === 'codex' || agent === 'agents' || agent === 'claude') return agent;

  return 'auto';
}

function pathJoin(...parts: string[]) {
  return parts.join(process.platform === 'win32' ? '\\' : '/');
}

type ParsedFlags = {
  positionals: string[];
  values: Map<string, string | boolean>;
};

function parseFlags(argv: string[]): ParsedFlags {
  const values = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }

    const equals = item.indexOf('=');
    if (equals !== -1) {
      values.set(item.slice(2, equals), item.slice(equals + 1));
      continue;
    }

    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      values.set(key, true);
      continue;
    }

    values.set(key, next);
    index += 1;
  }

  return { positionals, values };
}

function requiredFlag(flags: ParsedFlags, key: string) {
  const value = stringFlag(flags, key);
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}

function stringFlag(flags: ParsedFlags, key: string, fallback?: string) {
  const value = flags.values.get(key);
  return typeof value === 'string' ? value : fallback;
}

function numberFlag(flags: ParsedFlags, key: string, fallback: number) {
  const value = stringFlag(flags, key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
  return parsed;
}

function booleanFlag(flags: ParsedFlags, key: string, fallback: boolean) {
  const value = flags.values.get(key);
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
}

function jsonFlag<T>(flags: ParsedFlags, key: string, fallback: T): T {
  const value = stringFlag(flags, key);
  return value ? JSON.parse(value) as T : fallback;
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

type ZodLikeIssue = {
  code?: string;
  path?: Array<string | number>;
  message?: string;
};

type ZodLikeError = {
  issues: ZodLikeIssue[];
};

function isZodLikeError(error: unknown): error is ZodLikeError {
  return Boolean(error)
    && typeof error === 'object'
    && Array.isArray((error as { issues?: unknown }).issues);
}

function formatZodLikeError(error: ZodLikeError) {
  return {
    code: 'protocol_schema_error',
    correction: 'Adjust the request so every field matches the OCP protocol schema before sending it.',
    issues: error.issues.map((issue) => ({
      code: issue.code ?? 'invalid',
      path: issue.path?.join('.') ?? '',
      message: issue.message ?? 'Invalid value',
    })),
  };
}
