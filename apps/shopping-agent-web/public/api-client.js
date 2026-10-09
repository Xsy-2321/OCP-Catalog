export class ApiError extends Error {
  /** @param {string} message @param {number} status @param {string | undefined} [code] */
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** @param {unknown} error @param {string} fallback */
export function errorMessage(error, fallback) {
  return error instanceof Error ? error.message : fallback;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @template T
 * @param {string} path
 * @param {(value: unknown) => T} parse
 * @param {Record<string, unknown> | undefined} [body]
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function request(path, parse, body, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    /** @type {unknown} */
    const result = await response.json();
    if (!response.ok) {
      const error = isRecord(result) && isRecord(result.error) ? result.error : {};
      throw new ApiError(typeof error.message === 'string' ? error.message : '操作暂时无法完成。', response.status,
        typeof error.code === 'string' ? error.code : undefined);
    }
    return parse(result);
  } finally {
    clearTimeout(timer);
  }
}
