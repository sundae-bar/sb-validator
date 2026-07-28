/**
 * Optional Sentry error monitoring. Enabled only when SENTRY_DSN is set;
 * every capture below is a silent no-op otherwise.
 */

import * as Sentry from '@sentry/node';
import logger from './logger';

let enabled = false;

/** Slug of the weights cron monitor; Sentry alerts when check-ins stop arriving. */
const WEIGHTS_MONITOR_SLUG = 'validator-weights-submission';

/** Start Sentry when SENTRY_DSN is set. Returns whether monitoring is active. */
export const initMonitoring = (release?: string): boolean => {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    logger.info('SENTRY_DSN not set — error monitoring disabled');
    return false;
  }
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE?.trim() || release,
    tracesSampleRate: 0,
    // Crash capture happens explicitly in index.ts so the existing exit path stays in charge.
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== 'OnUncaughtException' && i.name !== 'OnUnhandledRejection'),
  });
  enabled = true;
  logger.info('Sentry error monitoring enabled');
  return true;
};

/** Capture an exception; context entries become searchable tags. */
export const captureError = (error: unknown, context: Record<string, string>): void => {
  if (!enabled) {
    return;
  }
  Sentry.withScope((scope) => {
    scope.setTags(context);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
};

/** Capture a message-only alert (no exception object), e.g. the watchdog firing. */
export const captureAlert = (message: string, context: Record<string, string>): void => {
  if (!enabled) {
    return;
  }
  Sentry.withScope((scope) => {
    scope.setTags(context);
    Sentry.captureMessage(message, 'error');
  });
};

/** Check in after a successful on-chain submit; silence past the margin trips a missed-check-in alert. */
export const checkInWeightsMonitor = (intervalMinutes: number): void => {
  if (!enabled) {
    return;
  }
  Sentry.captureCheckIn(
    { monitorSlug: WEIGHTS_MONITOR_SLUG, status: 'ok' },
    {
      schedule: { type: 'interval', value: intervalMinutes, unit: 'minute' },
      checkinMargin: intervalMinutes * 2,
      maxRuntime: intervalMinutes,
      timezone: 'Etc/UTC',
    },
  );
};

/** Flush pending events before an exit path; best-effort. */
export const flushMonitoring = async (timeoutMs = 2_000): Promise<void> => {
  if (!enabled) {
    return;
  }
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Exiting anyway.
  }
};
