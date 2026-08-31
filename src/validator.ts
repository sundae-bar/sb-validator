/**
 * Main validator client
 */

import 'dotenv/config';
import { createKeyPair, getHotkey } from './signature';
import { ApiClient } from './api-client';
import { TaskProcessor } from './task-processor';
import { sleep } from './retry';
import logger from './logger';
import type { ValidatorConfig, Task } from './types';
import {
  submitSn121Weights,
  resolveUids,
  normalizeToSs58,
  fetchWeightsChainState,
  classifySubmitError,
  BLOCK_TIME_MS,
  DEFAULT_WEIGHTS_RATE_LIMIT_BLOCKS,
  type BittensorWeightTarget,
} from './weights';
import { resolveLeader, type LeaderboardEntry } from './leaderboard';
import { computeBurnWeights, getEmissionsPercent, BURN_UID } from './weight-policy';
import { computeWeightDecisionHash } from './integrity';
import { captureError, captureAlert, checkInWeightsMonitor } from './monitoring';

/**
 * Snapshot of the most recent weight decision, exposed via GET /competition so
 * anyone can see what the validator is currently voting with and verify the
 * decision hash against a replay of the same leaderboard data.
 */
export interface WeightDecisionSnapshot {
  at: string;
  reason: 'interval' | 'event' | 'startup' | 'deferred' | 'watchdog';
  competition: {
    competition_id: string;
    window_start: string;
    window_end: string;
    entries_count: number;
  } | null;
  leader: LeaderboardEntry | null;
  winnerUid: number | null;
  emissionsPercent: number;
  targets: BittensorWeightTarget[] | null;
  decisionHash: string | null;
  submitted: boolean;
  error: string | null;
  /** Set when the cycle intentionally made no chain call. */
  skipped?: 'unchanged' | 'rate-limited' | null;
  /** When a gated or failed submit will be retried by a deferred cycle. */
  nextAttemptAt?: string | null;
}

// Every chain op is deadlined far below this — a cycle running longer has a wedged await.
const WEIGHT_CYCLE_WATCHDOG_MS = 15 * 60_000;
const WATCHDOG_CHECK_INTERVAL_MS = 60_000;

export class Validator {
  private config: ValidatorConfig;
  private apiClient: ApiClient | null = null;
  private taskProcessor: TaskProcessor | null = null;
  private hotkey: string = '';
  private evaluatorId: string | null = null;
  private running: boolean = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private weightsInterval: NodeJS.Timeout | null = null;
  // Serialize weight cycles: only one setWeights in flight at a time; a trigger
  // that arrives mid-cycle is coalesced into exactly one trailing re-run.
  private weightUpdateRunning: boolean = false;
  private weightUpdatePending: boolean = false;
  // The chain accepts one setWeights per hotkey per weightsSetRateLimit blocks
  // (anchored on the last ACCEPTED one) — gate locally with +1 block margin.
  private weightsRateLimitMs: number = (DEFAULT_WEIGHTS_RATE_LIMIT_BLOCKS + 1) * BLOCK_TIME_MS;
  private lastSuccessfulSubmitAtMs: number | null = null;
  private lastSubmittedTargetsKey: string | null = null;
  private weightsCooldownUntilMs: number = 0;
  private deferredWeightTimer: NodeJS.Timeout | null = null;
  // Watchdog state: when the in-flight cycle started, plus an epoch to orphan abandoned cycles.
  private weightCycleStartedAtMs: number | null = null;
  private weightCycleEpoch: number = 0;
  private weightsWatchdogInterval: NodeJS.Timeout | null = null;
  // Observability for GET /competition: what the validator last voted with,
  // when it last landed on-chain, and when the next interval tick fires.
  private lastWeightDecision: WeightDecisionSnapshot | null = null;
  private lastSetAt: string | null = null;
  private nextSetAt: string | null = null;
  private startedAt: string | null = null;
  private lastHeartbeat: { at: string; ok: boolean; error?: string } | null = null;
  private lastPoll: {
    at: string;
    ok: boolean;
    tasksFound?: number;
    error?: string;
  } | null = null;

  constructor(config: ValidatorConfig) {
    this.config = {
      pollInterval: 5,
      heartbeatInterval: 30,
      weightsInterval: 30,
      maxRetries: 3,
      retryDelay: 1000,
      logLevel: 'info',
      ...config,
    };

    // Validate required config
    if (!this.config.mnemonic) {
      throw new Error('Mnemonic is required');
    }
    if (!this.config.apiUrl) {
      throw new Error('API URL is required');
    }
  }

