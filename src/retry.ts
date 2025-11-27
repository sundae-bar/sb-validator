/**
 * Retry utilities with exponential backoff
 */

import logger from './logger';

export interface RetryOptions {
  maxRetries?: number;
  retryDelay?: number;
  exponentialBackoff?: boolean;
  onRetry?: (error: Error, attempt: number) => void;
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    retryDelay = 1000,
    exponentialBackoff = true,
    onRetry
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxRetries) {
        logger.error(
          { attempt: attempt + 1, maxRetries: maxRetries + 1, error: lastError.message },
          'Max retries reached'
        );
        throw lastError;
      }

      const delay = exponentialBackoff
        ? retryDelay * Math.pow(2, attempt)
        : retryDelay;

      logger.warn(
        { attempt: attempt + 1, maxRetries: maxRetries + 1, delay, error: lastError.message },
        'Retrying after error'
      );

      if (onRetry) {
        onRetry(lastError, attempt + 1);
      }

      await sleep(delay);
    }
  }

  throw lastError || new Error('Unknown error in retry');
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry with specific error handling
 */
export async function retryWithCondition<T>(
  fn: () => Promise<T>,
  shouldRetry: (error: Error) => boolean,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    retryDelay = 1000,
    exponentialBackoff = true
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry this error
      if (!shouldRetry(lastError)) {
        logger.error({ error: lastError.message }, 'Non-retryable error');
        throw lastError;
      }

      if (attempt === maxRetries) {
        logger.error(
          { attempt: attempt + 1, maxRetries: maxRetries + 1, error: lastError.message },
          'Max retries reached'
        );
        throw lastError;
      }

      const delay = exponentialBackoff
        ? retryDelay * Math.pow(2, attempt)
        : retryDelay;

      logger.warn(
        { attempt: attempt + 1, maxRetries: maxRetries + 1, delay, error: lastError.message },
        'Retrying after retryable error'
      );

      await sleep(delay);
    }
  }

  throw lastError || new Error('Unknown error in retry');
}

