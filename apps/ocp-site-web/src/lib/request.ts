export const REQUEST_TIMEOUT_MS = 10_000;

export type JsonRequestOptions = RequestInit & {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** Bound both fetching headers and reading the body, and cancel on teardown. */
export async function requestJson(url: string, options: JsonRequestOptions = {}): Promise<unknown> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl = fetch, signal, ...init } = options;
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason ?? new Error('Request cancelled'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();

  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );

  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const operation = (async () => {
      const response = await fetchImpl(url, {
        ...init,
        headers: { accept: 'application/json', ...Object.fromEntries(new Headers(init.headers)) },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<unknown>;
    })();
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

/** Schedule the next cycle only after the current one settles. */
export function startPolling(task: (signal: AbortSignal) => Promise<void>, pollMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let refreshRequested = false;

  function run() {
    if (controller.signal.aborted || running) return;
    running = true;
    const settled = () => {
      running = false;
      if (controller.signal.aborted) return;
      const delay = refreshRequested ? 0 : pollMs;
      refreshRequested = false;
      timer = setTimeout(run, delay);
    };
    // Callers publish their own error state. A rejected cycle still allows recovery.
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) return task(controller.signal);
    }).then(settled, settled);
  }

  run();
  return {
    refresh() {
      if (controller.signal.aborted) return;
      if (running) refreshRequested = true;
      else {
        clearTimeout(timer);
        run();
      }
    },
    stop() {
      clearTimeout(timer);
      controller.abort(new Error('Polling stopped'));
    },
  };
}
