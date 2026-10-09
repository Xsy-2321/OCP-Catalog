export interface AuditAdvisory { url: string; severity: string; title: string }
export interface AuditException {
  package: string; advisory: string; severity: string; versions: string[]; expires: string; reason: string; source: string;
}
export function evaluateAudit(
  audit: Record<string, AuditAdvisory[]>, exceptions: AuditException[], installed: Map<string, Set<string>>, now = Date.now(),
) {
  const accepted: string[] = [], rejected: string[] = [];
  for (const [name, advisories] of Object.entries(audit)) {
    for (const advisory of advisories) {
      const id = advisory.url.split('/').at(-1)!;
      const exception = exceptions.find(value => value.package === name && value.advisory === id && value.severity === advisory.severity);
      const versions = installed.get(name);
      const expiry = exception ? Date.parse(`${exception.expires}T00:00:00+08:00`) : NaN;
      const expired = !Number.isFinite(expiry) || now >= expiry;
      const versionsMatch = versions && versions.size > 0 && [...versions].every(version => exception?.versions.includes(version));
      const label = `${name}: ${id} (${advisory.severity})`;
      if (!expired && versionsMatch && exception?.reason) accepted.push(label);
      else rejected.push(label);
    }
  }
  return { accepted, rejected };
}

/** Read only the resolved package tuple identifiers, not dependency ranges. */
export function lockfileVersions(lock: string): Map<string, Set<string>> {
  const installed = new Map<string, Set<string>>();
  for (const match of lock.matchAll(/^\s*"[^"]+":\s*\["((?:@[^/]+\/)?[^@"]+)@([^"]+)"/gm)) {
    const [, name, version] = match;
    const versions = installed.get(name!) ?? new Set<string>();
    versions.add(version!); installed.set(name!, versions);
  }
  return installed;
}
