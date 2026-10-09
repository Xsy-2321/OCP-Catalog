import { describe, expect, test } from 'bun:test';
import { requestJson, startPolling } from './request';

describe('bounded requests and polling recovery', () => {
  test('a stalled response body times out and aborts the transport', async () => {
    let signal: AbortSignal | null = null;
    const fetchImpl = (async (_: string, options: RequestInit) => {
      signal = options.signal ?? null;
      return new Response(new ReadableStream());
    }) as typeof fetch;
    await expect(requestJson('https://example.test', { timeoutMs: 5, fetchImpl })).rejects.toThrow('timed out');
    expect(signal!.aborted).toBe(true);
  });

  test('caller cancellation immediately settles even when the transport stalls', async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const request = requestJson('https://example.test', { signal: controller.signal, fetchImpl });
    controller.abort(new Error('Leaving page'));
    await expect(request).rejects.toThrow('Leaving page');
  });

  test('refreshes coalesce while a cycle is running and stop cancels the next cycle', async () => {
    let finishFirst: () => void = () => {};
    let finishSecond: () => void = () => {};
    let secondStarted: () => void = () => {};
    const nextCycle = new Promise<void>((resolve) => { secondStarted = resolve; });
    let calls = 0;
    let activeSignal: AbortSignal | null = null;
    const polling = startPolling(async (signal) => {
      calls += 1;
      activeSignal = signal;
      if (calls === 1) await new Promise<void>((resolve) => { finishFirst = resolve; });
      else {
        secondStarted();
        await new Promise<void>((resolve) => { finishSecond = resolve; });
      }
    }, 5);
    await Bun.sleep(15);
    polling.refresh();
    polling.refresh();
    expect(calls).toBe(1);
    finishFirst();
    await nextCycle;
    expect(calls).toBe(2);
    polling.stop();
    expect(activeSignal!.aborted).toBe(true);
    finishSecond();
    await Bun.sleep(15);
    expect(calls).toBe(2);
  });

  test('a failed cycle still schedules recovery', async () => {
    let recovered: () => void = () => {};
    const recovery = new Promise<void>((resolve) => { recovered = resolve; });
    let calls = 0;
    const polling = startPolling(async () => {
      calls += 1;
      if (calls === 1) throw new Error('Temporary outage');
      recovered();
    }, 5);
    await recovery;
    polling.stop();
    expect(calls).toBe(2);
  });
});
