/** Cancel a caller's wait while keeping the underlying queue/task tracked until it settles.
 * Network operations must also receive the same signal so cancellation stops the work.
 */
export function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
    operation.then(value => {
      signal.removeEventListener('abort', aborted);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => {
      signal.removeEventListener('abort', aborted);
      reject(signal.aborted ? signal.reason : error);
    });
  });
}

export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
