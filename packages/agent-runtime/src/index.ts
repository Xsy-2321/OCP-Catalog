import { join } from 'node:path';
import { Ed25519AuthorizationIssuer, LocalMockIssuer, type Ed25519AuthorizationIssuerOptions } from './authorization';
import { HttpMerchantTransport, type HttpMerchantTransportOptions } from './http-transport';
import { ShoppingCoordinator } from './coordinator';
import { MOCK_ORIGIN, MockMerchantTransport, type MockOptions } from './mock-transport';
import { FileSessionStore } from './store';

export * from './types';
export * from './errors';
export * from './coordinator';
export * from './authorization';
export * from './store';
export * from './validation';
export * from './mock-transport';
export * from './tool-loop';
export * from './ocp-consumer';
export * from './http-transport';

export async function createMockRuntime(dataDir: string, options: MockOptions = {}): Promise<ShoppingCoordinator> {
  const issuer = new LocalMockIssuer(options.now);
  const merchant = new MockMerchantTransport(join(dataDir, 'mock'), issuer.publicKey, options);
  const store = new FileSessionStore(join(dataDir, 'sessions'));
  await store.bindScope({ mode: 'mock', origin: MOCK_ORIGIN, merchant_id: 'coffee-demo', catalog_id: 'mock_coffee_catalog' });
  return new ShoppingCoordinator(merchant, store, issuer, MOCK_ORIGIN, options.now);
}

export type HttpRuntimeOptions = HttpMerchantTransportOptions & Ed25519AuthorizationIssuerOptions;

/** Explicit HTTP assembly. Configuration/transport errors never select the mock merchant. */
export async function createHttpRuntime(dataDir: string, options: HttpRuntimeOptions): Promise<ShoppingCoordinator> {
  const issuer = new Ed25519AuthorizationIssuer(options);
  const merchant = new HttpMerchantTransport(options);
  const store = new FileSessionStore(join(dataDir, 'sessions'));
  await store.bindScope({ mode: 'http', origin: new URL(options.origin).origin,
    merchant_id: options.merchantId, catalog_id: options.catalogId });
  return new ShoppingCoordinator(merchant, store, issuer,
    options.origin, options.now, [options.merchantId]);
}
