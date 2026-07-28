/**
 * Task processor - handles task execution with idempotency
 *
 * Features:
 * - Claims tasks before processing (prevents duplicate processing)
 * - In-memory tracking to avoid processing same task twice
 * - Idempotent (safe to process multiple times)
 * - Routes skill tasks to the sbevals service and submits results
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import logger from './logger';
import { ApiClient } from './api-client';
import type { Task } from './types';
import type { KeyringPair } from '@polkadot/keyring/types';
import { submitSkillTask, pollSkillResult } from './sbevals-client';
import { getHotkey } from './signature';
import { normalizeToSs58 } from './weights';
import { computeIntegrityHash } from './integrity';

interface ProcessingTask {
  taskId: string;
  startedAt: Date;
}

/**
 * Emitted after the validator scores a submission. The weights loop listens for
 * this to re-evaluate the leaderboard immediately (rather than only on its
 * periodic interval) so a new #1 is reflected on-chain promptly.
 */
export interface ScoredEvent {
  taskId: string;
  competitionId: string | null;
  minerHotkey: string | null;
  score: number | null;
}

export class TaskProcessor {
  private apiClient: ApiClient;
  private pair: KeyringPair | null = null;
  private workDir: string;
  private processingTasks: Map<string, ProcessingTask> = new Map(); // In-memory tracking
  private maxConcurrentTasks: number;
  private onScored: ((event: ScoredEvent) => void) | null = null;
  constructor(
    apiClient: ApiClient,
    workDir: string = '/tmp/validator-work',
    maxConcurrentTasks: number = 1,
    pair?: KeyringPair,
  ) {
    this.apiClient = apiClient;
    this.pair = pair ?? null;
    this.workDir = workDir;
    this.maxConcurrentTasks = maxConcurrentTasks;
  }

  /**
   * Register a listener fired after each submission is scored. Used by the
   * validator to trigger an immediate weight re-evaluation.
   */
  setOnScored(cb: (event: ScoredEvent) => void): void {
    this.onScored = cb;
  }

  /**
   * Check if task is already being processed (in-memory check)
   */
  private isProcessing(taskId: string): boolean {
    return this.processingTasks.has(taskId);
  }

  /**
   * Mark task as processing (in-memory)
   */
  private markProcessing(taskId: string): void {
    this.processingTasks.set(taskId, {
      taskId,
      startedAt: new Date(),
    });
  }

  /**
   * Unmark task (in-memory)
   */
  private unmarkProcessing(taskId: string): void {
    this.processingTasks.delete(taskId);
  }

  /**
   * Check if we can process more tasks (concurrency limit)
   */
  private canProcessMore(): boolean {
    return this.processingTasks.size < this.maxConcurrentTasks;
  }

  /**
   * Process a task (idempotent - safe to call multiple times)
   */
  async processTask(task: Task): Promise<void> {
    const taskId = task.id;
    const taskPayload = task.task_payload;

    // In-memory check: skip if already processing
    if (this.isProcessing(taskId)) {
      logger.info({ taskId }, 'Task already being processed (in-memory), skipping');
      return;
    }

    // Concurrency check
    if (!this.canProcessMore()) {
      logger.info(
        {
          taskId,
          current: this.processingTasks.size,
          max: this.maxConcurrentTasks,
        },
        'Max concurrent tasks reached, skipping',
      );
      return;
    }

    // Mark as processing (in-memory)
    this.markProcessing(taskId);
    logger.debug({ taskId }, 'Marked task as processing (in-memory)');

    try {
      // Step 1: Claim task (idempotent - if already claimed, will fail gracefully)
      try {
        await this.apiClient.claimTask(taskId);
        logger.info({ taskId }, 'Task claimed successfully');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // If task is already claimed/processing, that's okay (idempotent)
        if (errorMessage.includes('already claimed') || errorMessage.includes('not available')) {
          logger.info({ taskId }, 'Task already claimed by another process, skipping');
          return;
        }

        // Other errors should be thrown
        throw error;
      }

      // Step 2: The validator is skill-only. Anything without a skill file is a
      // stale task from the removed agent (.af) track — resolve it terminally
      // instead of leaving it queued forever.
      if (!taskPayload.skill_file_path) {
        const message =
          'Task has no skill_file_path — the agent (.af) evaluation path has been removed; this validator only evaluates skill tasks';
        logger.warn({ taskId }, message);
        await this.apiClient.submitResults(taskId, 'failed', {}, message);
        return;
      }

      if (!this.pair) {
        const message = 'Validator keypair unavailable — cannot sign sbevals requests';
        logger.error({ taskId }, message);
        await this.apiClient.submitResults(taskId, 'failed', {}, message);
        return;
      }

      await this.processSkillTask(taskId, this.pair, taskPayload);
    } catch (error) {
      logger.error(
        {
          taskId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Error processing task',
      );

      // Try to submit error result (idempotent)
      try {
        await this.apiClient.submitResults(
          taskId,
          'failed',
          {},
          error instanceof Error ? error.message : String(error),
        );
      } catch (submitError) {
        logger.error(
          {
            taskId,
            error: submitError instanceof Error ? submitError.message : String(submitError),
          },
          'Failed to submit error result',
        );
      }

      throw error;
    } finally {
      // Cleanup: remove temp files (can be disabled via KEEP_TASK_FILES=1 for debugging)
      const keepTaskFiles = process.env.KEEP_TASK_FILES === '1';
      if (!keepTaskFiles) {
        try {
          const taskWorkDir = path.join(this.workDir, taskId);
          await this.cleanup(taskWorkDir);
        } catch (cleanupError) {
          logger.warn(
            {
              taskId,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            },
            'Failed to cleanup task files',
          );
        }
      } else {
        logger.info(
          { taskId, workDir: path.join(this.workDir, taskId) },
          'KEEP_TASK_FILES=1 set, skipping cleanup of task workDir',
        );
      }

      // Unmark processing (in-memory)
      this.unmarkProcessing(taskId);
    }
  }

  /**
   * Route a skill task to sb-evals, poll for result, and submit to the coordinator.
   */
  private async processSkillTask(
    taskId: string,
    pair: KeyringPair,
    taskPayload: Task['task_payload'],
  ): Promise<void> {
    const roundScore = (value: number) => Math.round(value * 100_000) / 100_000;

    // LETTA_EMBEDDING_WAIT_MINUTES is honored as a legacy alias so existing
    // operator .env files keep their configured timeout.
    const timeoutMs =
      Number(
        process.env.SBEVALS_RESULT_TIMEOUT_MINUTES ||
          process.env.LETTA_EMBEDDING_WAIT_MINUTES ||
          '30',
      ) *
      60 *
      1000;

    let jobId: string;
    try {
      jobId = await submitSkillTask(pair, taskId, taskPayload as Record<string, unknown>);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ taskId, error: msg }, 'Failed to submit skill task to sb-evals');
      await this.apiClient.submitResults(taskId, 'failed', {}, msg);
      return;
    }

