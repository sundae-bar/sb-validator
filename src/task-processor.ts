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
import { LettaClient, type FileMetadata } from './letta-client';

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
  private lettaClient: LettaClient | null = null;
  private weightsIntervalMs: number;
  private filesystemDataFolderId: string | null = null; // Cache folder ID to avoid lookup every time
  constructor(
    apiClient: ApiClient,
    workDir: string = '/tmp/validator-work',
    maxConcurrentTasks: number = 1
  ) {
    this.apiClient = apiClient;
    this.workDir = workDir;
    this.maxConcurrentTasks = maxConcurrentTasks;
    const intervalMinutes = Number(process.env.BITTENSOR_WEIGHTS_INTERVAL_MINUTES || '30');
    this.weightsIntervalMs = Number.isFinite(intervalMinutes) && intervalMinutes > 0
      ? intervalMinutes * 60_000
      : 30 * 60_000;
    
    // Initialize Letta client if base URL is available
    const lettaBaseUrl = process.env.LETTA_BASE_URL?.trim().replace(/^["']|["']$/g, '');
    if (lettaBaseUrl) {
      try {
        this.lettaClient = new LettaClient(lettaBaseUrl);
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Failed to initialize Letta client (file uploads will be disabled)'
        );
      }
    }
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

      // Upload full raw evaluation output (untrimmed) to backend for debugging/inspection.
      // This is separate from the compact result payload we store in result_data.
      try {
        const rawOutputPath = path.join(taskWorkDir, 'raw_evaluation.json');
        await this.apiClient.uploadRawOutputFile(taskId, rawOutputPath);
      } catch (rawError) {
        logger.warn(
          {
            taskId,
            error: rawError instanceof Error ? rawError.message : String(rawError),
          },
          'Failed to upload raw evaluation output file (non-fatal)',
        );
      }

      // Load dataset to map indices to dataset IDs and metadata (input, domain, skill, etc.)
      const datasetIdMap = new Map<number, string>();
      const datasetMetaById = new Map<
        string,
        {
          input?: string;
          domain?: string;
          skill?: string;
          difficulty?: string;
          capability_cluster?: string;
        }
      >();
      if (files.datasetPath) {
        try {
          const datasetContent = await fs.readFile(files.datasetPath, 'utf-8');
          const lines = datasetContent.split('\n').filter(line => line.trim());
          lines.forEach((line, index) => {
            try {
              const sample = JSON.parse(line);
              if (sample.id && typeof sample.id === 'string') {
                datasetIdMap.set(index, sample.id);
                // Extract metadata fields from ground_truth JSON if available
                if (typeof sample.input === 'string') {
                  const meta: {
                    input?: string;
                    domain?: string;
                    skill?: string;
                    difficulty?: string;
                    capability_cluster?: string;
                  } = {
                    input: sample.input,
                  };
                  if (typeof sample.ground_truth === 'string') {
                    try {
                      const gt = JSON.parse(sample.ground_truth);
                      const metadata = gt?.metadata as Record<string, unknown> | undefined;
                      if (metadata && typeof metadata === 'object') {
                        if (typeof metadata.domain === 'string') {
                          meta.domain = metadata.domain;
                        }
                        if (typeof metadata.skill === 'string') {
                          meta.skill = metadata.skill;
                        }
                        if (typeof metadata.difficulty === 'string') {
                          meta.difficulty = metadata.difficulty;
                        }
                        if (typeof metadata.capability_cluster === 'string') {
                          meta.capability_cluster = metadata.capability_cluster;
                        }
                      }
                    } catch {
                      // Ignore ground_truth parse errors
                    }
                  }
                  datasetMetaById.set(sample.id, meta);
                }
              }
            } catch (e) {
              // Skip invalid JSON lines
            }
          });
          logger.debug(
            {
              taskId,
              datasetIdMapSize: datasetIdMap.size,
              datasetMetaCount: datasetMetaById.size,
            },
            'Loaded dataset ID and metadata mapping'
          );
        } catch (error) {
          logger.warn(
            {
              taskId,
              datasetPath: files.datasetPath,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to load dataset for ID mapping (will use index fallback)',
          );
        }
      }

      // Helper to round scores to 5 decimal places
      const roundScore = (value: number) =>
        Math.round(value * 100_000) / 100_000;

      // Step 4: Extract score from summary
      let score: number | undefined = undefined;
      if (evaluationResult.summary && typeof evaluationResult.summary === 'object') {
        const summary = evaluationResult.summary as Record<string, unknown>;
        // Try to get score from summary.metrics.avg_score_total (preferred)
        if (summary.metrics && typeof summary.metrics === 'object') {
          const metrics = summary.metrics as Record<string, unknown>;
          if (typeof metrics.avg_score_total === 'number') {
            if (typeof metrics.scout_rubric_grader === 'number') {
              score = roundScore(metrics.scout_rubric_grader);
            }
          }
        }
        // Fallback: try summary.avg_score_total directly
        if (score === undefined && typeof summary.avg_score_total === 'number') {
          score = roundScore(summary.avg_score_total);
        }
      }

      // Count tests (results entries)
      const testsCount = Array.isArray(evaluationResult.results)
        ? evaluationResult.results.length
        : 0;

      // Step 5: Build compact result payload and submit results (idempotent)
      // We trim down the data to avoid sending large payloads:
      // - results: [{ id, score, rationale, tokens }]
      // - total_score, total_tests, duration_seconds, total_tokens, keys
      const compactResults =
        Array.isArray(evaluationResult.results) ?
          evaluationResult.results.map((result: unknown, index: number) => {
            if (typeof result !== 'object' || result === null) {
              return null;
            }

            const resultObj = result as Record<string, any>;
            const resultData = resultObj.result as Record<string, any> | undefined;
            if (!resultData) {
              return null;
            }

            const grade = resultData.grade as { score?: number; rationale?: string } | undefined;
            const performance = resultData.performance as { total_tokens?: number } | undefined;

            // Try to get ID from result object, then from dataset mapping, then fallback to index
            const id =
              resultObj.id ??
              resultObj.sample_id ??
              resultObj.task_id ??
              datasetIdMap.get(index) ??
              index;

            const perSampleScore =
              typeof resultData.weighted_score === 'number'
                ? resultData.weighted_score
                : typeof grade?.score === 'number'
                  ? grade.score
                  : null;

            const tokens =
              typeof performance?.total_tokens === 'number'
                ? performance.total_tokens
                : null;

            // Attach optional metadata from dataset (if available) for downstream aggregation
            const meta =
              typeof id === 'string' ? datasetMetaById.get(id) : undefined;

            return {
              id,
              score: perSampleScore,
              rationale: grade?.rationale ?? null,
              tokens,
              input: meta?.input ?? null,
              domain: meta?.domain ?? null,
              skill: meta?.skill ?? null,
              difficulty: meta?.difficulty ?? null,
              capability_cluster: meta?.capability_cluster ?? null,
            };
          }).filter((r) => r !== null) as Array<{
            id: string | number;
            score: number | null;
            rationale: string | null;
            tokens: number | null;
            input: string | null;
            domain: string | null;
            skill: string | null;
            difficulty: string | null;
            capability_cluster: string | null;
          }>
        : [];

      const totalTokens = compactResults.reduce((sum, r) => {
        return sum + (typeof r.tokens === 'number' ? r.tokens : 0);
      }, 0);

      // Calculate total_score from individual results if not available from summary
      let calculatedTotalScore: number | null = score ?? null;
      if (calculatedTotalScore === null && compactResults.length > 0) {
        const scoresWithValues = compactResults
          .map((r) => r.score)
          .filter((s): s is number => typeof s === 'number');
        if (scoresWithValues.length > 0) {
          const sum = scoresWithValues.reduce((acc, s) => acc + s, 0);
          calculatedTotalScore = roundScore(sum / scoresWithValues.length);
        }
      }

      const compactPayload = {
        results: compactResults,
        score: calculatedTotalScore,
        tests_count: testsCount,
        duration_seconds: evaluationResult.duration_seconds,
        total_tokens: totalTokens,
        timestamp: new Date().toISOString(),
      };

      logger.info(
        {
          taskId,
          score,
          testsCount,
          compactResultsCount: compactResults.length,
          totalTokens,
        },
        'Submitting compact evaluation results',
      );

      await this.apiClient.submitResults(taskId, 'completed', compactPayload);

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
      keepTaskFiles = false;
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
   * Download files from GitHub repository
   */
  private async downloadFilesFromGitHub(
    repoUrl: string,
    folderPath: string,
    outputDir: string
  ): Promise<string[]> {
    // GitHub API URL format: https://api.github.com/repos/owner/repo/contents/path
    // Extract owner, repo, branch, and path from the GitHub URL
    // Format: https://github.com/owner/repo/tree/branch/path
    const match = repoUrl.match(/https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/tree\/([^\/]+)\/(.+)/);
    if (!match) {
      throw new Error(`Invalid GitHub URL format: ${repoUrl}. Expected format: https://github.com/owner/repo/tree/branch/path`);
    }
    
    const [, owner, repo, branch, repoPath] = match;
    const githubApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${repoPath}`;
    
    logger.info({ repoUrl, folderPath, githubApiUrl }, 'Downloading files from GitHub');

    try {
      // Prepare headers with optional GitHub token for authentication
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'SundaeBar-Validator'
      };
      
      // Add GitHub token if available (authenticated requests get higher rate limits)
      if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
      }
      
      // Use GitHub API to list files in the directory
      const response = await fetch(githubApiUrl, {
        headers
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Failed to fetch GitHub directory: ${response.status} ${response.statusText}. ${errorText}`);
      }

      const items = await response.json();
      const downloadedFiles: string[] = [];

      // Ensure output directory exists
      await fs.mkdir(outputDir, { recursive: true });

      // Process each item (file or directory)
      for (const item of Array.isArray(items) ? items : [items]) {
        if (item.type === 'file') {
          // Use raw.githubusercontent.com for direct file download
          const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${repoPath}/${item.name}`;
          
          const fileHeaders: Record<string, string> = {
            'User-Agent': 'SundaeBar-Validator'
          };
          
          // Add GitHub token if available
          if (process.env.GITHUB_TOKEN) {
            fileHeaders['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
          }
          
          const fileResponse = await fetch(rawUrl, {
            headers: fileHeaders
          });
          
          if (!fileResponse.ok) {
            logger.warn({ file: item.name, status: fileResponse.status }, 'Failed to download file from GitHub');
            continue;
          }

          const fileContent = await fileResponse.text();
          const filePath = path.join(outputDir, item.name);
          await fs.writeFile(filePath, fileContent, 'utf-8');
          downloadedFiles.push(filePath);
          logger.debug({ fileName: item.name, filePath }, 'Downloaded file from GitHub');
        } else if (item.type === 'dir') {
          // Recursively download subdirectory
          const subDir = path.join(outputDir, item.name);
          const subRepoUrl = `https://github.com/${owner}/${repo}/tree/${branch}/${repoPath}/${item.name}`;
          const subFiles = await this.downloadFilesFromGitHub(
            subRepoUrl,
            `${folderPath}/${item.name}`,
            subDir
          );
          downloadedFiles.push(...subFiles);
        }
      }

      if (downloadedFiles.length === 0) {
        logger.warn({ repoUrl, folderPath }, 'No files downloaded from GitHub');
      }

      return downloadedFiles;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), repoUrl, folderPath },
        'Failed to download files from GitHub'
      );
      throw error;
    }
  }

  // GitHub repo constant for filesystem data
  private readonly GITHUB_REPO_URL = 'https://github.com/sundae-bar/sn121-ch-data/tree/main/filesystem_data';
  private readonly FILESYSTEM_DATA_FOLDER_NAME = 'filesystem_data';

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
   * Update agent file to reference the real Letta folder ID
   * 
   * Updates source_ids, files_agents, and sources arrays to use the actual folder ID
   * instead of placeholder IDs. Also resets is_open and visible_content state fields.
   * 
   * @param agentContent - The agent file content as a JSON string
   * @param folderId - The real Letta folder ID to use
   * @param taskId - Task ID for logging purposes
   * @returns Updated agent file content as a JSON string
   */
  private updateAgentFileWithFolderId(agentContent: string, folderId: string, taskId: string): string {
    const agentData = JSON.parse(agentContent);
    if (!agentData.agents || !Array.isArray(agentData.agents) || agentData.agents.length === 0) {
      logger.warn(
        { taskId },
        'Agent file does not have agents array or it is empty'
      );
      return agentContent; // Return unchanged if structure is invalid
    }

    const agent = agentData.agents[0];
    let updated = false;
    
    // Find any placeholder source IDs (source-0, source-1, etc.) for reference
    // We'll use this to update files_agents and files arrays
    const placeholderPattern = /^source-\d+$/; // Matches source-0, source-1, etc.
    const originalSourceId = agent.source_ids && agent.source_ids.length > 0 
      ? agent.source_ids[0] 
      : 'source-0';
    
    // 1. Force folder_ids to contain the real Letta folder ID (full control over which folder is used)
    if (!agent.folder_ids) {
      agent.folder_ids = [];
    }
    if (!Array.isArray(agent.folder_ids)) {
      logger.warn({ taskId }, 'folder_ids is not an array, converting');
      agent.folder_ids = Array.isArray(agent.folder_ids) ? agent.folder_ids : [agent.folder_ids].filter(Boolean);
    }
    if (!agent.folder_ids.includes(folderId)) {
      agent.folder_ids.push(folderId);
      updated = true;
    }
    logger.debug(
      { folderId, folderIdsCount: agent.folder_ids.length, sourceIdsCount: agent.source_ids?.length || 0 },
      'Updated folder_ids array for agent (source_ids kept as placeholders)'
    );

    // 2. Overwrite files/files_agents with our canonical policy files so users cannot control attachments
    const canonicalFiles = [
      { id: 'file-0', file_name: 'filesystem_data/approval_workflows.md', original_file_name: 'approval_workflows.md' },
      { id: 'file-1', file_name: 'filesystem_data/client_tiers.json', original_file_name: 'client_tiers.json' },
      { id: 'file-2', file_name: 'filesystem_data/escalation_matrix.md', original_file_name: 'escalation_matrix.md' },
      { id: 'file-3', file_name: 'filesystem_data/travel_expense_policy.md', original_file_name: 'travel_expense_policy.md' },
      { id: 'file-4', file_name: 'filesystem_data/pto_policy.md', original_file_name: 'pto_policy.md' },
      { id: 'file-5', file_name: 'filesystem_data/org_chart.json', original_file_name: 'org_chart.json' },
    ] as const;

    const nowIso = new Date().toISOString();
    const agentId = agent.id || 'agent-0';

    // Root-level files[]: define only our canonical files; other user-specified files are ignored
    agentData.files = canonicalFiles.map((f) => ({
      source_id: originalSourceId,
      file_name: f.file_name,
      original_file_name: f.original_file_name,
      file_path: null,
      file_type: null,
      file_size: null,
      file_creation_date: null,
      file_last_modified_date: null,
      processing_status: 'completed',
      error_message: null,
      total_chunks: null,
      chunks_embedded: null,
      content: null,
      id: f.id,
    }));

    // files_agents[]: set to empty array - files are accessed via folder_ids instead
    agent.files_agents = [];
    updated = true;

    // 3. Update all sources array names to filesystem_data
    // This prevents letta-evals from creating folders with arbitrary names when importing the agent file
    // We keep the source entries (with their IDs) because files array references them
    // But we change all names to filesystem_data so they match our folder name
    if (agentData.sources && Array.isArray(agentData.sources)) {
      for (const source of agentData.sources) {
        if (source.name && source.name !== 'filesystem_data') {
          const oldName = source.name;
          source.name = 'filesystem_data';
          updated = true;
          logger.debug(
            { sourceId: source.id, oldName, newName: 'filesystem_data' },
            'Updated source name to filesystem_data'
          );
        }
      }
    }
    
    if (updated) {
      const updatedContent = JSON.stringify(agentData, null, 2);
      logger.debug(
        { 
          folderId, 
          taskId,
          folderIdsUpdated: agent.folder_ids.includes(folderId),
          hasFilesAgents: !!(agent.files_agents && agent.files_agents.length > 0)
        },
        'Updated agent file with folder ID in folder_ids array'
      );
      return updatedContent;
    } else {
      logger.warn(
        { folderId, taskId },
        'No updates made to agent file (structure may be unexpected)'
      );
      return agentContent; // Return unchanged if no updates were made
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

    // Set up filesystem data from GitHub for all agents
    // We always check files, but only upload if they've changed
    let folderId: string | undefined;
    let filesWereUploaded = false; // Track if any files were actually uploaded
    
    if (this.lettaClient) {
      try {
        // Log all agents in Letta for debugging, then delete them all
        try {
          const allAgents = await this.lettaClient.listAgents();
          logger.debug(
            {
              totalAgents: allAgents.length,
              agents: allAgents.map(a => ({
                id: a.id,
                name: a.name,
                created_at: a.created_at,
              })),
            },
            'All agents in Letta'
          );
          
          // Delete all agents to clean up from previous runs
          if (allAgents.length > 0) {
            logger.debug(
              { agentCount: allAgents.length },
              'Deleting all agents to clean up from previous runs'
            );
            
            let deletedCount = 0;
            let failedCount = 0;
            for (const agent of allAgents) {
              try {
                await this.lettaClient.deleteAgent(agent.id);
                deletedCount++;
              } catch (error) {
                failedCount++;
                logger.warn(
                  { 
                    error: error instanceof Error ? error.message : String(error),
                    agentId: agent.id,
                    agentName: agent.name
                  },
                  'Failed to delete agent (non-fatal)'
                );
              }
            }
            
            logger.debug(
              { 
                total: allAgents.length,
                deleted: deletedCount,
                failed: failedCount
              },
              'Completed deletion of all agents'
            );
          }
        } catch (error) {
          logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Failed to list/delete all agents (non-fatal)'
          );
        }

        // Log all folders in Letta for debugging
        try {
          const allFolders = await this.lettaClient.listFolders();
          logger.debug(
            {
              totalFolders: allFolders.length,
              folders: allFolders.map(f => ({
                id: f.id,
                name: f.name,
                description: f.description,
                created_at: f.created_at,
              })),
            },
            'All folders in Letta'
          );
        } catch (error) {
          logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Failed to list all folders (non-fatal)'
          );
        }

        // Clean up orphaned folders with hash suffixes (filesystem_data_*, company_policy_data_*)
        // Skip if we can't list folders (API might be having issues)
        try {
          await this.lettaClient.cleanupOrphanedFolders();
        } catch (error) {
          // If cleanup fails due to API issues, log but continue - we'll try again next time
          logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Failed to cleanup orphaned folders (non-fatal, will retry on next task)'
          );
        }

        // Find or create folder in Letta (reuse same folder for all agents since files are the same)
        // Cache folder ID to avoid lookup every time
        if (this.filesystemDataFolderId) {
          folderId = this.filesystemDataFolderId;
          logger.debug(
            { taskId: taskPayload.task_id, folderId },
            'Using cached filesystem data folder ID'
          );
        } else {
          logger.debug({ taskId: taskPayload.task_id }, 'Finding or creating filesystem data folder');
          const folder = await this.lettaClient.findOrCreateFolder(
            this.FILESYSTEM_DATA_FOLDER_NAME,
            'Filesystem data from GitHub repository'
          );
          
          if (!folder || !folder.id) {
            throw new Error(`Folder creation returned invalid response: ${JSON.stringify(folder)}`);
          }
          
          folderId = folder.id;
          this.filesystemDataFolderId = folderId; // Cache it
          logger.debug({ folderId, folderName: folder.name }, 'Folder ID obtained for filesystem data');
          
          // Log files in folder before evaluation starts
          try {
            const folderFiles = await this.lettaClient.listFilesInFolder(folderId);
            logger.info(
              {
                taskId: taskPayload.task_id,
                folderId,
                fileCount: folderFiles.length,
                files: folderFiles.map(f => ({
                  id: f.id,
                  name: f.name || f.file_name,
                  size: f.size,
                  status: f.processing_status
                }))
              },
              'Files in folder before evaluation'
            );
          } catch (error) {
            logger.warn(
              { error: error instanceof Error ? error.message : String(error), taskId: taskPayload.task_id, folderId },
              'Failed to list files in folder'
            );
          }
        }
        
        // Download files from GitHub
        const filesDir = path.join(workDir, 'filesystem_data');
        const downloadedFiles = await this.downloadFilesFromGitHub(
          this.GITHUB_REPO_URL,
          'filesystem_data',
          filesDir
        );

        // List existing files once (more efficient than checking per-file)
        const existingFiles = await this.lettaClient.listFilesInFolder(folderId);
        const existingFilesMap = new Map<string, FileMetadata>();
        for (const file of existingFiles) {
          // Files may have file_name, original_file_name, or name - use the first available
          const fileName = file.file_name || file.original_file_name || file.name;
          if (fileName) {
            // Use just the basename for matching (in case file_name has path)
            const baseName = path.basename(fileName);
            existingFilesMap.set(baseName, file);
          }
        }
        logger.debug(
          {
            folderId,
            existingFileCount: existingFiles.length,
            existingFiles: existingFiles.map(f => ({
              name: f.name,
              id: f.id,
              size: f.size,
              file_name: f.file_name,
              original_file_name: f.original_file_name,
            })),
            fileNames: Array.from(existingFilesMap.keys()),
          },
          'Loaded existing files from folder'
        );

        // Upload files from GitHub to Letta folder, only if they're new or changed
        let githubUploadedCount = 0;
        let githubSkippedCount = 0;
        let githubErrorCount = 0;
        
        for (const filePath of downloadedFiles) {
          try {
            const fileName = path.basename(filePath);
            const existingFile = existingFilesMap.get(fileName);
            
            if (existingFile) {
              // File exists - check if size changed
              const localSize = await this.lettaClient.getFileSize(filePath);
              
              // If we don't have size info for existing file, skip upload (assume unchanged)
              if (!existingFile.size) {
                githubSkippedCount++;
                logger.debug(
                  { source: 'github', fileName, folderId, localSize, reason: 'No size info for existing file, assuming unchanged' },
                  'File skipped (exists but no size info)'
                );
                continue;
              }
              
              // Compare sizes - only replace if different
              if (existingFile.size === localSize) {
                githubSkippedCount++;
                logger.debug(
                  { source: 'github', fileName, folderId, size: localSize },
                  'File skipped (already exists and unchanged)'
                );
                continue;
              } else {
                // Size changed - replace it
                logger.info(
                  { source: 'github', fileName, folderId, existingSize: existingFile.size, newSize: localSize },
                  'File exists but size changed, replacing'
                );
                await this.lettaClient.uploadFileToFolder(folderId, filePath, fileName, 'replace');
                githubUploadedCount++;
                filesWereUploaded = true;
                // Update the map so subsequent checks see the new file
                existingFilesMap.set(fileName, { ...existingFile, size: localSize });
                logger.info(
                  { source: 'github', fileName, folderId, reason: 'File replaced due to size change' },
                  'File uploaded to Letta folder'
                );
              }
            } else {
              // File doesn't exist - upload it
              logger.info(
                { source: 'github', fileName, folderId },
                'File does not exist, uploading'
              );
              const fileMetadata = await this.lettaClient.uploadFileToFolder(folderId, filePath, fileName, 'replace');
              githubUploadedCount++;
              filesWereUploaded = true;
              // Add to map so subsequent checks see it
              if (fileMetadata) {
                existingFilesMap.set(fileName, fileMetadata);
              }
              logger.info(
                { source: 'github', fileName, folderId, reason: 'New file uploaded' },
                'File uploaded to Letta folder'
              );
            }
          } catch (error) {
            githubErrorCount++;
            logger.error(
              { source: 'github', error: error instanceof Error ? error.message : String(error), filePath, folderId },
              'Failed to upload file to Letta folder'
            );
            // Continue with other files even if one fails
          }
        }

        logger.debug(
          {
            folderId,
            github: {
              total: downloadedFiles.length,
              uploaded: githubUploadedCount,
              skipped: githubSkippedCount,
              errors: githubErrorCount,
            },
          },
          'Filesystem data files processed from GitHub'
        );

        // Log all files currently in the Letta folder (helps debug file names / paths)
        try {
          const filesInFolder = await this.lettaClient.listFilesInFolder(folderId);
          logger.debug(
            {
              folderId,
              filesCount: filesInFolder.length,
              files: filesInFolder.map(f => ({
                id: f.id,
                name: f.name,
                file_name: f.file_name,
                original_file_name: f.original_file_name,
                size: f.size,
                processing_status: f.processing_status,
                total_chunks: f.total_chunks,
                chunks_embedded: f.chunks_embedded,
              })),
            },
            'Letta folder files listing (post-upload)'
          );
        } catch (listError) {
          logger.warn(
            {
              folderId,
              error: listError instanceof Error ? listError.message : String(listError),
            },
            'Failed to list files in Letta folder for debugging'
          );
        }

        logger.debug(
          {
            taskId: taskPayload.task_id,
            folderId,
            filesWereUploaded,
            githubUploaded: githubUploadedCount,
            githubSkipped: githubSkippedCount,
          },
          filesWereUploaded 
            ? 'Files were uploaded/changed - will wait for embeddings'
            : 'No files were uploaded (all unchanged) - skipping embedding wait'
        );
      } catch (error) {
          logger.error(
            {
              error: error instanceof Error ? error.message : String(error),
              taskId: taskPayload.task_id
            },
            'Failed to initialize filesystem data'
          );
          throw error;
        }

      // Verify files are actually available in the folder and wait for embeddings to complete
      // Only wait if we actually uploaded new/changed files
      if (folderId && this.lettaClient) {
        if (!filesWereUploaded) {
          // No files were uploaded, so existing files are already embedded - skip wait
          logger.debug(
            { folderId, taskId: taskPayload.task_id },
            'Skipping embedding wait - no files were uploaded (all unchanged)'
          );
        } else {
          // Files were uploaded/changed - wait for embeddings to complete
          logger.info(
            { folderId, taskId: taskPayload.task_id },
            'Files were uploaded/changed - waiting for embeddings to complete'
          );
          try {
            // Increase default wait to 30 minutes unless overridden
            const maxWaitMinutes = parseInt(process.env.LETTA_EMBEDDING_WAIT_MINUTES || '30', 10);
            const pollIntervalMs = 5000; // Poll every 5 seconds
            const maxWaitMs = maxWaitMinutes * 60 * 1000;
            const startTime = Date.now();

            let allFilesReady = false;
            let attemptCount = 0;
            let initialCheck = true;

            while (!allFilesReady && (Date.now() - startTime) < maxWaitMs) {
              attemptCount++;
              const filesInFolder = await this.lettaClient.listFilesInFolder(folderId);

              if (filesInFolder.length === 0) {
                logger.warn(
                  { folderId, attempt: attemptCount },
                  'No files found in Letta folder - waiting for files to appear'
                );
                await setTimeoutPromise(pollIntervalMs);
                continue;
              }

              // Check embedding status for each file
              const statusCounts = {
                pending: 0,
                parsing: 0,
                embedding: 0,
                completed: 0,
                error: 0,
                unknown: 0
              };

              const filesNotReady: Array<{ name: string; status: string; chunks?: string }> = [];
              const filesWithErrors: Array<{ name: string; error: string }> = [];

              for (const file of filesInFolder) {
                const status = file.processing_status || 'unknown';
                const displayName =
                  (file as any).file_name ||
                  (file as any).original_file_name ||
                  (file as any).name ||
                  'unknown';
                statusCounts[status as keyof typeof statusCounts] = (statusCounts[status as keyof typeof statusCounts] || 0) + 1;

                if (status === 'error') {
                  filesWithErrors.push({
                    name: displayName,
                    error: file.error_message || 'Unknown error'
                  });
                } else if (status !== 'completed' && status !== 'unknown') {
                  const chunksInfo = file.total_chunks && file.chunks_embedded !== undefined
                    ? `${file.chunks_embedded}/${file.total_chunks}`
                    : undefined;
                  filesNotReady.push({
                    name: displayName,
                    status,
                    chunks: chunksInfo
                  });
                }
              }

              if (filesWithErrors.length > 0) {
                logger.error(
                  {
                    folderId,
                    filesWithErrors: filesWithErrors.slice(0, 5),
                    allErrorsLogged: filesWithErrors.length <= 5
                  },
                  'ERROR: Some files failed embedding - evaluation may be affected'
                );
                // Continue anyway - don't block on errors, but log them
              }

              if (filesNotReady.length === 0) {
                allFilesReady = true;
                if (initialCheck) {
                  // All files were already completed - no waiting needed
                  logger.info(
                    {
                      folderId,
                      filesCount: filesInFolder.length,
                      statusCounts
                    },
                    'All files are already completed and ready for semantic search (no wait needed)'
                  );
                } else {
                  // Files completed during our wait
                  logger.info(
                    {
                      folderId,
                      filesCount: filesInFolder.length,
                      statusCounts,
                      waitTimeSeconds: Math.round((Date.now() - startTime) / 1000),
                      attempts: attemptCount
                    },
                    'All files are completed and ready for semantic search'
                  );
                }
              } else {
                const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
                initialCheck = false;

                // Log less frequently to avoid noisy logs: on first check and then every 30 seconds
                if (elapsedSeconds % 30 === 0) {
                  logger.info(
                    {
                      folderId,
                      filesCount: filesInFolder.length,
                      statusCounts,
                      filesNotReadyCount: filesNotReady.length,
                      filesNotReady: filesNotReady.slice(0, 5), // Log first 5 files not ready
                      elapsedSeconds,
                      maxWaitMinutes
                    },
                    `Waiting for file embeddings to complete (${filesNotReady.length} file(s) still processing)`
                  );
                }

                // Wait before next poll
                await setTimeoutPromise(pollIntervalMs);
              }
            }

            if (!allFilesReady) {
              const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
              logger.warn(
                {
                  folderId,
                  elapsedSeconds,
                  maxWaitMinutes
                },
                `WARNING: Timed out waiting for file embeddings (${maxWaitMinutes} minutes) - proceeding with evaluation anyway. Some files may not be searchable yet.`
              );
            }
          } catch (error) {
            logger.warn(
              {
                error: error instanceof Error ? error.message : String(error),
                folderId
              },
              'Failed to check file embedding status (continuing anyway)'
            );
          }
        }
      }
    }

    let agentFilePath: string | undefined;
    let agentFileName = 'agent.af';
    
    if (taskPayload.agent_file_path) {
      logger.debug(
        { taskId: taskPayload.task_id, url: taskPayload.agent_file_path },
        'PrepareFiles: downloading agent file'
      );
      let agentContent = await this.downloadFileWithBackup(
        taskPayload.agent_file_path,
        (taskPayload as any).agent_backup_file_path
      );
      
      // If we have a folder_id, update the agent file to reference it
      if (folderId) {
        try {
          const originalContent = agentContent;
          agentContent = this.updateAgentFileWithFolderId(agentContent, folderId, taskPayload.task_id);
          
          // Verify folder_id was actually set in the agent file
          try {
            const agentData = JSON.parse(agentContent);
            const agent = agentData.agents?.[0];
            if (agent) {
              const hasFolderId = agent.folder_ids?.includes(folderId) || 
                                  agent.source_ids?.some((sid: any) => sid === folderId) ||
                                  agent.sources?.some((src: any) => src.id === folderId);
              
              if (hasFolderId) {
                logger.debug(
                  {
                    taskId: taskPayload.task_id,
                    folderId,
                    folderIds: agent.folder_ids,
                    sourceIds: agent.source_ids,
                    sourcesCount: agent.sources?.length
                  },
                  'Verified folder_id is set in agent file'
                );
              } else {
                logger.warn(
                  {
                    taskId: taskPayload.task_id,
                    folderId,
                    folderIds: agent.folder_ids,
                    sourceIds: agent.source_ids,
                    sourcesCount: agent.sources?.length
                  },
                  'WARNING: folder_id may not be correctly set in agent file - agent may not be able to access files'
                );
              }
            }
          } catch (verifyError) {
            logger.warn(
              { error: verifyError instanceof Error ? verifyError.message : String(verifyError), taskId: taskPayload.task_id },
              'Failed to verify folder_id in updated agent file'
            );
          }
        } catch (error) {
          logger.warn(
            { error: error instanceof Error ? error.message : String(error), taskId: taskPayload.task_id },
            'Failed to update agent file with folder ID (agent file may not be valid JSON or have unexpected structure)'
          );
        }
      } else {
        logger.warn(
          { taskId: taskPayload.task_id },
          'No folder_id available - agent will not have access to filesystem data files'
        );
      }
      
      agentFilePath = path.join(workDir, agentFileName);
      await fs.writeFile(agentFilePath, agentContent, 'utf-8');
      
      // Log where the agent file is and a truncated preview of its contents
      // This helps debug exactly what is being sent to Letta via letta-evals
      const previewLength = 2000; // Prevent logging extremely large files
      const agentPreview = agentContent.substring(0, previewLength);
      
      logger.debug({
        taskId: taskPayload.task_id,
        agentFilePath,
        previewLength: agentContent.length,
        previewTruncated: agentContent.length > previewLength,
        folderId,
        agentPreview
      }, 'PrepareFiles: downloaded agent file (preview)');
    }

    // Download and write dataset
    let datasetPath: string | undefined;
    const dataset = taskPayload.dataset_file_path;

    if (dataset) {
      logger.debug(
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
          logger.debug({ taskId: taskPayload.task_id, datasetPath }, 'PrepareFiles: converting CSV to JSONL');
          finalContent = this.csvToJsonl(datasetContent);
        }
        
        await fs.writeFile(datasetPath, finalContent, 'utf-8');
        try {
          await this.validateDataset(datasetPath);
          logger.debug({ taskId: taskPayload.task_id, datasetPath }, 'PrepareFiles: downloaded and validated dataset file');
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

    // Download and write rubric (required)
    let rubricPath: string | undefined;
    rubricPath = path.join(workDir, 'rubric.txt');
    if (!taskPayload.rubric_file_path) {
      throw new Error(`Rubric file path is required but not provided for task ${taskPayload.task_id}`);
    }
    
    logger.debug({ taskId: taskPayload.task_id, url: taskPayload.rubric_file_path }, 'PrepareFiles: downloading rubric');
    const rubricContent = await this.downloadFileWithBackup(
      taskPayload.rubric_file_path,
      (taskPayload as any).rubric_backup_file_path
    );
    await fs.writeFile(rubricPath, rubricContent, 'utf-8');
    logger.debug({ taskId: taskPayload.task_id, rubricPath }, 'PrepareFiles: downloaded rubric file');

    // Override base_url to use validator's configured Letta server
    let targetBaseUrl: string | undefined;
    if (process.env.LETTA_BASE_URL) {
      targetBaseUrl = process.env.LETTA_BASE_URL.trim().replace(/^["']|["']$/g, '');
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
    logger.debug(
      { taskId: taskPayload.task_id, url: taskPayload.suite_file_path },
      'PrepareFiles: downloading suite.yaml'
    );
    const suiteYamlContent = await this.downloadFileWithBackup(
      taskPayload.suite_file_path,
      (taskPayload as any).suite_backup_file_path
    );
    
    // Validate original suite.yaml can be parsed and dumped back correctly
    // This helps catch corruption issues before we modify it
    let suiteConfig: any;
    try {
      suiteConfig = yaml.load(suiteYamlContent) as any;
      
      // Minimal logging: just log top-level keys to avoid large payloads
      logger.debug(
        {
          taskId: taskPayload.task_id,
          parsedSuiteConfigKeys: Object.keys(suiteConfig || {}),
        },
        'Parsed suite.yaml config'
      );
      
      // Test that we can dump and reload the original config without corruption
      const testDump = yaml.dump(suiteConfig, {
        lineWidth: -1,
        quotingType: '"' as const,
        sortKeys: false,
      });
      const testReload = yaml.load(testDump);
      if (!testReload) {
        throw new Error('Original suite.yaml cannot be round-tripped: dump->load returns null');
      }
      // No detailed logging for round-trip dump to avoid large logs
    } catch (parseError) {
      logger.error(
        {
          taskId: taskPayload.task_id,
          error: parseError instanceof Error ? parseError.message : String(parseError),
          errorStack: parseError instanceof Error ? parseError.stack : undefined,
          suiteYamlLength: suiteYamlContent.length,
        },
        'Failed to parse or validate suite.yaml file'
      );
      throw new Error(`Failed to parse suite.yaml: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }
    
    if (!suiteConfig) {
      logger.error(
        {
          taskId: taskPayload.task_id,
        },
        'Parsed suite.yaml is null or undefined'
      );
      throw new Error('Failed to parse provided suite.yaml file: result is null/undefined');
    }
    
    // Instead of parsing and re-dumping (which loses comments and formatting),
    // use string replacement to preserve the original YAML structure exactly.
    // This avoids potential issues with letta-evals expecting specific formatting.
    let updatedYamlContent: string = suiteYamlContent;
    
    // Update dataset path using string replacement
    if (datasetPath) {
      const datasetBasename = path.basename(datasetPath);
      // Replace dataset: ... with dataset: <basename>
      updatedYamlContent = updatedYamlContent.replace(
        /^dataset:\s*.+$/m,
        `dataset: ${datasetBasename}`
      );
    }
    
    // Update target.base_url using string replacement
    if (targetBaseUrl) {
      // Replace base_url: ... with base_url: <targetBaseUrl>
      // Use a more specific regex that matches the exact indentation pattern
      const beforeReplace = updatedYamlContent;
      updatedYamlContent = updatedYamlContent.replace(
        /^(\s+base_url:\s*).+$/m,
        `$1${targetBaseUrl}`
      );
      
      // Log if replacement didn't work (small, no full content)
      if (beforeReplace === updatedYamlContent) {
        logger.warn(
          {
            taskId: taskPayload.task_id,
            targetBaseUrl,
          },
          'base_url replacement did not match any line - base_url may not exist in suite.yaml'
        );
      }
    }
    
    // Update target.agent_file using string replacement
    if (agentFilePath) {
      const agentBasename = path.basename(agentFilePath);
      // Replace agent_file: ... with agent_file: <basename>
      updatedYamlContent = updatedYamlContent.replace(
        /^(\s+agent_file:\s*).+$/m,
        `$1${agentBasename}`
      );
    }
    
    logger.debug(
      {
        taskId: taskPayload.task_id,
        modifications: {
          datasetPath: datasetPath ? path.basename(datasetPath) : 'unchanged',
          targetBaseUrl: targetBaseUrl || 'unchanged',
          agentFile: agentFilePath ? path.basename(agentFilePath) : 'unchanged',
        },
      },
      'Modified suite.yaml using string replacement'
    );
    
    // Validate the updated YAML can still be parsed
    try {
      const validationCheck = yaml.load(updatedYamlContent);
      if (!validationCheck) {
        throw new Error('Updated YAML validation failed: parsed result is null/undefined');
      }
      // Minimal debug log for successful validation
      logger.debug(
        {
          taskId: taskPayload.task_id,
          reloadedConfigKeys: Object.keys(validationCheck || {}),
        },
        'Updated YAML validation passed'
      );
    } catch (validationError) {
      logger.error(
        {
          taskId: taskPayload.task_id,
          error: validationError instanceof Error ? validationError.message : String(validationError),
          errorStack: validationError instanceof Error ? validationError.stack : undefined,
            updatedYamlLength: updatedYamlContent.length,
        },
        'Failed to validate updated YAML - using original content as fallback'
      );
      // Fallback: use original content if validation fails
      updatedYamlContent = suiteYamlContent;
      logger.warn(
        { taskId: taskPayload.task_id },
        'Used original suite.yaml content due to validation failure'
      );
    }
    
    await fs.writeFile(suitePath, updatedYamlContent, 'utf-8');
    
    // Verify the file was written correctly by reading it back (no large previews)
    const writtenContent = await fs.readFile(suitePath, 'utf-8');
    if (writtenContent !== updatedYamlContent) {
      logger.error(
        {
          taskId: taskPayload.task_id,
          expectedLength: updatedYamlContent.length,
          writtenLength: writtenContent.length,
        },
        'Written suite.yaml content does not match expected content'
      );
    }
    
    logger.debug({
      taskId: taskPayload.task_id,
      suitePath,
      targetBaseUrl,
      agentFilePath: agentFilePath ? path.basename(agentFilePath) : undefined,
      datasetPath: datasetPath ? path.basename(datasetPath) : undefined,
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

    // Track agents and folders before evaluation to clean them up afterward
    let agentsBeforeEvaluation: Set<string> = new Set();
    let foldersBeforeEvaluation: Set<string> = new Set();
    if (this.lettaClient) {
      try {
        const agentsBefore = await this.lettaClient.listAgents();
        agentsBeforeEvaluation = new Set(agentsBefore.map(a => a.id));
        logger.debug(
          { agentCount: agentsBeforeEvaluation.size },
          'Tracked agents before evaluation for cleanup'
        );
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Failed to list agents before evaluation (cleanup may be incomplete)'
        );
      }
      
      try {
        const foldersBefore = await this.lettaClient.listFolders();
        foldersBeforeEvaluation = new Set(foldersBefore.map(f => f.id));
        logger.debug(
          { folderCount: foldersBeforeEvaluation.size },
          'Tracked folders before evaluation for cleanup'
        );
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Failed to list folders before evaluation (cleanup may be incomplete)'
        );
      }
    }

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
    logger.debug({ validateCmd, cwd: suiteDir }, 'Validating suite.yaml');
    
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
      logger.debug('Suite validation passed');
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

    // Now run the evaluation using wrapper script
    const cmd = `${pythonCmd} /app/python/run_with_graders.py run "${suiteFile}" --output "${outputDir}"`;
    logger.info({ cmd, cwd: suiteDir, outputDir }, 'Running letta-evals');

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
      // GitHub token for authenticated API requests (higher rate limits)
      if (process.env.GITHUB_TOKEN) {
        env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
      }
      // Max steps for agent tool calls (limits number of steps per evaluation)
      if (process.env.MAX_STEPS) {
        env.MAX_STEPS = process.env.MAX_STEPS;
      }
      // Letta - only support hosted instances
      if (process.env.LETTA_BASE_URL) {
        // Strip quotes if present (common when set in docker-compose or shell scripts)
        env.LETTA_BASE_URL = process.env.LETTA_BASE_URL.trim().replace(/^["']|["']$/g, '');
      } else if (process.env.LETTA_URL) {
        // Strip quotes if present
        env.LETTA_BASE_URL = process.env.LETTA_URL.trim().replace(/^["']|["']$/g, '');
      }

      // Log the exact command and environment for debugging
      console.log('\n' + '='.repeat(80));
      console.log('LETTA-EVALS COMMAND:');
      console.log('='.repeat(80));
      console.log(`Command: ${cmd}`);
      console.log(`Working Directory: ${suiteDir}`);
      console.log(`Output Directory: ${outputDir}`);
      console.log(`Suite File: ${suiteFile}`);
      console.log('\nEnvironment Variables (keys only, values hidden for security):');
      const envKeys = Object.keys(env).sort();
      for (const key of envKeys) {
        const value = env[key];
        // Show if set (but not the actual value for API keys)
        if (key.includes('API_KEY') || key.includes('SECRET') || key.includes('PASSWORD') || key.includes('TOKEN')) {
          console.log(`  ${key}=***SET*** (${value ? value.length : 0} chars)`);
        } else if (key === 'PATH') {
          console.log(`  ${key}=${value}`);
        } else {
          // For other vars, show first 50 chars if not sensitive
          const preview = value && value.length > 50 ? value.substring(0, 50) + '...' : value;
          console.log(`  ${key}=${preview}`);
        }
      }
      console.log('='.repeat(80) + '\n');

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
              baseUrl: process.env.LETTA_BASE_URL || '(not set)',
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
              baseUrl: process.env.LETTA_BASE_URL || '(not set)',
              hasLettaBaseUrl: !!process.env.LETTA_BASE_URL,
              stderr: stderr.substring(0, 500), // First 500 chars
            },
            'Detected 403 Forbidden error - check Letta server permissions/authentication'
          );
        }
      }

      const duration = (Date.now() - startTime) / 1000;

      // Clean up agents created during evaluation
      if (this.lettaClient && agentsBeforeEvaluation.size >= 0) {
        try {
          const agentsAfter = await this.lettaClient.listAgents();
          const agentsAfterSet = new Set(agentsAfter.map(a => a.id));
          
          // Find agents that were created during evaluation
          const agentsToDelete = Array.from(agentsAfterSet).filter(
            agentId => !agentsBeforeEvaluation.has(agentId)
          );

          if (agentsToDelete.length > 0) {
            logger.debug(
              { agentCount: agentsToDelete.length, agentIds: agentsToDelete },
              'Cleaning up agents created during evaluation'
            );

            let deletedCount = 0;
            let failedCount = 0;
            for (const agentId of agentsToDelete) {
              try {
                await this.lettaClient.deleteAgent(agentId);
                deletedCount++;
              } catch (error) {
                failedCount++;
                logger.warn(
                  { 
                    error: error instanceof Error ? error.message : String(error),
                    agentId 
                  },
                  'Failed to delete agent created during evaluation (non-fatal)'
                );
              }
            }

            logger.debug(
              { 
                totalCreated: agentsToDelete.length,
                deleted: deletedCount,
                failed: failedCount
              },
              'Completed cleanup of agents created during evaluation'
            );
          } else {
            logger.debug('No new agents created during evaluation');
          }
        } catch (error) {
            logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Failed to clean up agents created during evaluation (non-fatal)'
          );
        }
      }

      // Clean up folders created during evaluation (e.g., company_policy_data_* folders)
      if (this.lettaClient && foldersBeforeEvaluation.size >= 0) {
        try {
          const foldersAfter = await this.lettaClient.listFolders();
          const foldersAfterSet = new Set(foldersAfter.map(f => f.id));
          
          // Find folders that were created during evaluation
          const foldersToDelete = foldersAfter.filter(
            folder => {
              // Only delete folders that:
              // 1. Were created during evaluation (not in before set)
              // 2. Are company_policy_data_* folders (with hash suffixes)
              // 3. Or exact match company_policy_data folder (if it was created during evaluation)
              const wasCreatedDuringEvaluation = !foldersBeforeEvaluation.has(folder.id);
              const isCompanyPolicyData = folder.name === 'company_policy_data' || folder.name.startsWith('company_policy_data_');
              
              return wasCreatedDuringEvaluation && isCompanyPolicyData;
            }
          );

          if (foldersToDelete.length > 0) {
            logger.debug(
              { 
                folderCount: foldersToDelete.length, 
                folderNames: foldersToDelete.map(f => f.name),
                folderIds: foldersToDelete.map(f => f.id)
              },
              'Cleaning up folders created during evaluation'
            );

            let deletedCount = 0;
            let failedCount = 0;
            for (const folder of foldersToDelete) {
              try {
                await this.lettaClient.deleteFolder(folder.id);
                deletedCount++;
              } catch (error) {
                failedCount++;
                logger.warn(
                  { 
                    error: error instanceof Error ? error.message : String(error),
                    folderId: folder.id,
                    folderName: folder.name
                  },
                  'Failed to delete folder created during evaluation (non-fatal)'
                );
              }
            }

            logger.debug(
              { 
                totalCreated: foldersToDelete.length,
                deleted: deletedCount,
                failed: failedCount
              },
              'Completed cleanup of folders created during evaluation'
            );
          } else {
            logger.debug('No new company_policy_data folders created during evaluation');
          }
        } catch (error) {
          logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Failed to clean up folders created during evaluation (non-fatal)'
          );
        }
      }

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

      // Save full raw evaluation output to disk for debugging/inspection
      // This is the same structure we upload via ApiClient.uploadRawOutput.
      const rawOutputPath = path.join(outputDir, 'raw_evaluation.json');
      try {
        await fs.writeFile(
          rawOutputPath,
          JSON.stringify(
            {
              summary: processedSummary,
              results: processedResults,
              artifacts,
              duration_seconds: duration,
            },
            null,
            2,
          ),
          'utf-8',
        );
        logger.info({ rawOutputPath }, 'Saved raw evaluation output to file');
      } catch (writeError) {
        logger.warn(
          {
            rawOutputPath,
            error:
              writeError instanceof Error
                ? writeError.message
                : String(writeError),
          },
          'Failed to save raw evaluation output to file',
        );
      }

      return {
        summary: processedSummary,
        results: processedResults,
        artifacts,
        duration_seconds: duration,
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
          console.log(`│  Score: ${weightedScore.toFixed(5)} (weighted avg)`);
          weightedScores.push(weightedScore);
        } else if (grades && Object.keys(grades).length > 0) {
          // Fallback: calculate simple average if weights not available
          const scores = Object.values(grades)
            .map(g => (g as { score?: number })?.score)
            .filter((s): s is number => typeof s === 'number');
          if (scores.length > 0) {
            const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;
            console.log(`│  Score: ${avgScore.toFixed(5)} (avg)`);
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
              console.log(`│    • ${graderName}: ${graderScore.toFixed(5)}`);
              
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
        console.log(`│  Calculated Avg (from weighted scores): ${calculatedAvg.toFixed(5)}`);
      }
      
      if (metrics) {
        if (metrics.avg_score_total !== undefined) {
          const lettaAvg = metrics.avg_score_total;
          console.log(`│  AETS avg_score_total: ${lettaAvg.toFixed(5)}`);
          
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
          console.log(`│  Avg Score (Attempted): ${metrics.avg_score_attempted.toFixed(5)}`);
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
                  const totalStr = total !== undefined ? total.toFixed(5) : 'N/A';
                  const attemptedStr = attempted !== undefined ? attempted.toFixed(5) : 'N/A';
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

