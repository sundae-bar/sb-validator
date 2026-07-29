import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError } from 'axios';
import { classifyFailureReason } from '../src/failure-reason';
import { SbevalsError } from '../src/sbevals-client';
import { buildResultPayload } from '../src/api-client';
import type { TaskFailureReason } from '../src/types';

test('SbevalsError carries reason and message', () => {
  const err = new SbevalsError('sb-evals job j1 failed: boom', 'evaluator_error');
  assert.equal(err.message, 'sb-evals job j1 failed: boom');
  assert.equal(err.failureReason, 'evaluator_error');
  assert.equal(err.name, 'SbevalsError');
  assert.ok(err instanceof Error);
});

test('classifyFailureReason maps SbevalsError reasons through', () => {
  const reasons: TaskFailureReason[] = [
    'evaluator_unreachable',
    'evaluator_timeout',
    'evaluator_error',
  ];
  for (const reason of reasons) {
    assert.equal(classifyFailureReason(new SbevalsError('msg', reason)), reason);
  }
});

test('classifyFailureReason maps axios errors to coordinator_error', () => {
  const err = new AxiosError('Request failed with status code 409', 'ERR_BAD_REQUEST');
  assert.equal(classifyFailureReason(err), 'coordinator_error');
});

test('classifyFailureReason defaults to internal_error', () => {
  assert.equal(classifyFailureReason(new Error('plain')), 'internal_error');
  assert.equal(classifyFailureReason('string error'), 'internal_error');
  assert.equal(classifyFailureReason(undefined), 'internal_error');
});

test('buildResultPayload includes failure_reason only for failed status', () => {
  const failed = buildResultPayload('5Fabc', 'failed', {}, 'boom', 'evaluator_timeout');
  assert.deepEqual(failed, {
    hotkey: '5Fabc',
    status: 'failed',
    result_data: {},
    error_message: 'boom',
    failure_reason: 'evaluator_timeout',
  });

  const completed = buildResultPayload(
    '5Fabc',
    'completed',
    { score: 1 },
    undefined,
    'internal_error',
  );
  assert.deepEqual(completed, {
    hotkey: '5Fabc',
    status: 'completed',
    result_data: { score: 1 },
  });
});

test('buildResultPayload omits failure_reason when not provided', () => {
  const failed = buildResultPayload('5Fabc', 'failed', {}, 'boom');
  assert.deepEqual(failed, {
    hotkey: '5Fabc',
    status: 'failed',
    result_data: {},
    error_message: 'boom',
  });
});
