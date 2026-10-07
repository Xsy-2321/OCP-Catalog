/**
 * `@ocp-catalog/merchant-core` — the coffee merchant's server logic.
 *
 * This package holds everything the merchant does; `apps/coffee-merchant-api` is
 * only a `Bun.serve` bootstrap around `handleRequest`. Keeping the API in a
 * package means the whole surface is reachable from `bun test` without opening a
 * socket, which is the difference between "the routes are tested" and "the happy
 * path was tested once by hand".
 *
 * Everything in here is a demo extension, not an OCP protocol capability. The
 * payment is a local simulation with no provider behind it, and the caller
 * identity is a header, not an account system. Nothing in this package should be
 * described as production-ready, and nothing in it talks to a real payment
 * network or a commercial API.
 */

export * from './clock';
export * from './faults';
export * from './config';
export * from './db';
export * from './inventory';
export * from './context';
export * from './data/catalog';
export * from './catalog';
export * from './authorization';
export * from './quote';
export * from './idempotency';
export * from './payment';
export * from './events';
export * from './orders';
export * from './checkout';
export * from './http';
export * from './service';
