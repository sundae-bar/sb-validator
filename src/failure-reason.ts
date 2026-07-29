/**
 * Maps thrown errors to the machine-readable failure cause reported with failed results.
 */

import axios from 'axios';
import { SbevalsError } from './sbevals-client';
import type { TaskFailureReason } from './types';

export function classifyFailureReason(error: unknown): TaskFailureReason {
  if (error instanceof SbevalsError) return error.failureReason;
  if (axios.isAxiosError(error)) return 'coordinator_error';
  return 'internal_error';
}
