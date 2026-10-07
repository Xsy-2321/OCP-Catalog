import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { FlowError } from './errors';
import type { ApprovalClaims } from './types';
import { AUTH_DOMAIN, AUTH_SCHEME, authorizationProofSchema, authorizationSignedPayloadSchema,
  authorizationSigningBytes } from '@ocp-catalog/shopping-contracts';

/** A backend issuer. Returned credentials exist only between confirmation and checkout. */
export interface AuthorizationIssuer {
  readonly issuer: string;
  issue(claims: ApprovalClaims): string;
}

export interface Ed25519AuthorizationIssuerOptions {
  issuer: string;
  keyId: string;
  privateKey: KeyObject;
  now?: () => number;
}

/** The shared B Ed25519 wire format, with a backend-owned identity and key. */
export class Ed25519AuthorizationIssuer implements AuthorizationIssuer {
  readonly issuer: string;
  private readonly now: () => number;
  constructor(private readonly options: Ed25519AuthorizationIssuerOptions) {
    if (!options.issuer.trim() || !options.keyId.trim() || options.privateKey.type !== 'private'
      || options.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('invalid authorization issuer configuration');
    this.issuer = options.issuer;
    this.now = options.now ?? Date.now;
  }
  issue(claims: ApprovalClaims): string {
    const current = this.now();
    const issuedAt = Math.floor(current / 1000);
    const expiresAt = Math.floor(Math.min(Date.parse(claims.expires_at), current + 60_000) / 1000);
    if (claims.issuer !== this.issuer || !Number.isSafeInteger(claims.max_total_minor)
      || claims.max_total_minor < 0 || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= issuedAt) throw new FlowError('authorization_invalid', '购买许可无效或有效时间不足，请重新报价。');
    const parsed = authorizationSignedPayloadSchema.safeParse({
      v: AUTH_DOMAIN, issuer: this.issuer, user_id: claims.user_id, merchant_id: claims.merchant_id,
      quote_id: claims.quote_id, terms_hash: claims.terms_hash, currency: claims.currency,
      max_total_minor: claims.max_total_minor, purchase_attempt_id: claims.purchase_attempt_id,
      issued_at: issuedAt, expires_at: expiresAt, jti: `approval_${crypto.randomUUID()}`,
    });
    if (!parsed.success) throw new FlowError('authorization_invalid', '购买许可与当前确认条款不一致。');
    const payload = parsed.data;
    return JSON.stringify(authorizationProofSchema.parse({ scheme: AUTH_SCHEME, key_id: this.options.keyId,
      signature: sign(null, authorizationSigningBytes(payload), this.options.privateKey).toString('base64url'), payload }));
  }
}

/** LOCAL MOCK ONLY. C0 wire format, issuer/key configuration remain pending B review. */
export class LocalMockIssuer implements AuthorizationIssuer {
  readonly issuer = 'shopping-agent-local-mock';
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
