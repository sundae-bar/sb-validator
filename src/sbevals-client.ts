/**
 * Client for the sb-evals skill evaluation service.
 * Handles POST to submit a skill task and GET polling for results.
 */

import axios from 'axios';
import type { KeyringPair } from '@polkadot/keyring/types';
import { getHotkey } from './signature';
import logger from './logger';

const SBEVALS_URL = (process.env.SBEVALS_URL || 'https://sbevals-production.up.railway.app').replace(/\/$/, '');
const SBEVALS_API_KEY = process.env.SBEVALS_API_KEY || '';
const POLL_INTERVAL_MS = Number(process.env.SBEVALS_POLL_INTERVAL_SECONDS || '5') * 1000;

/**
 * Submit a skill task to sb-evals via POST /evaluations.
 * Passes task_payload directly — no DB lookup required by sb-evals.
 * Returns the jobId.
 */
export async function submitSkillTask(
  pair: KeyringPair,
  taskId: string,
  taskPayload: Record<string, unknown>
): Promise<string> {
  logger.info({ taskId, url: `${SBEVALS_URL}/evaluations` }, 'Submitting skill task to sb-evals');

  const response = await axios.post(`${SBEVALS_URL}/evaluations`, {
    task_payload: taskPayload,
  }, {
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': SBEVALS_API_KEY,
    },
    timeout: 30000,
  });

  const jobId = response.data?.jobId;
  if (!jobId) throw new Error(`sb-evals POST /evaluations returned no jobId: ${JSON.stringify(response.data)}`);

  logger.info({ taskId, jobId }, 'sb-evals job created');
  return jobId;
}

/**
 * Poll sb-evals until the job completes or times out. Returns the result object.
 */
export async function pollSkillResult(pair: KeyringPair, jobId: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;

  logger.info({ jobId, timeoutMs, pollIntervalMs: POLL_INTERVAL_MS }, 'Polling sb-evals for skill result');

  while (Date.now() < deadline) {
    const response = await axios.get(`${SBEVALS_URL}/evaluations/${jobId}`, {
      headers: {
        'X-Api-Key': SBEVALS_API_KEY,
      },
      timeout: 30000,
    });

    const { status, result, progress } = response.data;
    logger.debug({ jobId, status, progress }, 'sb-evals poll response');

    if (status === 'completed') {
      logger.info({ jobId }, 'sb-evals job completed');
      return result;
    }
    if (status === 'failed') {
      const errorMsg = response.data.error || response.data.message || 'unknown error';
      throw new Error(`sb-evals job ${jobId} failed: ${errorMsg}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`sb-evals polling timed out after ${timeoutMs}ms for job ${jobId}`);
}