    let evaluationResult: any;
    try {
      evaluationResult = await pollSkillResult(pair, jobId, timeoutMs);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ taskId, jobId, error: msg }, 'sb-evals polling failed');
      await this.apiClient.submitResults(taskId, 'failed', {}, msg);
      return;
    }

    // Persist the full evaluation output so the coordinator's
    // /download/task/:id/test-output endpoint has something to serve.
    // Non-fatal — scoring still succeeds without it.
    try {
      const tmpDir = path.join(this.workDir, taskId);
      await fs.mkdir(tmpDir, { recursive: true });
      const rawOutputPath = path.join(tmpDir, 'raw_evaluation.json');
      await fs.writeFile(rawOutputPath, JSON.stringify(evaluationResult, null, 2));
      await this.apiClient.uploadRawOutputFile(taskId, rawOutputPath);
    } catch (rawError) {
      logger.warn(
        {
          taskId,
          jobId,
          error: rawError instanceof Error ? rawError.message : String(rawError),
        },
        'Failed to upload sb-evals raw output (non-fatal)',
      );
    }

    const compactResults = Array.isArray(evaluationResult?.results)
      ? evaluationResult.results
          .map((result: unknown) => {
            if (typeof result !== 'object' || result === null) return null;
            const resultObj = result as Record<string, any>;
            const resultData = resultObj.result as Record<string, any> | undefined;
            if (!resultData) return null;
            const grade = resultData.grade as { score?: number; rationale?: string } | undefined;
            const performance = resultData.performance as { total_tokens?: number } | undefined;
            const id = resultObj.id ?? resultObj.sample_id ?? resultObj.task_id;
            const perSampleScore =
              typeof resultData.weighted_score === 'number'
                ? resultData.weighted_score
                : typeof grade?.score === 'number'
                  ? grade.score
                  : null;
            // Per-grader breakdown so the FE can render each grader's score +
            // rationale instead of the flattened single-line aggregate string.
            const rawGrades = resultData.grades_by_key as Record<string, unknown> | undefined;
            const gradesByKey =
              rawGrades && typeof rawGrades === 'object'
                ? Object.fromEntries(
                    Object.entries(rawGrades).flatMap(([key, g]) => {
                      if (typeof g !== 'object' || g === null) return [];
                      const gg = g as { score?: unknown; rationale?: unknown };
                      return [
                        [
                          key,
                          {
                            score: typeof gg.score === 'number' ? gg.score : null,
                            rationale: typeof gg.rationale === 'string' ? gg.rationale : null,
                          },
                        ],
                      ];
                    }),
                  )
                : null;
            return {
              id,
              score: perSampleScore,
              rationale: grade?.rationale ?? null,
              grades_by_key: gradesByKey,
              tokens:
                typeof performance?.total_tokens === 'number' ? performance.total_tokens : null,
              input: null,
              domain: null,
              skill: null,
              difficulty: null,
              capability_cluster: null,
            };
          })
          .filter((r: any) => r !== null)
      : [];

    const totalTokens = compactResults.reduce(
      (sum: number, r: any) => sum + (typeof r.tokens === 'number' ? r.tokens : 0),
      0,
    );

    const scoresWithValues = compactResults
      .map((r: any) => r.score)
      .filter((s: any): s is number => typeof s === 'number');
    const calculatedTotalScore =
      scoresWithValues.length > 0
        ? roundScore(
            scoresWithValues.reduce((a: number, s: number) => a + s, 0) / scoresWithValues.length,
          )
        : null;

    // Honor the eval-service's verdict. The validator is what signs on-chain
    // weights, so it treats the summary verdict as authoritative — if the
    // upstream verdict is failure, normalize the submitted score to 0.
    const evalMetrics = (
      evaluationResult?.summary as { metrics?: Record<string, unknown> } | undefined
    )?.metrics;
    const verdictPassed = evalMetrics?.overall_gate_passed;
    const verdictFailed = verdictPassed === 0 || verdictPassed === false;
    const finalScore = verdictFailed ? 0 : calculatedTotalScore;
    if (verdictFailed && calculatedTotalScore !== 0 && calculatedTotalScore !== null) {
      logger.warn(
        { taskId, calculatedTotalScore, overall_gate_passed: verdictPassed },
        'eval-service reported verdict failure but per-sample average was non-zero — normalizing submitted score to 0',
      );
    }

    const timestamp = new Date().toISOString();

    // Miner identity + competition come from the task metadata set by the
    // coordinator. When present, attach an integrity hash + the hashed scoring
    // fields so the web app can recompute and verify the result against what
    // the validator actually scored (see integrity.ts). Missing metadata is
    // non-fatal — the task still completes, just without attribution/hash.
    const metadata = (taskPayload.metadata ?? {}) as Record<string, unknown>;
    const competitionId =
      typeof metadata.competition_id === 'string' ? metadata.competition_id : null;
    const rawMinerHotkey = typeof metadata.miner_hotkey === 'string' ? metadata.miner_hotkey : null;

    let minerHotkeySs58: string | null = null;
    let integrity: {
      integrity_hash: string;
      scoring: Record<string, unknown>;
    } | null = null;

    if (competitionId && rawMinerHotkey && this.pair) {
      try {
        minerHotkeySs58 = normalizeToSs58(rawMinerHotkey);
        const validatorHotkeySs58 = normalizeToSs58(getHotkey(this.pair));
        const verdict: 'passed' | 'failed' = verdictFailed ? 'failed' : 'passed';
        const scoringInput = {
          taskId,
          competition_id: competitionId,
          miner_hotkey: minerHotkeySs58,
          validator_hotkey: validatorHotkeySs58,
          score: finalScore ?? 0,
          verdict,
          timestamp,
        };
        integrity = {
          integrity_hash: computeIntegrityHash(scoringInput),
          scoring: scoringInput,
        };
      } catch (error) {
        logger.warn(
          {
            taskId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to compute integrity hash (submitting result without it)',
        );
      }
    } else {
      logger.warn(
        {
          taskId,
          hasCompetitionId: !!competitionId,
          hasMinerHotkey: !!rawMinerHotkey,
        },
        'Task metadata missing competition_id/miner_hotkey — result will lack integrity hash + weight attribution',
      );
    }

    const compactPayload = {
      results: compactResults,
      score: finalScore,
      tests_count: compactResults.length,
      duration_seconds: evaluationResult?.duration_seconds ?? null,
      total_tokens: totalTokens,
      timestamp,
      ...(integrity ?? {}),
    };

    logger.info(
      {
        taskId,
        score: finalScore,
        testsCount: compactResults.length,
        totalTokens,
      },
      'Submitting sb-evals skill results',
    );
    await this.apiClient.submitResults(taskId, 'completed', compactPayload);
    logger.info({ taskId }, 'Skill task processed successfully via sb-evals');

    // Fire-and-forget: notify the weights loop so it can re-evaluate the
    // leaderboard immediately. Never let a weight-update failure fail the task.
    if (this.onScored) {
      try {
        this.onScored({
          taskId,
          competitionId,
          minerHotkey: minerHotkeySs58,
          score: finalScore,
        });
      } catch (error) {
        logger.warn(
          {
            taskId,
            error: error instanceof Error ? error.message : String(error),
          },
          'onScored listener threw (ignored)',
        );
      }
    }
  }

  /**
   * Cleanup task files
   */
  private async cleanup(workDir: string): Promise<void> {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
      logger.debug({ workDir }, 'Cleaned up task files');
    } catch (error) {
      logger.warn({ workDir, error }, 'Failed to cleanup task files');
    }
  }

  /**
   * Get processing status
   */
  getStatus(): {
    processing: number;
    maxConcurrent: number;
    tasks: string[];
  } {
    return {
      processing: this.processingTasks.size,
      maxConcurrent: this.maxConcurrentTasks,
      tasks: Array.from(this.processingTasks.keys()),
    };
  }
}
