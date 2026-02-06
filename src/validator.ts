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

export class Validator {
  private config: ValidatorConfig;
  private apiClient: ApiClient | null = null;
  private taskProcessor: TaskProcessor | null = null;
  private hotkey: string = '';
  private evaluatorId: string | null = null;
  private running: boolean = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private weightsInterval: NodeJS.Timeout | null = null;

  constructor(config: ValidatorConfig) {
    this.config = {
      pollInterval: 5,
      heartbeatInterval: 30,
      weightsInterval: 30,
      maxRetries: 3,
      retryDelay: 1000,
      logLevel: 'info',
      ...config
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
        this.config.retryDelay
      );

      // Create task processor
      const workDir = process.env.WORK_DIR || '/tmp/validator-work';
      const maxConcurrentTasks = parseInt(process.env.MAX_CONCURRENT_TASKS || '1', 10);
      this.taskProcessor = new TaskProcessor(
        this.apiClient,
        workDir,
        maxConcurrentTasks
      );

      // Register evaluator
      const registration = await this.apiClient.register(
        this.config.displayName,
        this.config.version,
        this.config.capacity
      );

      this.evaluatorId = registration.evaluator_id;
      logger.info(
        { evaluatorId: this.evaluatorId, hotkey: this.hotkey, workDir, maxConcurrentTasks },
        'Validator initialized and registered'
      );
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to initialize validator'
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
        } catch (error) {
          logger.error(
            { error: error instanceof Error ? error.message : String(error) },
            'Heartbeat failed (will retry on next interval)'
          );
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
   * Start weights fetch loop
   */
  private startWeights(): void {
    if (this.weightsInterval) {
      clearInterval(this.weightsInterval);
    }

    const interval = (this.config.weightsInterval || 30) * 60 * 1000; // Convert minutes to milliseconds

    this.weightsInterval = setInterval(async () => {
      if (this.apiClient && this.running) {
        try {
          const weights = await this.apiClient.fetchBittensorWeights();
          logger.info(
            {
              window_start: weights.window_start,
              window_end: weights.window_end,
              total_minutes: weights.total_minutes,
              weights_count: weights.weights.length,
              weights: weights.weights.map(w => ({ uid: w.uid, weight: w.weight })),
            },
            'Fetched bittensor weights (logging only, not setting weights yet)'
          );
        } catch (error) {
          logger.error(
            { error: error instanceof Error ? error.message : String(error) },
            'Failed to fetch bittensor weights (will retry on next interval)'
          );
        }
      }
    }, interval);

    logger.info({ intervalMinutes: this.config.weightsInterval || 30 }, 'Weights fetch started');
  }

  /**
   * Stop weights fetch loop
   */
  private stopWeights(): void {
    if (this.weightsInterval) {
      clearInterval(this.weightsInterval);
      this.weightsInterval = null;
      logger.info('Weights fetch stopped');
    }
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
        status: task.status
      },
      'Processing task'
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
      'Starting task polling loop (will run continuously)'
    );

    // Main loop - runs until this.running is set to false
    while (this.running) {
      try {
        if (!this.apiClient) {
          throw new Error('API client not initialized');
        }

        // Poll for tasks
        const response = await this.apiClient.pollTasks('queued', 10);

        // Reset error counter on success
        consecutiveErrors = 0;

        if (response.tasks && response.tasks.length > 0) {
          logger.info(
            { count: response.tasks.length },
            'Found tasks, processing...'
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
                  error: error instanceof Error ? error.message : String(error)
                },
                'Error processing task (continuing with next task)'
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

        if (consecutiveErrors >= maxConsecutiveErrors) {
          logger.error(
            {
              consecutiveErrors,
              error: errorMessage,
              maxConsecutiveErrors
            },
            `Multiple consecutive errors (${consecutiveErrors}), but continuing to poll...`
          );
          // Reset counter to avoid log spam, but keep going
          consecutiveErrors = 0;
        } else {
          logger.warn(
            { consecutiveErrors, error: errorMessage },
            'Error in polling loop (will retry)'
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
        'Fatal error in validator (stopping)'
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
      taskProcessor: this.taskProcessor?.getStatus()
    };
  }
}

