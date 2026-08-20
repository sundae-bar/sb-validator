import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError, type AxiosResponse } from 'axios';
import { classifyPollFailure } from '../src/sbevals-client';

const axios404 = () =>
  new AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 404,
  } as AxiosResponse);

const axios500 = () =>
  new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status: 500,
  } as AxiosResponse);

test('classifyPollFailure fails a 404 immediately as job_lost', () => {
  assert.equal(classifyPollFailure(axios404(), 1, 12), 'job_lost');
  // Even when the failure budget is otherwise exhausted, 404 stays job_lost
  assert.equal(classifyPollFailure(axios404(), 12, 12), 'job_lost');
});

test('classifyPollFailure retries transient errors under the cap', () => {
  assert.equal(classifyPollFailure(new Error('socket hang up'), 1, 12), 'retry');
  assert.equal(classifyPollFailure(axios500(), 11, 12), 'retry');
  const noResponse = new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED');
  assert.equal(classifyPollFailure(noResponse, 5, 12), 'retry');
});

test('classifyPollFailure gives up once consecutive failures reach the cap', () => {
  assert.equal(classifyPollFailure(axios500(), 12, 12), 'give_up');
  assert.equal(classifyPollFailure(new Error('timeout'), 13, 12), 'give_up');
});
