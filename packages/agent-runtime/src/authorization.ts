import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { FlowError } from './errors';
import type { ApprovalClaims } from './types';

/** LOCAL MOCK ONLY. C0 wire format, issuer/key configuration remain pending B review. */
export class LocalMockIssuer {
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  constructor(private readonly now: () => number = Date.now) {
    const keys = generateKeyPairSync('ed25519');
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
  }
  issue(claims: ApprovalClaims): string {
    if (Date.parse(claims.expires_at) <= this.now()) throw new FlowError('authorization_invalid', '购买许可已经失效。');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signingInput = `local-mock-v1.${payload}`;
    return `${signingInput}.${sign(null, Buffer.from(signingInput), this.privateKey).toString('base64url')}`;
  }
}

export function verifyLocalMockProof(proof: string, publicKey: KeyObject, now = Date.now()): ApprovalClaims {
  try {
    const [version, payload, signature, extra] = proof.split('.');
    if (version !== 'local-mock-v1' || !payload || !signature || extra) throw new Error();
    if (!verify(null, Buffer.from(`${version}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))) throw new Error();
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ApprovalClaims;
    if (claims.issuer !== 'shopping-agent-local-mock' || !Number.isFinite(Date.parse(claims.expires_at))
      || Date.parse(claims.expires_at) <= now) throw new Error();
    return claims;
  } catch { throw new FlowError('authorization_invalid', '购买许可无效或已过期。'); }
}
