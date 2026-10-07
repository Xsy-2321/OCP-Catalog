import { join } from 'node:path';
import { LocalMockIssuer } from './authorization';
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

export async function createMockRuntime(dataDir: string, options: MockOptions = {}): Promise<ShoppingCoordinator> {
  const issuer = new LocalMockIssuer(options.now);
  const merchant = new MockMerchantTransport(join(dataDir, 'mock'), issuer.publicKey, options);
  return new ShoppingCoordinator(merchant, new FileSessionStore(join(dataDir, 'sessions')), issuer, MOCK_ORIGIN, options.now);
}
