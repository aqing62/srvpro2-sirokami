import pTimeout = require('p-timeout');

export const OCGCORE_QUERY_TIMEOUT_MS = 10 * 1000;

export class OcgcoreTimeoutError extends pTimeout.TimeoutError {
  readonly isOcgcoreTimeoutError = true;

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    Object.defineProperty(this, 'name', {
      configurable: true,
      value: 'OcgcoreTimeoutError',
    });
  }

  static is(error: unknown): error is OcgcoreTimeoutError {
    if (error instanceof OcgcoreTimeoutError) {
      return true;
    }
    if (!error || typeof error !== 'object') {
      return false;
    }
    return (
      'isOcgcoreTimeoutError' in error ||
      (error as { name?: unknown }).name === 'OcgcoreTimeoutError'
    );
  }
}

export function withOcgcoreTimeout<T>(
  input: PromiseLike<T>,
  timeoutMs: number,
  message?: string | Error,
  options?: pTimeout.Options,
): Promise<T> {
  return pTimeout(Promise.resolve(input), timeoutMs, message, options);
}

export function withOcgcoreTimeoutFallback<T, R>(
  input: PromiseLike<T>,
  timeoutMs: number,
  fallback: () => R | Promise<R>,
  options?: pTimeout.Options,
): Promise<T | R> {
  return pTimeout(Promise.resolve(input), timeoutMs, fallback, options);
}

export function withOcgcoreQueryTimeout<T>(
  input: PromiseLike<T>,
  operation: string,
  timeoutMs = OCGCORE_QUERY_TIMEOUT_MS,
  options?: pTimeout.Options,
): Promise<T> {
  return withOcgcoreTimeout(
    input,
    timeoutMs,
    new OcgcoreTimeoutError(operation, timeoutMs),
    options,
  );
}
