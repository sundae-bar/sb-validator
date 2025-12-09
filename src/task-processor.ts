/**
 * Task processor - handles task execution with idempotency
 * 
 * Features:
 * - Claims tasks before processing (prevents duplicate processing)
 * - In-memory tracking to avoid processing same task twice
 * - Idempotent (safe to process multiple times)
 * - File handling (base64 decode, temp files)
 * - Runs letta-evals
 * - Submits results
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { setTimeout as setTimeoutPromise } from 'timers/promises';
import * as yaml from 'js-yaml';
import logger from './logger';
import { ApiClient } from './api-client';
import type { Task } from './types';

const execAsync = promisify(exec);

interface ProcessingTask {
  taskId: string;
  startedAt: Date;
}

export class TaskProcessor {
  private apiClient: ApiClient;
  private workDir: string;
  private processingTasks: Map<string, ProcessingTask> = new Map(); // In-memory tracking
  private maxConcurrentTasks: number;
  constructor(
    apiClient: ApiClient,
    workDir: string = '/tmp/validator-work',
    maxConcurrentTasks: number = 1
  ) {
    this.apiClient = apiClient;
    this.workDir = workDir;
    this.maxConcurrentTasks = maxConcurrentTasks;
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
      startedAt: new Date()
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
        { taskId, current: this.processingTasks.size, max: this.maxConcurrentTasks },
        'Max concurrent tasks reached, skipping'
      );
      return;
    }

    // Mark as processing (in-memory)
    this.markProcessing(taskId);
    logger.debug({ taskId }, 'Marked task as processing (in-memory)');

    try {
      // Step 1: Claim task (idempotent - if already claimed, will fail gracefully)
      let claimed = false;
      try {
        await this.apiClient.claimTask(taskId);
        claimed = true;
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

      // Step 2: Prepare files (decode base64, write to temp directory)
      // Each task gets its own isolated directory to prevent file overwrites
      // Format: /tmp/validator-work/{taskId}/
      const taskWorkDir = path.join(this.workDir, taskId);
      await fs.mkdir(taskWorkDir, { recursive: true });

      logger.info({ taskId, workDir: taskWorkDir }, 'Preparing task files');

      let files: {
        suitePath: string;
        agentFilePath?: string;
        datasetPath?: string;
        rubricPath?: string;
      };

      try {
        files = await this.prepareFiles(taskPayload, taskWorkDir);
      } catch (error) {
        logger.error(
          { taskId, error: error instanceof Error ? error.message : String(error) },
          'Failed to prepare task files'
        );
        throw error;
      }

      // Step 3: Run letta-evals
      logger.info({ taskId, suitePath: files.suitePath }, 'Running letta-evals');

      const evaluationResult = await this.runEvaluation(files.suitePath, taskWorkDir);

      // Step 4: Extract score from summary
      let score: number | undefined = undefined;
      if (evaluationResult.summary && typeof evaluationResult.summary === 'object') {
        const summary = evaluationResult.summary as Record<string, unknown>;
        // Try to get score from summary.metrics.avg_score_total (preferred)
        if (summary.metrics && typeof summary.metrics === 'object') {
          const metrics = summary.metrics as Record<string, unknown>;
          if (typeof metrics.avg_score_total === 'number') {
            score = metrics.avg_score_total;
          }
        }
        // Fallback: try summary.avg_score_total directly
        if (score === undefined && typeof summary.avg_score_total === 'number') {
          score = summary.avg_score_total;
        }
      }

      // Step 5: Submit results (idempotent - can submit multiple times)
      logger.info({ taskId, score }, 'Submitting evaluation results');

      await this.apiClient.submitResults(taskId, 'completed', {
        summary: evaluationResult.summary,
        results: evaluationResult.results,
        artifacts: evaluationResult.artifacts,
        duration_seconds: evaluationResult.duration_seconds,
        timestamp: new Date().toISOString(),
        score // Include extracted score
      });

      logger.info({ taskId }, 'Task processed successfully');

    } catch (error) {
      logger.error(
        {
          taskId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        },
        'Error processing task'
      );

      // Try to submit error result (idempotent)
      try {
        await this.apiClient.submitResults(
          taskId,
          'failed',
          {},
          error instanceof Error ? error.message : String(error)
        );
      } catch (submitError) {
        logger.error(
          { taskId, error: submitError instanceof Error ? submitError.message : String(submitError) },
          'Failed to submit error result'
        );
      }

      throw error;
    } finally {
      // Cleanup: remove temp files (can be disabled via KEEP_TASK_FILES=1 for debugging)
      let keepTaskFiles = process.env.KEEP_TASK_FILES === '1';
      keepTaskFiles = true;
      if (!keepTaskFiles) {
        try {
          const taskWorkDir = path.join(this.workDir, taskId);
          await this.cleanup(taskWorkDir);
        } catch (cleanupError) {
          logger.warn(
            { taskId, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) },
            'Failed to cleanup task files'
          );
        }
      } else {
        logger.info({ taskId, workDir: path.join(this.workDir, taskId) }, 'KEEP_TASK_FILES=1 set, skipping cleanup of task workDir');
      }

      // Unmark processing (in-memory)
      this.unmarkProcessing(taskId);
    }
  }

  /**
   * Convert CSV content to JSONL format
   * Handles JSON string values (like rubric_vars) by parsing them into objects
   */
  private csvToJsonl(csvContent: string): string {
    const lines = csvContent.trim().split('\n');
    if (lines.length === 0) {
      return '';
    }

    // Parse header
    const header = lines[0].split(',').map(h => h.trim());
    
    // Parse rows and convert to JSON objects
    const jsonlLines: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue; // Skip empty lines
      
      // Simple CSV parsing (handles basic cases, may need improvement for quoted values)
      const values = this.parseCsvLine(line);
      
      // Create object from header and values
      const obj: Record<string, any> = {};
      for (let j = 0; j < header.length; j++) {
        let value = values[j] || '';
        const headerName = header[j];
        
        // Remove surrounding quotes if present (CSV parser may leave them)
        value = value.trim();
        if ((value.startsWith('"') && value.endsWith('"')) || 
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
          // Unescape escaped quotes ("" -> ")
          value = value.replace(/""/g, '"');
        }
        
        // Try to parse JSON strings (e.g., rubric_vars column)
        // If it's a JSON string (starts with { or [), parse it
        if (value.trim().startsWith('{') || value.trim().startsWith('[')) {
          try {
            obj[headerName] = JSON.parse(value);
          } catch (e) {
            // If parsing fails, keep as string
            obj[headerName] = value;
          }
        } else {
          obj[headerName] = value;
        }
      }
      
      jsonlLines.push(JSON.stringify(obj));
    }
    
    return jsonlLines.join('\n');
  }

  /**
   * Parse a CSV line, handling quoted values
   */
  private parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i++; // Skip next quote
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        // End of field
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    
    // Add last field
    values.push(current.trim());
    
    return values;
  }

  /**
   * Check if content appears to be CSV format
   */
  private isCsvContent(content: string): boolean {
    const lines = content.trim().split('\n');
    if (lines.length < 2) return false;
    
    const firstLine = lines[0].trim();
    
    // If first line starts with { or [, it's JSON/JSONL, not CSV
    if (firstLine.startsWith('{') || firstLine.startsWith('[')) {
      return false;
    }
    
    // Check if it looks like CSV: has commas, has newlines, first line has multiple comma-separated values
    const commaCount = (firstLine.match(/,/g) || []).length;
    
    // If first line has commas and multiple lines, likely CSV
    return commaCount > 0 && lines.length > 1;
  }

  /**
   * Prepare files from task payload
   * 
   * All files are created in the provided workDir, which should be task-specific
   * (e.g., /tmp/validator-work/{taskId}/) to prevent overwrites between concurrent tasks.
   * 
   * @param taskPayload - Task payload containing files and config
   * @param workDir - Task-specific work directory (must be unique per task)
   */
  /**
   * Download file from URL or decode from base64
   */
  private async downloadFileWithBackup(
    primaryUrl: string,
    backupUrl?: string,
    timeoutMs: number = 10_000
  ): Promise<string> {
    const logPrimary = primaryUrl.substring(0, 200);
    const logBackup = backupUrl ? backupUrl.substring(0, 200) : undefined;

    const attemptDownload = async (url: string): Promise<string> => {
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(`Invalid file URL: ${url.substring(0, 120)}`);
      }

      const maxAttempts = 2;
      const baseDelayMs = 500;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const start = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const response = await fetch(url, {
            cache: 'no-store',
            headers: {
              'Cache-Control': 'no-store',
              'Pragma': 'no-cache',
              'Expires': '0'
            },
            signal: controller.signal
          });
          clearTimeout(timer);

          const elapsed = Date.now() - start;

          if (!response.ok) {
            const bodySnippet = await response.text().catch(() => '');
            const statusMsg = `Failed to download file: ${response.status} ${response.statusText}`;
            logger.warn(
              {
                url: url.substring(0, 200),
                status: response.status,
                attempt,
                elapsedMs: elapsed,
                bodySnippet: bodySnippet.slice(0, 500)
              },
              statusMsg
            );

            if (response.status >= 500 && attempt < maxAttempts) {
              await setTimeoutPromise(baseDelayMs * attempt);
              continue;
            }
            throw new Error(statusMsg);
          }

          const content = await response.text();
          return content;
        } catch (err) {
          const elapsed = Date.now() - start;
          const isLast = attempt === maxAttempts;
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn({ url: url.substring(0, 200), attempt, elapsedMs: elapsed, err: errMsg }, 'Download attempt failed');
          if (isLast) {
            throw err;
          }
          await setTimeoutPromise(baseDelayMs * attempt);
        }
      }
      throw new Error('Unexpected download failure');
    };

    try {
      return await attemptDownload(primaryUrl);
    } catch (primaryErr) {
      if (backupUrl) {
        logger.warn({ primary: logPrimary, backup: logBackup, err: String(primaryErr) }, 'Primary download failed, trying backup');
        return attemptDownload(backupUrl);
      }
      throw primaryErr;
    }
  }

  /**
   * Validate dataset file has 'input' field
   */
  private async validateDataset(datasetPath: string): Promise<void> {
    const content = await fs.readFile(datasetPath, 'utf-8');
    const firstLine = content.split('\n').find(l => l.trim());
    if (!firstLine) {
      throw new Error('Dataset file is empty');
    }
    
    let parsed: any;
    try {
      parsed = JSON.parse(firstLine.trim());
    } catch (e) {
      throw new Error(`Failed to parse dataset first line as JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    
    // Handle multiple levels of double-encoding (keep unwrapping)
    let unwrapCount = 0;
    while (typeof parsed === 'string' && unwrapCount < 5) {
      logger.warn({ unwrapCount }, 'Dataset appears to be double-encoded, parsing again');
      parsed = JSON.parse(parsed);
      unwrapCount++;
    }
    
    if (unwrapCount > 0) {
      logger.warn({ unwrapCount }, `Dataset was ${unwrapCount}x encoded`);
    }
    
    // Check if it's an object with 'input' field
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Dataset first line must be a JSON object, got ${typeof parsed}`);
    }
    
    // Check for 'input' field
    const keys = Object.keys(parsed);
    const hasInput = 'input' in parsed;
    
    logger.debug(
      { 
        datasetPath, 
        keys, 
        hasInput,
        parsedType: typeof parsed
      }, 
      'Dataset validation check'
    );
    
    if (!hasInput) {
      throw new Error(`Dataset missing "input" field. Found keys: ${keys.join(', ')}`);
    }
    
    logger.debug({ datasetPath, keys }, 'Dataset validation passed');
  }

  private async prepareFiles(
    taskPayload: Task['task_payload'],
    workDir: string
  ): Promise<{
    suitePath: string;
    agentFilePath?: string;
    datasetPath?: string;
    rubricPath?: string;
  }> {
    if (!workDir.startsWith(this.workDir)) {
      throw new Error(`Invalid workDir: ${workDir} is not within base workDir: ${this.workDir}`);
    }

    // Download and write agent file
    logger.info({ taskId: taskPayload.task_id, workDir }, 'PrepareFiles: start');

    let agentFilePath: string | undefined;
    let agentFileName = 'agent.af';
    
    if (taskPayload.agent_file_path) {
      logger.info(
        { taskId: taskPayload.task_id, url: taskPayload.agent_file_path },
        'PrepareFiles: downloading agent file'
      );
      const agentContent = await this.downloadFileWithBackup(
        taskPayload.agent_file_path,
        (taskPayload as any).agent_backup_file_path
      );
      agentFilePath = path.join(workDir, agentFileName);
      await fs.writeFile(agentFilePath, agentContent, 'utf-8');
      
      // Log where the agent file is and a truncated preview of its contents
      // This helps debug exactly what is being sent to Letta via letta-evals
      const previewLength = 2000; // Prevent logging extremely large files
      const agentPreview = agentContent.substring(0, previewLength);
      
      logger.info({
        taskId: taskPayload.task_id,
        agentFilePath,
        previewLength: agentContent.length,
        previewTruncated: agentContent.length > previewLength,
        agentPreview
      }, 'PrepareFiles: downloaded agent file (preview)');
    }

    // Download and write dataset
    let datasetPath: string | undefined;
    const dataset = taskPayload.dataset_file_path;

    if (dataset) {
      logger.info(
        { taskId: taskPayload.task_id, url: dataset },
        'PrepareFiles: downloading dataset'
      );
      if (dataset.startsWith('http://') || dataset.startsWith('https://') || dataset.startsWith('base64:')) {
        // Download from URL or decode from base64
        const datasetContent = await this.downloadFileWithBackup(
          dataset,
          (taskPayload as any).dataset_backup_file_path
        );

        datasetPath = path.join(workDir, 'dataset.jsonl');
        
        // Convert CSV to JSONL if needed
        let finalContent = datasetContent;
        if (this.isCsvContent(datasetContent)) {
          logger.info({ taskId: taskPayload.task_id, datasetPath }, 'PrepareFiles: converting CSV to JSONL');
          finalContent = this.csvToJsonl(datasetContent);
        }
        
        await fs.writeFile(datasetPath, finalContent, 'utf-8');
        try {
          await this.validateDataset(datasetPath);
          logger.info({ taskId: taskPayload.task_id, datasetPath }, 'PrepareFiles: downloaded and validated dataset file');
        } catch (error) {
          // Re-throw with more context
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error({
            taskId: taskPayload.task_id,
            datasetPath,
            error: errorMessage,
            firstLine: finalContent.split('\n')[0]?.substring(0, 200)
          }, 'PrepareFiles: dataset validation failed');
          throw error;
        }
      } else {
        // External file path
        datasetPath = dataset;
      }
    }

    // Download and write rubric, or create default if missing
    let rubricPath: string | undefined;
    const defaultRubric = `Evaluate the AI agent's response across these dimensions:
      **CORRECTNESS (40%)**
      - Does the response accurately address the user's question or request?
      - Are factual claims correct and verifiable?
      - Does it match or align with the ground truth (if provided)?

      **COMPLETENESS (25%)**
      - Does the response fully answer all parts of the question?
      - Is important context or detail missing?

      **CLARITY & COHERENCE (20%)**
      - Is the response well-structured and easy to understand?
      - Is the language clear and appropriate for the context?

      **HELPFULNESS (15%)**
      - Does the response provide actionable or useful information?
      - Is the tone appropriate and professional?

      **SCORING RUBRIC:**
      - 1.0: Exceptional - Perfect on all dimensions
      - 0.8-0.9: Excellent - Minor improvements possible
      - 0.6-0.7: Good - Meets expectations with some gaps
      - 0.4-0.5: Fair - Addresses query but has notable issues
      - 0.2-0.3: Poor - Significant problems or inaccuracies
      - 0.0-0.1: Unacceptable - Fails to address query

      Provide ONLY a numeric score between 0.0 and 1.0.
    `.trim();

    rubricPath = path.join(workDir, 'rubric.txt');
    if (taskPayload.rubric_file_path) {
      logger.info({ taskId: taskPayload.task_id, url: taskPayload.rubric_file_path }, 'PrepareFiles: downloading rubric');
        const rubricContent = await this.downloadFileWithBackup(
          taskPayload.rubric_file_path,
          (taskPayload as any).rubric_backup_file_path
        );
      await fs.writeFile(rubricPath, rubricContent, 'utf-8');
      logger.info({ taskId: taskPayload.task_id, rubricPath }, 'PrepareFiles: downloaded rubric file');
    } else {
      await fs.writeFile(rubricPath, defaultRubric, 'utf-8');
      logger.info({ taskId: taskPayload.task_id, rubricPath }, 'PrepareFiles: created default rubric file');
    }

    // Override base_url to use validator's configured Letta server
    let targetBaseUrl: string | undefined;
    if (process.env.LETTA_BASE_URL) {
      targetBaseUrl = process.env.LETTA_BASE_URL.trim().replace(/^["']|["']$/g, '');
    } else if (process.env.LETTA_API_KEY) {
      targetBaseUrl = 'https://api.letta.com';
    }
    
    if (targetBaseUrl && !targetBaseUrl.startsWith('http://') && !targetBaseUrl.startsWith('https://')) {
      throw new Error(`Invalid base_url: "${targetBaseUrl}" - must start with http:// or https://`);
    }

    // Create suite.yaml from provided suite_file_path file
    const suitePath = path.join(workDir, 'suite.yaml');
    
    if (!taskPayload.suite_file_path || typeof taskPayload.suite_file_path !== 'string') {
      throw new Error('suite_file_path is required but was not provided in task payload');
    }

    // Use provided suite.yaml file, but override base_url and ensure dataset path is correct
    logger.info({ taskId: taskPayload.task_id, url: taskPayload.suite_file_path }, 'PrepareFiles: downloading suite.yaml');
    const suiteYamlContent = await this.downloadFileWithBackup(
      taskPayload.suite_file_path,
      (taskPayload as any).suite_backup_file_path
    );
    let suiteConfig = yaml.load(suiteYamlContent) as any;
    
    if (!suiteConfig) {
      throw new Error('Failed to parse provided suite.yaml file');
    }
    
    // Update dataset path to point to the local file if dataset was written
    if (datasetPath) {
      suiteConfig.dataset = path.basename(datasetPath);
    }
    
    // Update target.base_url and agent_file
    if (!suiteConfig.target) {
      suiteConfig.target = {};
    }
    if (targetBaseUrl) {
      suiteConfig.target.base_url = targetBaseUrl;
    }
    if (agentFilePath) {
      suiteConfig.target.agent_file = path.basename(agentFilePath);
    }
    
    const updatedYamlContent = yaml.dump(suiteConfig);
    await fs.writeFile(suitePath, updatedYamlContent, 'utf-8');
    logger.info({
      taskId: taskPayload.task_id,
      suitePath,
      targetBaseUrl,
      agentFilePath: agentFilePath ? path.basename(agentFilePath) : undefined,
      datasetPath: datasetPath ? path.basename(datasetPath) : undefined
    }, 'PrepareFiles: updated suite.yaml');

    return {
      suitePath,
      agentFilePath,
      datasetPath,
      rubricPath
    };
  }

  /**
   * Generate suite.yaml content from config
   */

  /**
   * Run letta-evals evaluation
   */
  private async runEvaluation(
    suitePath: string,
    outputDir: string
  ): Promise<{
    summary: Record<string, unknown> | null;
    results: unknown[];
    artifacts: Record<string, string>;
    duration_seconds: number;
  }> {
    const suiteDir = path.dirname(suitePath);
    const suiteFile = path.basename(suitePath);

    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });

    const startTime = Date.now();

    // Run letta-evals via python module to avoid relying on shell scripts
    const pythonCmd = process.env.LETTA_EVALS_PYTHON || 'python3';
    const cliModule = process.env.LETTA_EVALS_MODULE || 'letta_evals.cli';
    
    // Verify dataset file exists before validation/execution
    // Parse suite.yaml to get dataset path
    try {
      const suiteYamlContent = await fs.readFile(suitePath, 'utf-8');
      const suiteConfig = yaml.load(suiteYamlContent) as any;
      if (suiteConfig?.dataset) {
        const datasetPath = path.isAbsolute(suiteConfig.dataset) 
          ? suiteConfig.dataset 
          : path.join(suiteDir, suiteConfig.dataset);
        
        try {
          await fs.access(datasetPath);
          const stats = await fs.stat(datasetPath);
          if (stats.size === 0) {
            throw new Error(`Dataset file is empty: ${datasetPath}`);
          }
        } catch (error) {
          logger.error(
            { 
              datasetPath, 
              suiteDataset: suiteConfig.dataset,
              suiteDir,
              error: error instanceof Error ? error.message : String(error)
            },
            'Dataset file not accessible - letta-evals will fail'
          );
          throw new Error(`Dataset file not accessible: ${datasetPath}. ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Dataset file not accessible')) {
        throw error;
      }
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Could not verify dataset file (suite.yaml may use external dataset)');
    }
    
    // First, validate the suite configuration
    const validateCmd = `${pythonCmd} -m ${cliModule} validate "${suiteFile}"`;
    logger.info({ validateCmd, cwd: suiteDir }, 'Validating suite.yaml');
    
    try {
      const { stdout: validateStdout, stderr: validateStderr } = await execAsync(validateCmd, {
        cwd: suiteDir,
        env: process.env,
        maxBuffer: 1024 * 1024 // 1MB for validation output
      });
      
      if (validateStdout) {
        logger.debug({ stdout: validateStdout }, 'Suite validation stdout');
      }
      if (validateStderr) {
        logger.warn({ stderr: validateStderr }, 'Suite validation stderr');
      }
      logger.info('Suite validation passed');
    } catch (error: any) {
      const validateStdout = error?.stdout || '';
      const validateStderr = error?.stderr || '';
      const validateMessage = error instanceof Error ? error.message : String(error);
      
      logger.error(
        {
          error: validateMessage,
          stdout: validateStdout || undefined,
          stderr: validateStderr || undefined,
          suitePath,
        },
        'Suite validation failed'
      );
      
      throw new Error(`Suite validation failed: ${validateMessage}${validateStderr ? '\n' + validateStderr : ''}`);
    }

    // Now run the evaluation with custom graders using wrapper script
    const cmd = `${pythonCmd} /app/python/run_with_graders.py run "${suiteFile}" --output "${outputDir}"`;
    logger.info({ cmd, cwd: suiteDir, outputDir }, 'Running letta-evals with custom graders');

    try {
      // Prepare environment variables for letta-evals
      // Pass through all model provider API keys
      const env: Record<string, string> = {
        ...process.env,
        // Ensure Python path is available
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      };

      // Add model provider API keys (only if defined)
      if (process.env.OPENAI_API_KEY) {
        env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      }
      if (process.env.ANTHROPIC_API_KEY) {
        env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      }
      if (process.env.GOOGLE_API_KEY) {
        env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
      }
      if (process.env.OPENROUTER_API_KEY) {
        env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
      }
      if (process.env.TOGETHER_API_KEY) {
        env.TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
      }
      if (process.env.TOGETHERAI_API_KEY) {
        env.TOGETHERAI_API_KEY = process.env.TOGETHERAI_API_KEY;
      }
      // Letta - support both local and cloud
      if (process.env.LETTA_API_KEY) {
        env.LETTA_API_KEY = process.env.LETTA_API_KEY; // For Letta Cloud
      }
      if (process.env.LETTA_BASE_URL) {
        // Strip quotes if present (common when set in docker-compose or shell scripts)
        env.LETTA_BASE_URL = process.env.LETTA_BASE_URL.trim().replace(/^["']|["']$/g, '');
      } else if (process.env.LETTA_URL) {
        // Strip quotes if present
        env.LETTA_BASE_URL = process.env.LETTA_URL.trim().replace(/^["']|["']$/g, '');
      }

      const { stdout, stderr } = await execAsync(cmd, {
        cwd: suiteDir,
        env,
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large outputs
      });

      // Log stdout for debugging (letta-evals may output progress info here)
      // if (stdout) {
      //   logger.info({ stdout }, 'letta-evals stdout output');
      // }

      if (stderr) {
        logger.warn({ stderr }, 'letta-evals stderr output');
        
        // Check for common error patterns in stderr
        if (stderr.includes('401') || stderr.includes('Unauthorized')) {
          logger.error(
            {
              error: '401 Unauthorized',
              baseUrl: process.env.LETTA_BASE_URL || 'https://api.letta.com',
              hasLettaApiKey: !!process.env.LETTA_API_KEY,
              hasLettaBaseUrl: !!process.env.LETTA_BASE_URL,
              stderr: stderr.substring(0, 500), // First 500 chars
            },
            'Detected 401 Unauthorized error - check Letta server authentication'
          );
        }
        if (stderr.includes('403') || stderr.includes('Forbidden')) {
          logger.error(
            {
              error: '403 Forbidden',
              baseUrl: process.env.LETTA_BASE_URL || 'https://api.letta.com',
              hasLettaApiKey: !!process.env.LETTA_API_KEY,
              hasLettaBaseUrl: !!process.env.LETTA_BASE_URL,
              stderr: stderr.substring(0, 500), // First 500 chars
            },
            'Detected 403 Forbidden error - check Letta server permissions/authentication'
          );
        }
      }

      const duration = (Date.now() - startTime) / 1000;

      // Load results - validate that evaluation actually produced output
      const summaryPath = path.join(outputDir, 'summary.json');
      const resultsPath = path.join(outputDir, 'results.jsonl');

      let summary: Record<string, unknown> | null = null;
      const results: unknown[] = [];

      // Check if summary.json exists
      try {
        await fs.access(summaryPath);
        const summaryContent = await fs.readFile(summaryPath, 'utf-8');
        summary = JSON.parse(summaryContent);
      } catch (error) {
        logger.warn({ error, summaryPath }, 'Failed to read summary.json');
      }

      // Check if results.jsonl exists
      try {
        await fs.access(resultsPath);
        const resultsContent = await fs.readFile(resultsPath, 'utf-8');
        for (const line of resultsContent.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) {
            results.push(JSON.parse(trimmed));
          }
        }
      } catch (error) {
        logger.warn({ error, resultsPath }, 'Failed to read results.jsonl');
      }

      // Validate that we got at least some results
      // If letta-evals exits with 0 but produces no output, something went wrong
      if (!summary && results.length === 0) {
        throw new Error(
          'Evaluation completed but produced no results. ' +
          'No summary.json or results.jsonl found. ' +
          'This may indicate letta-evals failed silently.'
        );
      }

      // Validate that evaluation actually succeeded (not just exited with 0)
      // Check if all samples failed or if there are errors in the results
      if (results.length > 0) {
        const allFailed = results.every((result: unknown) => {
          if (typeof result !== 'object' || result === null) return false;
          const resultObj = result as Record<string, unknown>;
          const resultData = resultObj.result as Record<string, unknown> | undefined;
          
          if (!resultData) return false;
          
          const grade = resultData.grade as { score?: number; rationale?: string } | undefined;
          const submission = resultData.submission as string | undefined;
          
          // Check if sample failed: score is 0, submission is empty, or rationale contains "Error:"
          return (
            grade?.score === 0 &&
            (!submission || submission.trim() === '') &&
            (grade?.rationale?.includes('Error:') || grade?.rationale?.toLowerCase().includes('error'))
          );
        });

        if (allFailed) {
          // Extract error details from first result
          const firstResult = results[0];
          let firstError = 'Unknown error';
          let errorDetails: Record<string, unknown> = {};
          
          if (typeof firstResult === 'object' && firstResult !== null) {
            const resultObj = firstResult as Record<string, unknown>;
            const resultData = resultObj.result as Record<string, unknown> | undefined;
            const grade = resultData?.grade as { rationale?: string; score?: number } | undefined;
            const submission = resultData?.submission as string | undefined;
            
            firstError = grade?.rationale || 'Unknown error';
            
            // Extract detailed error info for debugging
            errorDetails = {
              score: grade?.score,
              submission: submission || '(empty)',
              submissionLength: submission?.length || 0,
              rationale: grade?.rationale?.substring(0, 300) || '(none)',
              hasErrorInRationale: grade?.rationale?.includes('Error:') || false,
              has403Error: grade?.rationale?.includes('403') || grade?.rationale?.includes('Forbidden') || false,
              has401Error: grade?.rationale?.includes('401') || grade?.rationale?.includes('Unauthorized') || false,
            };
          }
          
          // Log detailed error information for debugging
          logger.error(
            {
              allSamplesFailed: true,
              totalSamples: results.length,
              firstErrorDetails: errorDetails,
              lettaConfig: {
                LETTA_BASE_URL: process.env.LETTA_BASE_URL || '(not set)',
                LETTA_API_KEY: process.env.LETTA_API_KEY ? '***SET***' : '(not set)',
              },
            },
            'All evaluation samples failed - detailed error information'
          );
          
          const errorMessage = firstError.length > 500 
            ? firstError.substring(0, 500) + '...' 
            : firstError;
          
          throw new Error(
            `All evaluation samples failed. ` +
            `This indicates the evaluation did not succeed despite letta-evals exiting with code 0. ` +
            `First error: ${errorMessage}`
          );
        }

        // Check summary metrics - if all scores are 0 and no attempts succeeded
        if (summary && typeof summary === 'object' && 'metrics' in summary) {
          const metrics = (summary as Record<string, unknown>).metrics as Record<string, unknown> | undefined;
          if (
            metrics?.avg_score_total === 0 &&
            metrics?.passed_attempts === 0 &&
            metrics?.total_attempted === 0 &&
            results.length > 0
          ) {
            throw new Error(
              'Evaluation completed but all samples failed. ' +
              'No successful attempts recorded. ' +
              'This may indicate configuration or connectivity issues.'
            );
          }
        }
      }

      const artifacts: Record<string, string> = {};

      // Read suite.yaml to get grader weights for weighted average calculation
      let graderWeights: Record<string, number> = {};
      try {
        const suiteYamlContent = await fs.readFile(suitePath, 'utf-8');
        const suiteConfig = yaml.load(suiteYamlContent) as any;
        if (suiteConfig?.graders && typeof suiteConfig.graders === 'object') {
          for (const [graderName, graderConfig] of Object.entries(suiteConfig.graders)) {
            const grader = graderConfig as { weight?: number; [key: string]: unknown };
            if (typeof grader.weight === 'number') {
              graderWeights[graderName] = grader.weight;
            }
          }
        }
      } catch (error) {
        logger.debug({ error, suitePath }, 'Could not read suite.yaml for grader weights');
      }

      // Process results: round scores and add performance metrics
      const processedResults = results.map((result: unknown) => {
        if (typeof result !== 'object' || result === null) return result;
        
        const resultObj = result as Record<string, unknown>;
        const resultData = resultObj.result as Record<string, unknown> | undefined;
        
        if (!resultData) return result;
        
        // Round scores to 3 decimal places
        const roundScore = (score: number | undefined): number | undefined => {
          if (score === undefined || score === null) return score;
          return Math.round(score * 1000) / 1000;
        };
        
        // Process grades object (e.g., grades.quality.score)
        const grades = resultData.grades as Record<string, { score?: number; [key: string]: unknown }> | undefined;
        if (grades) {
          for (const graderName in grades) {
            const grader = grades[graderName];
            if (grader && typeof grader.score === 'number') {
              grader.score = roundScore(grader.score)!;
            }
          }
        }
        
        // Calculate performance metrics
        const agentUsage = resultData.agent_usage as Array<{
          total_tokens?: number;
          step_count?: number;
          [key: string]: unknown;
        }> | undefined;
        
        let totalTokens = 0;
        let avgSteps = 0;
        
        // Sum agent tokens
        if (agentUsage && Array.isArray(agentUsage) && agentUsage.length > 0) {
          const agentTokens = agentUsage.reduce((sum, usage) => {
            return sum + (usage.total_tokens || 0);
          }, 0);
          totalTokens += agentTokens;
          
          // Calculate average steps
          const steps = agentUsage.map(u => u.step_count || 0).filter(s => s > 0);
          if (steps.length > 0) {
            avgSteps = steps.reduce((sum, s) => sum + s, 0) / steps.length;
          }
        }
        
        // Add grading tokens from all graders
        let gradingTokens = 0;
        const graderNames = grades ? Object.keys(grades) : [];
        
        if (graderNames.length > 0) {
          // Count tokens from all graders
          for (const graderName of graderNames) {
            const grader = grades![graderName];
            const graderMetadata = grader?.metadata as { usage?: { total_tokens?: number } } | undefined;
            if (graderMetadata?.usage?.total_tokens) {
              gradingTokens += graderMetadata.usage.total_tokens;
            }
          }
        }
        
        totalTokens += gradingTokens;
        
        // Calculate weighted average score from individual graders
        let weightedScore: number | undefined = undefined;
        if (grades && Object.keys(grades).length > 0) {
          let totalWeight = 0;
          let weightedSum = 0;
          
          for (const [graderName, grader] of Object.entries(grades)) {
            const graderScore = grader?.score;
            if (graderScore !== undefined && graderScore !== null) {
              const weight = graderWeights[graderName] ?? (1 / Object.keys(grades).length); // Default to equal weight if not specified
              weightedSum += graderScore * weight;
              totalWeight += weight;
            }
          }
          
          if (totalWeight > 0) {
            weightedScore = weightedSum / totalWeight;
            weightedScore = roundScore(weightedScore);
          }
        }
        
        // Use weighted score for token calculation
        // Note: score is 0–1, where 1 = 100%. We want "tokens per 1%" so we divide by 100.
        // Example: if score = 0.8 and totalTokens = 8000,
        //   tokens per 1.0 score  = 8000 / 0.8  = 10000
        //   tokens per 1% score   = 10000 / 100 = 100
        const score = weightedScore ?? 0;
        const tokenPerScorePercent = score > 0 ? totalTokens / (score * 100) : undefined;
        
        // Store weighted score in result data for display
        if (weightedScore !== undefined) {
          resultData.weighted_score = weightedScore;
        }
        
        // Add performance key
        resultData.performance = {
          total_tokens: totalTokens,
          av_tokens: totalTokens, // Average tokens per sample (this is the total for this sample)
          // Tokens per 1 percentage point of score (2 decimal places stored)
          token_per_score_point: tokenPerScorePercent !== undefined
            ? Math.round(tokenPerScorePercent * 100) / 100
            : undefined,
          av_steps: roundScore(avgSteps) || 0
        };
        
        return result;
      });
      
      // Process summary: round scores to 3 decimal places
      let processedSummary = summary;
      if (summary && typeof summary === 'object') {
        processedSummary = { ...summary };
        
        const roundScore = (score: number | undefined): number | undefined => {
          if (score === undefined || score === null) return score;
          return Math.round(score * 1000) / 1000;
        };
        
        // Process metrics
        if ('metrics' in processedSummary) {
          const metrics = (processedSummary.metrics as Record<string, unknown>) || {};
          const processedMetrics = { ...metrics };
          
          // Round avg_score_total
          // Note: avg_score_total from letta-evals should be calculated using grader weights from suite.yaml
          if (typeof processedMetrics.avg_score_total === 'number') {
            processedMetrics.avg_score_total = roundScore(processedMetrics.avg_score_total)!;
          }
          
          // Round avg_score_attempted
          // Note: avg_score_attempted from letta-evals should be calculated using grader weights from suite.yaml
          if (typeof processedMetrics.avg_score_attempted === 'number') {
            processedMetrics.avg_score_attempted = roundScore(processedMetrics.avg_score_attempted)!;
          }
          
          // Process by_metric
          if (processedMetrics.by_metric && typeof processedMetrics.by_metric === 'object') {
            const byMetric = processedMetrics.by_metric as Record<string, unknown>;
            const processedByMetric: Record<string, unknown> = {};
            
            for (const metricName in byMetric) {
              const metricData = byMetric[metricName] as Record<string, unknown>;
              if (metricData && typeof metricData === 'object') {
                processedByMetric[metricName] = {
                  ...metricData,
                  avg_score_total: typeof metricData.avg_score_total === 'number' 
                    ? roundScore(metricData.avg_score_total)! 
                    : metricData.avg_score_total,
                  avg_score_attempted: typeof metricData.avg_score_attempted === 'number'
                    ? roundScore(metricData.avg_score_attempted)!
                    : metricData.avg_score_attempted
                };
              } else {
                processedByMetric[metricName] = metricData;
              }
            }
            
            processedMetrics.by_metric = processedByMetric;
          }
          
          processedSummary.metrics = processedMetrics;
        }
      }

      // Clean up MCP servers before returning
      await this.cleanupMcpServers(suiteDir);

      // Display results and summary in console (with ticker tape effect)
      await this.displayEvaluationResults(processedResults, processedSummary);

      return {
        summary: processedSummary,
        results: processedResults,
        artifacts,
        duration_seconds: duration
      };
    } catch (error: any) {
      // Clean up MCP servers even on error
      await this.cleanupMcpServers(suiteDir);
      
      // execAsync errors have stdout and stderr properties
      const stdout = error?.stdout || '';
      const stderr = error?.stderr || '';
      const message = error instanceof Error ? error.message : String(error);
      
      logger.error(
        { 
          error: message,
          stdout: stdout || undefined,
          stderr: stderr || undefined,
          cmd,
          cwd: suiteDir
        },
        'letta-evals execution failed'
      );
      
      // Include stderr in the error message if available
      const errorDetails = stderr ? `${message}\n${stderr}` : message;
      throw new Error(`Evaluation failed: ${errorDetails}`);
    }
  }

  /**
   * Sleep helper for delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Display evaluation results and summary in a formatted console output
   * Outputs results one at a time with delays for ticker tape effect
   */
  private async displayEvaluationResults(
    results: unknown[],
    summary: unknown,
    delayMs: number = 800
  ): Promise<void> {
    console.log('\n' + '='.repeat(70));
    console.log('  EVALUATION RESULTS');
    console.log('='.repeat(70) + '\n');

    // Collect weighted scores to calculate our own average for verification
    const weightedScores: number[] = [];

    // Display each result with delay
    if (results && Array.isArray(results) && results.length > 0) {
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (typeof result !== 'object' || result === null) continue;
        
        const resultObj = result as Record<string, unknown>;
        const resultData = resultObj.result as Record<string, unknown> | undefined;

        // console.log(result);
        
        if (!resultData) continue;

        const grades = resultData.grades as Record<string, { score?: number; [key: string]: unknown }> | undefined;
        const performance = resultData.performance as {
          total_tokens?: number;
          av_steps?: number;
          token_per_score_point?: number;
        } | undefined;
        const weightedScore = resultData.weighted_score as number | undefined;

        const sampleId = resultData.sample_id || `Sample ${index + 1}`;

        console.log(`┌─ RESULT ${index + 1}: ${sampleId}`);
        console.log('│');
        
        // Display weighted average score
        if (weightedScore !== undefined) {
          console.log(`│  Score: ${weightedScore.toFixed(3)} (weighted avg)`);
          weightedScores.push(weightedScore);
        } else if (grades && Object.keys(grades).length > 0) {
          // Fallback: calculate simple average if weights not available
          const scores = Object.values(grades)
            .map(g => (g as { score?: number })?.score)
            .filter((s): s is number => typeof s === 'number');
          if (scores.length > 0) {
            const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;
            console.log(`│  Score: ${avgScore.toFixed(3)} (avg)`);
            weightedScores.push(avgScore);
          }
        }

        // Individual grader scores if available
        if (grades && Object.keys(grades).length > 0) {
          console.log('│  Graders:');
          for (const [graderName, grader] of Object.entries(grades)) {
            const graderScore = grader?.score;
            const graderRationale = grader?.rationale as string | undefined;
            
            if (graderScore !== undefined && graderScore !== null) {
              console.log(`│    • ${graderName}: ${graderScore.toFixed(3)}`);
              
              // Display rationale if available, nicely formatted
              if (graderRationale) {
                // Wrap long rationales to fit within the box width (accounting for indentation)
                const maxWidth = 60; // Max width for rationale text
                const indent = '│      '; // Indentation for rationale lines
                
                // Split rationale into words and wrap
                const words = graderRationale.split(' ');
                let currentLine = '';
                
                for (const word of words) {
                  if (currentLine.length + word.length + 1 <= maxWidth) {
                    currentLine += (currentLine ? ' ' : '') + word;
                  } else {
                    if (currentLine) {
                      console.log(`${indent}${currentLine}`);
                    }
                    currentLine = word;
                  }
                }
                
                // Print the last line
                if (currentLine) {
                  console.log(`${indent}${currentLine}`);
                }
              }
            }
          }
        }

        // Performance metrics
        if (performance) {
          console.log('│  Performance:');
          if (performance.total_tokens !== undefined) {
            console.log(`│    • Total Tokens: ${performance.total_tokens.toLocaleString()}`);
          }
          if (performance.av_steps !== undefined) {
            console.log(`│    • Avg Steps: ${performance.av_steps.toFixed(2)}`);
          }
          if (performance.token_per_score_point !== undefined) {
            console.log(`│    • Tokens/Score: ${performance.token_per_score_point.toFixed(2)}`);
          }
        }

        console.log('└─\n');

        // Delay before next result (except for the last one)
        if (index < results.length - 1) {
          await this.sleep(delayMs);
        }
      }
    }

    // Delay before summary
    if (results && Array.isArray(results) && results.length > 0) {
      await this.sleep(delayMs);
    }

    // Display summary
    if (summary && typeof summary === 'object') {
      const summaryObj = summary as Record<string, unknown>;
      const metrics = summaryObj.metrics as {
        avg_score_total?: number;
        avg_score_attempted?: number;
        by_metric?: Record<string, {
          avg_score_total?: number;
          avg_score_attempted?: number;
        }>;
      } | undefined;

      console.log('┌─ SUMMARY');
      console.log('│');
      
      // Calculate our own average of weighted scores for verification
      let calculatedAvg: number | undefined = undefined;
      if (weightedScores.length > 0) {
        calculatedAvg = weightedScores.reduce((sum, s) => sum + s, 0) / weightedScores.length;
        console.log(`│  Calculated Avg (from weighted scores): ${calculatedAvg.toFixed(3)}`);
      }
      
      if (metrics) {
        if (metrics.avg_score_total !== undefined) {
          const lettaAvg = metrics.avg_score_total;
          console.log(`│  AETS avg_score_total: ${lettaAvg.toFixed(3)}`);
          
          // Compare our calculation with letta-evals
          if (calculatedAvg !== undefined) {
            const diff = Math.abs(calculatedAvg - lettaAvg);
            // if (diff < 0.001) {
            //   console.log(`│  ✓ Match! (difference: ${diff.toFixed(6)})`);
            // } else {
            //   console.log(`│  ⚠ Mismatch! (difference: ${diff.toFixed(6)})`);
            // }
          }
        }
        if (metrics.avg_score_attempted !== undefined) {
          console.log(`│  Avg Score (Attempted): ${metrics.avg_score_attempted.toFixed(3)}`);
        }

        // By metric breakdown
        if (metrics.by_metric && typeof metrics.by_metric === 'object') {
          const byMetric = metrics.by_metric;
          const metricNames = Object.keys(byMetric);
          if (metricNames.length > 0) {
            console.log('│  By Metric:');
            for (const metricName of metricNames) {
              const metricData = byMetric[metricName];
              if (metricData && typeof metricData === 'object') {
                const total = metricData.avg_score_total;
                const attempted = metricData.avg_score_attempted;
                if (total !== undefined || attempted !== undefined) {
                  const totalStr = total !== undefined ? total.toFixed(3) : 'N/A';
                  const attemptedStr = attempted !== undefined ? attempted.toFixed(3) : 'N/A';
                  console.log(`│    • ${metricName}: ${totalStr} (total) / ${attemptedStr} (attempted)`);
                }
              }
            }
          }
        }
      }

      console.log('└─\n');
    }

    console.log('='.repeat(70) + '\n');
  }

  /**
   * Clean up MCP servers to prevent duplicate key errors on next run
   */
  private async cleanupMcpServers(workDir: string): Promise<void> {
    try {
      logger.info({ workDir }, 'Cleaning up MCP servers from Letta');
      
      // Use letta CLI commands instead of Python imports
      const cleanupScript = `#!/bin/bash
  set +e  # Don't exit on errors

  # Get base URL
  LETTA_BASE_URL="${process.env.LETTA_BASE_URL || 'http://host.docker.internal:8283'}"

  # List servers and delete them using curl
  curl -s "$LETTA_BASE_URL/v1/mcp/servers" 2>/dev/null | \
    python3 -c "
  import sys, json
  try:
      data = json.load(sys.stdin)
      if isinstance(data, list):
          for server in data:
              print(server.get('id', ''))
  except:
      pass
  " | while read server_id; do
    if [ ! -z "$server_id" ]; then
      echo "Deleting MCP server: $server_id"
      curl -s -X DELETE "$LETTA_BASE_URL/v1/mcp/servers/$server_id" 2>&1 || true
    fi
  done

  echo "MCP cleanup completed"
  `;
      
      const cleanupScriptPath = path.join(workDir, 'cleanup_mcp.sh');
      await fs.writeFile(cleanupScriptPath, cleanupScript, 'utf-8');
      await fs.chmod(cleanupScriptPath, 0o755);
      
      const env: Record<string, string> = {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      };
      
      if (process.env.LETTA_API_KEY) {
        env.LETTA_API_KEY = process.env.LETTA_API_KEY;
      }
      if (process.env.LETTA_BASE_URL) {
        env.LETTA_BASE_URL = process.env.LETTA_BASE_URL.trim().replace(/^["']|["']$/g, '');
      } else if (process.env.LETTA_URL) {
        env.LETTA_BASE_URL = process.env.LETTA_URL.trim().replace(/^["']|["']$/g, '');
      }
      
      const { stdout, stderr } = await execAsync('./cleanup_mcp.sh', { 
        cwd: workDir,
        env,
        maxBuffer: 1024 * 1024,
        timeout: 30000
      });
      
      if (stderr) {
        logger.debug({ stderr }, 'MCP cleanup stderr');
      }
      
      try {
        await fs.unlink(cleanupScriptPath);
      } catch {
        // Ignore
      }
    } catch (error) {
      logger.warn({ 
        error: error instanceof Error ? error.message : String(error) 
      }, 'Failed to clean up MCP servers (non-fatal)');
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
      tasks: Array.from(this.processingTasks.keys())
    };
  }
}

