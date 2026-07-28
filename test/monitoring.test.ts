import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initMonitoring,
  captureError,
  captureAlert,
  checkInWeightsMonitor,
  flushMonitoring,
} from '../src/monitoring';

test('initMonitoring stays disabled without SENTRY_DSN', () => {
  delete process.env.SENTRY_DSN;
  assert.equal(initMonitoring('1.0.0'), false);
});

test('captures and check-ins are no-ops when disabled', async () => {
  delete process.env.SENTRY_DSN;
  captureError(new Error('boom'), { stage: 'test' });
  captureError('not an Error instance', { stage: 'test' });
  captureAlert('something noteworthy', { stage: 'test' });
  checkInWeightsMonitor(30);
  await flushMonitoring();
});
