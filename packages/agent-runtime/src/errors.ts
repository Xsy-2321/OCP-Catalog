export class FlowError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'FlowError';
  }
}
export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof FlowError
    ? { code: error.code, message: error.message }
    : { code: 'unavailable', message: '服务暂时不可用，请查询原购买尝试。' };
}
