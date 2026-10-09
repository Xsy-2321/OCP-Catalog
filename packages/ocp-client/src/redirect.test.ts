import { afterEach, describe, expect, it } from 'bun:test';
import { OcpClient, OcpClientError } from './index';

const originalFetch = globalThis.fetch;
const servers: ReturnType<typeof Bun.serve>[] = [];
const apiKey = 'ocp-security-regression-test-key';

function serve(handler: (request: Request) => Response) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  servers.push(server);
  return server.url.origin;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const server of servers.splice(0)) server.stop(true);
});

describe('OcpClient redirect credential boundary', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    for (const method of ['GET', 'POST'] as const) {
      it(`rejects ${method} ${status} before contacting a different origin`, async () => {
        const leakedRequests: string[] = [];
        const destination = serve(request => {
          leakedRequests.push(request.url);
          return Response.json({ events: [] });
        });
        const initialRequests: { method: string; apiKey: string | null }[] = [];
        const origin = serve(request => {
          initialRequests.push({ method: request.method, apiKey: request.headers.get('x-api-key') });
          return new Response(null, { status, headers: { location: `${destination}/destination` } });
        });
        const client = new OcpClient({ apiKey });
        const pending = method === 'GET'
          ? client.listActivityEvents(origin)
          : client.ingestActivityEvent(origin, { event_type: 'client.call_attempted', metadata: {} });

        await expect(pending).rejects.toBeInstanceOf(OcpClientError);
        expect(initialRequests).toHaveLength(1);
        expect(initialRequests[0].method).toBe(method);
        expect(initialRequests[0].apiKey).toBe(apiKey);
        expect(leakedRequests).toHaveLength(0);
      });
    }
  }

  it('also rejects same-origin redirects and preserves direct request behavior', async () => {
    const paths: string[] = [];
    const origin = serve(request => {
      const url = new URL(request.url);
      paths.push(url.pathname);
      expect(request.headers.get('x-api-key')).toBe(apiKey);
      if (url.pathname === '/redirect/api/activity/recent') {
        return new Response(null, { status: 302, headers: { location: '/api/activity/recent' } });
      }
      return Response.json({ events: [] });
    });
    const client = new OcpClient({ apiKey });

    await expect(client.listActivityEvents(`${origin}/redirect`)).rejects.toBeInstanceOf(OcpClientError);
    expect(paths).toEqual(['/redirect/api/activity/recent']);
    expect(await client.listActivityEvents(origin)).toEqual({ events: [] });
  });

  it('does not redirect automatic activity reporting with its separate API key', async () => {
    const destinationRequests: string[] = [];
    const destination = serve(request => {
      destinationRequests.push(request.url);
      return Response.json({ ok: true });
    });
    const activityRequests: { apiKey: string | null }[] = [];
    const origin = serve(request => {
      if (new URL(request.url).pathname === '/ocp/audit/events') {
        activityRequests.push({ apiKey: request.headers.get('x-api-key') });
        return new Response(null, { status: 307, headers: { location: `${destination}/events` } });
      }
      return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
    });
    const pendingRequests: Promise<Response>[] = [];
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const pending = originalFetch(input, init);
      pendingRequests.push(pending);
      return pending;
    }) as typeof fetch;
    const client = new OcpClient({
      apiKey,
      activity: { apiUrl: origin, apiKey: 'activity-test-key' },
    });

    await expect(client.inspectCatalog(`${origin}/manifest`)).rejects.toBeInstanceOf(OcpClientError);
    await Promise.allSettled(pendingRequests);
    expect(activityRequests).toHaveLength(2);
    for (const request of activityRequests) {
      expect(request.apiKey).toBe('activity-test-key');
    }
    expect(destinationRequests).toHaveLength(0);
  });
});