  /**
   * Initialize validator (create key pair, register)
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing validator...');

      // Create key pair from mnemonic
      const pair = await createKeyPair(this.config.mnemonic);
      this.hotkey = getHotkey(pair);
      logger.info({ hotkey: this.hotkey }, 'Key pair created');

      // Create API client
      this.apiClient = new ApiClient(
        pair,
        this.config.apiUrl,
        this.config.maxRetries,
        this.config.retryDelay,
      );

      // Create task processor
      const workDir = process.env.WORK_DIR || '/tmp/validator-work';
      const maxConcurrentTasks = parseInt(process.env.MAX_CONCURRENT_TASKS || '1', 10);
      this.taskProcessor = new TaskProcessor(this.apiClient, workDir, maxConcurrentTasks, pair);

      // When a submission is scored, re-evaluate the leaderboard immediately so
      // a new #1 is reflected on-chain without waiting for the next interval.
      this.taskProcessor.setOnScored(() => {
        void this.runWeightCycle('event');
      });

      // Rebuild rate limit + gate anchor from chain — the in-memory anchor dies on restart.
      try {
        const chainState = await fetchWeightsChainState({ hotkey: this.hotkey });
        this.weightsRateLimitMs = (chainState.rateLimitBlocks + 1) * BLOCK_TIME_MS;
        if (chainState.blocksSinceLastUpdate !== null) {
          this.lastSuccessfulSubmitAtMs =
            Date.now() - chainState.blocksSinceLastUpdate * BLOCK_TIME_MS;
        }
        logger.info(
          {
            blocks: chainState.rateLimitBlocks,
            gateMs: this.weightsRateLimitMs,
            uid: chainState.uid,
            blocksSinceLastUpdate: chainState.blocksSinceLastUpdate,
          },
          'Loaded weightsSetRateLimit from chain',
        );
      } catch (error) {
        logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            fallbackBlocks: DEFAULT_WEIGHTS_RATE_LIMIT_BLOCKS,
          },
          'Could not read weightsSetRateLimit from chain; using fallback',
        );
      }

      // Register evaluator
      const registration = await this.apiClient.register(
        this.config.displayName,
        this.config.version,
        this.config.capacity,
      );

      this.evaluatorId = registration.evaluator_id;
      logger.info(
        {
          evaluatorId: this.evaluatorId,
          hotkey: this.hotkey,
          workDir,
          maxConcurrentTasks,
        },
        'Validator initialized and registered',
      );
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to initialize validator',
      );
      throw error;
    }
  }

  /**
   * Start heartbeat loop
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    const interval = (this.config.heartbeatInterval || 30) * 1000;

    this.heartbeatInterval = setInterval(async () => {
      if (this.apiClient && this.running) {
        try {
          await this.apiClient.heartbeat(this.config.version, this.config.capacity);
          this.lastHeartbeat = { at: new Date().toISOString(), ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.lastHeartbeat = {
            at: new Date().toISOString(),
            ok: false,
            error: message,
          };
          logger.error({ error: message }, 'Heartbeat failed (will retry on next interval)');
        }
      }
    }, interval);

    logger.info({ interval }, 'Heartbeat started');
  }

  /**
   * Stop heartbeat loop
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      logger.info('Heartbeat stopped');
    }
  }

  /**
   * Compute and submit weights for the current competition standings.
   *
   * The weight DECISION is made here, locally and deterministically — the
   * coordinator is only a data source. Each cycle:
   *   1. Pulls the active competition + leaderboard (read-only data).
   *   2. Deterministically selects the current #1 miner by score.
   *   3. Resolves that miner's hotkey → metagraph UID.
   *   4. Builds a {winner: EMISSIONS_PERCENT, UID 0: remainder} weight vector
   *      (burns 100% to UID 0 if there is no eligible winner).
   *   5. Submits it on-chain via setWeights.
   *
   * Stateless: the winner is always recomputed from freshly-pulled data, so
   * "beats the current #1" is handled implicitly and restarts lose nothing.
   *
   * A mutex serializes cycles: if one is running when another is triggered, the
   * trigger is coalesced into a single trailing re-run so two setWeights calls
   * never race.
   */
  private async runWeightCycle(reason: WeightDecisionSnapshot['reason']): Promise<void> {
    if (!this.apiClient || !this.running) {
      return;
    }

    if (this.weightUpdateRunning) {
      this.weightUpdatePending = true;
      logger.debug({ reason }, 'Weight cycle already running; queued a trailing re-run');
      return;
    }

    this.weightUpdateRunning = true;
    const epoch = this.weightCycleEpoch;
    try {
      do {
        this.weightUpdatePending = false;
        // Per-iteration clock: coalesced re-runs each get a fresh watchdog window.
        this.weightCycleStartedAtMs = Date.now();
        const cycleStart = Date.now();
        logger.info({ reason, hotkey: this.hotkey }, 'Starting weight cycle');

        try {
          const comp = await this.apiClient.fetchActiveCompetition();
          if (this.cycleAbandoned(epoch, reason)) {
            break;
          }
          const leader = resolveLeader(comp);
          if (
            comp?.current_leader &&
            leader?.miner_hotkey !== comp.current_leader.miner_hotkey
          ) {
            logger.warn(
              {
                announced: comp.current_leader.miner_hotkey,
                elected: leader?.miner_hotkey ?? null,
              },
              'Coordinator-resolved leader failed verification; using local election',
            );
          }

          let leaderSs58: string | null = null;
          let winnerUid: number | null = null;
          if (leader) {
            leaderSs58 = normalizeToSs58(leader.miner_hotkey);
            const uidMap = await resolveUids([leaderSs58]);
            winnerUid = uidMap.get(leaderSs58) ?? null;
          }

          const emissionsPercent = getEmissionsPercent();
          const targets: BittensorWeightTarget[] = computeBurnWeights(winnerUid, emissionsPercent);
          const decisionHash = computeWeightDecisionHash({
            competition_id: comp?.competition_id ?? null,
            leader_hotkey: leaderSs58,
            leader_score: leader?.best_score ?? null,
            winner_uid: winnerUid,
            emissions_percent: emissionsPercent,
            targets,
          });

          const snapshot: WeightDecisionSnapshot = {
            at: new Date().toISOString(),
            reason,
            competition: comp
              ? {
                  competition_id: comp.competition_id,
                  window_start: comp.window_start,
                  window_end: comp.window_end,
                  entries_count: comp.entries?.length ?? 0,
                }
              : null,
            leader,
            winnerUid,
            emissionsPercent,
            targets,
            decisionHash,
            submitted: false,
            error: null,
          };
          if (this.cycleAbandoned(epoch, reason)) {
            break;
          }
          this.lastWeightDecision = snapshot;

          logger.info(
            {
              reason,
              competitionId: comp?.competition_id ?? null,
              leaderHotkey: leader?.miner_hotkey ?? null,
              leaderScore: leader?.best_score ?? null,
              winnerUid,
              emissionsPercent,
              burnUid: BURN_UID,
              targets,
              decisionHash,
              burningAll: winnerUid === null,
            },
            winnerUid === null
              ? 'No eligible winner — burning 100% to UID 0'
              : 'Computed local weight targets (winner takes emissions share, rest burned)',
          );

          if (process.env.BITTENSOR_WEIGHTS_DISABLED === 'true') {
            logger.info(
              { reason, targets },
              'BITTENSOR_WEIGHTS_DISABLED=true — skipping on-chain setWeights (dry run)',
            );
          } else if (!this.config.mnemonic) {
            logger.warn({ reason }, 'No key configured; skipping on-chain setWeights');
          } else {
            const targetsKey = JSON.stringify(targets);
            const now = Date.now();
            const gateUntil = Math.max(
              this.lastSuccessfulSubmitAtMs === null
                ? 0
                : this.lastSuccessfulSubmitAtMs + this.weightsRateLimitMs,
              this.weightsCooldownUntilMs,
            );

            if (reason === 'event' && targetsKey === this.lastSubmittedTargetsKey) {
              // Already on-chain; only event cycles skip — interval/deferred
              // still submit unchanged targets to keep the tempo heartbeat.
              snapshot.skipped = 'unchanged';
              logger.info(
                { reason, decisionHash },
                'Weights unchanged since last accepted submit — skipping chain call',
              );
            } else if (now < gateUntil) {
              // The chain would reject this inside the rate-limit window —
              // defer one fresh cycle to window-open instead.
              snapshot.skipped = 'rate-limited';
              snapshot.nextAttemptAt = new Date(gateUntil).toISOString();
              this.scheduleDeferredWeightCycle(gateUntil - now);
              logger.info(
                { reason, retryAt: snapshot.nextAttemptAt, targets },
                'Inside setWeights rate-limit window — deferred until it opens',
              );
            } else {
              const submitStart = Date.now();
              try {
                await submitSn121Weights(targets, {
                  validatorSecret: this.config.mnemonic,
                });
                snapshot.submitted = true;
                this.lastSetAt = new Date().toISOString();
                this.lastSuccessfulSubmitAtMs = Date.now();
                this.lastSubmittedTargetsKey = targetsKey;
                if (this.cycleAbandoned(epoch, reason)) {
                  // Keep the on-chain facts above; pacing belongs to the replacement cycle.
                  break;
                }
                this.weightsCooldownUntilMs = 0;
                // A pending deferred retry would just recompute what landed.
                this.clearDeferredWeightTimer();
                logger.info(
                  {
                    reason,
                    submissionTimeMs: Date.now() - submitStart,
                    totalCycleTimeMs: Date.now() - cycleStart,
                    targets,
                  },
                  'Successfully submitted weights on-chain',
                );
                checkInWeightsMonitor(this.config.weightsInterval || 30);
              } catch (submitError) {
                snapshot.error =
                  submitError instanceof Error ? submitError.message : String(submitError);
                const errorKind = classifySubmitError(submitError);
                if (errorKind !== 'other' && epoch === this.weightCycleEpoch) {
                  // "Too soon" means our anchor is stale (e.g. pre-restart
                  // submit) — back off a full window, then retry fresh.
                  this.weightsCooldownUntilMs = Date.now() + this.weightsRateLimitMs;
                  snapshot.nextAttemptAt = new Date(this.weightsCooldownUntilMs).toISOString();
                  this.scheduleDeferredWeightCycle(this.weightsRateLimitMs);
                }
                logger.error(
                  {
                    reason,
                    errorKind,
                    retryAt: snapshot.nextAttemptAt ?? null,
                    error: snapshot.error,
                    errorStack: submitError instanceof Error ? submitError.stack : undefined,
                  },
                  'Failed to submit weights on-chain via setWeights',
                );
                captureError(submitError, { stage: 'set-weights', reason, errorKind });
              }
            }
          }
        } catch (error) {
          // Fetch/resolve failed before a decision could be computed — record
          // the failure so GET /competition shows why there's no fresh vote.
          if (epoch === this.weightCycleEpoch) {
            this.lastWeightDecision = {
              at: new Date().toISOString(),
              reason,
              competition: null,
              leader: null,
              winnerUid: null,
              emissionsPercent: getEmissionsPercent(),
              targets: null,
              decisionHash: null,
              submitted: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          logger.error(
            {
              reason,
              error: error instanceof Error ? error.message : String(error),
              errorStack: error instanceof Error ? error.stack : undefined,
            },
            'Weight cycle failed (will retry on next interval/event)',
          );
          captureError(error, { stage: 'weight-cycle', reason });
        }
      } while (this.weightUpdatePending && this.running && epoch === this.weightCycleEpoch);
    } finally {
      // An abandoned cycle (epoch advanced by the watchdog) must not clobber its replacement.
      if (epoch === this.weightCycleEpoch) {
        this.weightUpdateRunning = false;
        this.weightCycleStartedAtMs = null;
      }
    }
  }

  /** Schedule exactly one deferred cycle at window-open; it recomputes fresh targets. */
  private scheduleDeferredWeightCycle(delayMs: number): void {
    if (this.deferredWeightTimer || !this.running) {
      return;
    }
    const delay = Math.max(delayMs, 1_000);
    this.deferredWeightTimer = setTimeout(() => {
      this.deferredWeightTimer = null;
      void this.runWeightCycle('deferred');
    }, delay);
    this.deferredWeightTimer.unref();
  }

  private clearDeferredWeightTimer(): void {
    if (this.deferredWeightTimer) {
      clearTimeout(this.deferredWeightTimer);
      this.deferredWeightTimer = null;
    }
  }

  /** True when the watchdog abandoned this cycle; the caller must stop without touching shared state. */
  private cycleAbandoned(epoch: number, reason: WeightDecisionSnapshot['reason']): boolean {
    if (epoch === this.weightCycleEpoch) {
      return false;
    }
    logger.info({ reason }, 'Weight cycle was abandoned by the watchdog; stopping this run');
    return true;
  }

  /** Abandon a cycle stuck on an await that will never settle, and run a fresh one. */
  private checkWeightCycleWatchdog(): void {
    if (!this.weightUpdateRunning || this.weightCycleStartedAtMs === null) {
      return;
    }
    const runningForMs = Date.now() - this.weightCycleStartedAtMs;
    if (runningForMs < WEIGHT_CYCLE_WATCHDOG_MS) {
      return;
    }
    logger.error(
      { runningForMs, thresholdMs: WEIGHT_CYCLE_WATCHDOG_MS },
      'Weight cycle exceeded the watchdog threshold — abandoning it and starting fresh',
    );
    captureAlert('Weight cycle exceeded the watchdog threshold; abandoned and restarted', {
      stage: 'weight-cycle-watchdog',
      runningForMs: String(runningForMs),
    });
    this.weightCycleEpoch += 1;
    this.weightUpdateRunning = false;
    this.weightUpdatePending = false;
    this.weightCycleStartedAtMs = null;
    void this.runWeightCycle('watchdog');
  }

  /**
   * Start the periodic weight loop. The interval keeps on-chain weights fresh;
   * scoring events trigger extra cycles in between via runWeightCycle('event').
   */
  private startWeights(): void {
    if (this.weightsInterval) {
      clearInterval(this.weightsInterval);
    }

    const intervalMinutes = this.config.weightsInterval || 30;
    const interval = intervalMinutes * 60 * 1000; // minutes → ms

    // Kick one cycle shortly after start so weights aren't stale until the
    // first interval elapses.
    void this.runWeightCycle('startup');

    this.nextSetAt = new Date(Date.now() + interval).toISOString();
    this.weightsInterval = setInterval(() => {
      // Event cycles don't shift the schedule — the next interval tick is
      // always one interval after the previous tick.
      this.nextSetAt = new Date(Date.now() + interval).toISOString();
      void this.runWeightCycle('interval');
    }, interval);

    if (this.weightsWatchdogInterval) {
      clearInterval(this.weightsWatchdogInterval);
    }
    this.weightsWatchdogInterval = setInterval(
      () => this.checkWeightCycleWatchdog(),
      WATCHDOG_CHECK_INTERVAL_MS,
    );

    logger.info({ intervalMinutes }, 'Weight loop started (local decision)');
  }

  /**
   * Stop weights loop
   */
  private stopWeights(): void {
    this.clearDeferredWeightTimer();
    if (this.weightsWatchdogInterval) {
      clearInterval(this.weightsWatchdogInterval);
      this.weightsWatchdogInterval = null;
    }
    if (this.weightsInterval) {
      clearInterval(this.weightsInterval);
      this.weightsInterval = null;
      this.nextSetAt = null;
      logger.info('Weight loop stopped');
    }
  }

  /**
   * Current weight-vote state for GET /competition: what the validator last
   * decided (targets + decision hash), when weights last landed on-chain, and
   * when the next interval tick fires.
   */
  getWeightsStatus(): {
    enabled: boolean;
    intervalMinutes: number;
    emissionsPercent: number;
    lastDecision: WeightDecisionSnapshot | null;
    lastSetAt: string | null;
    nextSetAt: string | null;
    cycleStartedAt: string | null;
  } {
    return {
      enabled: process.env.BITTENSOR_WEIGHTS_DISABLED !== 'true',
      intervalMinutes: this.config.weightsInterval || 30,
      emissionsPercent: getEmissionsPercent(),
      lastDecision: this.lastWeightDecision,
      lastSetAt: this.lastSetAt,
      nextSetAt: this.nextSetAt,
      cycleStartedAt: this.weightCycleStartedAtMs
        ? new Date(this.weightCycleStartedAtMs).toISOString()
        : null,
    };
  }

  /**
   * Process a single task
   */
  private async processTask(task: Task): Promise<void> {
    if (!this.taskProcessor) {
      throw new Error('Task processor not initialized');
    }

    logger.info(
      {
        taskId: task.id,
        briefId: task.brief_id,
        status: task.status,
      },
      'Processing task',
    );

    // Process task (handles claiming, file prep, evaluation, result submission)
    // This is idempotent - safe to process multiple times
    await this.taskProcessor.processTask(task);
  }

  /**
   * Main polling loop - runs continuously until stopped
   */
  private async pollLoop(): Promise<void> {
    const pollInterval = (this.config.pollInterval || 5) * 1000;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 10; // After 10 consecutive errors, log warning but keep going

    logger.info(
      { pollInterval, apiUrl: this.config.apiUrl },
      'Starting task polling loop (will run continuously)',
    );

    // Main loop - runs until this.running is set to false
    while (this.running) {
      try {
        if (!this.apiClient) {
          throw new Error('API client not initialized');
        }

        // Poll for tasks
        const response = await this.apiClient.pollTasks('queued', 10);
        this.lastPoll = {
          at: new Date().toISOString(),
          ok: true,
          tasksFound: response.tasks?.length || 0,
        };

        // Reset error counter on success
        consecutiveErrors = 0;

        if (response.tasks && response.tasks.length > 0) {
          logger.info(
            {
              count: response.tasks.length,
              taskIds: response.tasks.map((t) => t.id),
              hotkey: this.hotkey,
            },
            'Found tasks, processing...',
          );

          // Process each task
          for (const task of response.tasks) {
            if (!this.running) {
              logger.info('Validator stopped, exiting task processing');
              break;
            }

            try {
              await this.processTask(task);
            } catch (error) {
              logger.error(
                {
                  taskId: task.id,
                  error: error instanceof Error ? error.message : String(error),
                },
                'Error processing task (continuing with next task)',
              );
              // Continue with next task - don't break the loop
            }
          }
        } else {
          logger.debug('No tasks available, will poll again...');
        }

        // Wait before next poll (only if still running)
        if (this.running) {
          await sleep(pollInterval);
        }
      } catch (error) {
        consecutiveErrors++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.lastPoll = {
          at: new Date().toISOString(),
          ok: false,
          error: errorMessage,
        };

        if (consecutiveErrors >= maxConsecutiveErrors) {
          logger.error(
            {
              consecutiveErrors,
              error: errorMessage,
              maxConsecutiveErrors,
            },
            `Multiple consecutive errors (${consecutiveErrors}), but continuing to poll...`,
          );
          captureError(error, { stage: 'task-poll', consecutiveErrors: String(consecutiveErrors) });
          // Reset counter to avoid log spam, but keep going
          consecutiveErrors = 0;
        } else {
          logger.warn(
            { consecutiveErrors, error: errorMessage },
            'Error in polling loop (will retry)',
          );
        }

        // Wait before retrying (only if still running)
        if (this.running) {
          await sleep(pollInterval);
        }
      }
    }

    logger.info('Polling loop stopped (this.running = false)');
  }

  /**
   * Start validator - runs continuously until stop() is called
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Validator is already running');
      return;
    }

    try {
      // Initialize if not already done
      if (!this.apiClient) {
        await this.initialize();
      }

      this.running = true;
      this.startedAt = new Date().toISOString();
      logger.info('Validator started and running continuously');

      // Start heartbeat
      this.startHeartbeat();

      // Start weights fetch loop
      this.startWeights();

      // Start polling loop - this will run indefinitely until this.running = false
      // The loop handles all errors internally and keeps running
      await this.pollLoop();
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Fatal error in validator (stopping)',
      );
      this.running = false;
      throw error;
    }
  }

  /**
   * Stop validator
   */
  async stop(): Promise<void> {
    logger.info('Stopping validator...');
    this.running = false;
    this.stopHeartbeat();
    this.stopWeights();
    logger.info('Validator stopped');
  }

  /**
   * Get validator status
   */
  getStatus(): {
    running: boolean;
    hotkey: string;
    evaluatorId: string | null;
    apiUrl: string;
    startedAt: string | null;
    lastHeartbeat: { at: string; ok: boolean; error?: string } | null;
    lastPoll: {
      at: string;
      ok: boolean;
      tasksFound?: number;
      error?: string;
    } | null;
    taskProcessor?: {
      processing: number;
      maxConcurrent: number;
      tasks: string[];
    };
  } {
    return {
      running: this.running,
      hotkey: this.hotkey,
      evaluatorId: this.evaluatorId,
      apiUrl: this.config.apiUrl,
      startedAt: this.startedAt,
      lastHeartbeat: this.lastHeartbeat,
      lastPoll: this.lastPoll,
      taskProcessor: this.taskProcessor?.getStatus(),
    };
  }
}
