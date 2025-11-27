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
    
    // Log the dataset field to see what we're receiving
    if (taskPayload.suite_config?.dataset) {
      // Check top-level dataset first, then fall back to suite_config.dataset
      const dataset = (taskPayload as any).dataset || taskPayload.suite_config.dataset;
      logger.info(
        {
          taskId: task.id,
          datasetType: typeof dataset,
          datasetIsString: typeof dataset === 'string',
          datasetStartsWith: typeof dataset === 'string' ? dataset.substring(0, 50) : 'not a string',
          datasetLength: typeof dataset === 'string' ? dataset.length : 0,
          hasBase64Prefix: typeof dataset === 'string' && dataset.startsWith('base64:')
        },
        'Received dataset in task payload'
      );
    }

    logger.info(
      { 
        taskId, 
        briefId: task.brief_id,
        status: task.status,
        suiteName: taskPayload.suite_config.name
      },
      'Starting task processing'
    );

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

      // Step 4: Submit results (idempotent - can submit multiple times)
      logger.info({ taskId }, 'Submitting evaluation results');

      await this.apiClient.submitResults(taskId, 'completed', {
        summary: evaluationResult.summary,
        results: evaluationResult.results,
        artifacts: evaluationResult.artifacts,
        duration_seconds: evaluationResult.duration_seconds,
        timestamp: new Date().toISOString()
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
      // Cleanup: remove temp files
      try {
        const taskWorkDir = path.join(this.workDir, taskId);
        await this.cleanup(taskWorkDir);
      } catch (cleanupError) {
        logger.warn(
          { taskId, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) },
          'Failed to cleanup task files'
        );
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
  private async downloadFile(urlOrBase64: string): Promise<string> {
    if (urlOrBase64.startsWith('http://') || urlOrBase64.startsWith('https://')) {
      const response = await fetch(urlOrBase64);
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
      }
      const content = await response.text();
      
      // LOG THE RAW DOWNLOADED CONTENT
      const firstLine = content.split('\n')[0];
      logger.info({
        url: urlOrBase64,
        contentLength: content.length,
        firstLineLength: firstLine?.length,
        firstLineRaw: firstLine?.substring(0, 300),
        firstLineStartsWith: firstLine?.substring(0, 50)
      }, 'Downloaded file from URL - RAW content');
      
      // Try parsing if it looks like JSON
      if (firstLine?.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(firstLine.trim());
          logger.info({
            parsedType: typeof parsed,
            hasInput: typeof parsed === 'object' && 'input' in parsed,
            keys: typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : 'N/A'
          }, 'First line parsed successfully');
        } catch (e) {
          logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Could not parse first line');
        }
      }
      
      return content;
    } else if (urlOrBase64.startsWith('base64:')) {
      const base64Data = urlOrBase64.substring(7);
      const content = Buffer.from(base64Data, 'base64').toString('utf-8');
      
      // LOG THE DECODED CONTENT
      const firstLine = content.split('\n')[0];
      logger.info({
        base64Length: base64Data.length,
        contentLength: content.length,
        firstLineRaw: firstLine?.substring(0, 300)
      }, 'Decoded file from base64');
      
      return content;
    } else {
      return Buffer.from(urlOrBase64, 'base64').toString('utf-8');
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
    let agentFilePath: string | undefined;
    let agentFileName = 'agent.af';
    
    if (taskPayload.agent_file) {
      const agentContent = await this.downloadFile(taskPayload.agent_file);
      agentFilePath = path.join(workDir, agentFileName);
      await fs.writeFile(agentFilePath, agentContent, 'utf-8');
      logger.info({ agentFilePath }, 'Downloaded agent file');
    }

    // Download and write dataset
    let datasetPath: string | undefined;
    const dataset = (taskPayload as any).dataset || taskPayload.suite_config.dataset;
    
    if (dataset) {
      if (dataset.startsWith('http://') || dataset.startsWith('https://') || dataset.startsWith('base64:')) {
        // Download from URL or decode from base64
        const datasetContent = await this.downloadFile(dataset);

        // LOG BEFORE CSV CHECK
        logger.info({
          contentLength: datasetContent.length,
          firstLineRaw: datasetContent.split('\n')[0]?.substring(0, 300),
          isCsv: this.isCsvContent(datasetContent)
        }, 'Dataset content BEFORE CSV conversion');

        datasetPath = path.join(workDir, 'dataset.jsonl');
        
        // Convert CSV to JSONL if needed
        let finalContent = datasetContent;
        if (this.isCsvContent(datasetContent)) {
          finalContent = this.csvToJsonl(datasetContent);
        }

        // LOG BEFORE WRITE
        logger.info({
          finalContentLength: finalContent.length,
          firstLineRaw: finalContent.split('\n')[0]?.substring(0, 300)
        }, 'About to write dataset file');
        
        await fs.writeFile(datasetPath, finalContent, 'utf-8');
        try {
          await this.validateDataset(datasetPath);
          logger.info({ datasetPath }, 'Downloaded and validated dataset file');
        } catch (error) {
          // Re-throw with more context
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error({ datasetPath, error: errorMessage, firstLine: finalContent.split('\n')[0]?.substring(0, 200) }, 'Dataset validation failed');
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
    if (taskPayload.rubric) {
      const rubricContent = await this.downloadFile(taskPayload.rubric);
      await fs.writeFile(rubricPath, rubricContent, 'utf-8');
      logger.info({ rubricPath }, 'Downloaded rubric file');
    } else {
      await fs.writeFile(rubricPath, defaultRubric, 'utf-8');
      logger.info({ rubricPath }, 'Created default rubric file');
    }

    // Add default grader if missing (required by letta-evals)
    let graders = taskPayload.suite_config.graders;
    if (!graders || 
        typeof graders !== 'object' ||
        Object.keys(graders).length === 0) {
      logger.info('No graders provided, adding default model_judge grader');
      graders = {
        quality: {
          kind: 'model_judge',
          display_name: 'Quality Score',
          extractor: 'last_assistant',
          prompt_path: 'rubric.txt',
        },
      };
    }

    // Add default gate if missing (required by letta-evals)
    // Use the first grader's key as the metric_key
    const firstGraderKey = Object.keys(graders)[0] || 'quality';
    const gate = taskPayload.suite_config.gate || {
      metric_key: firstGraderKey,
      op: 'gte',
      value: 0.0, // Default to passing all (no minimum threshold)
    };

    // Override base_url to use validator's configured Letta server
    let targetBaseUrl: string | undefined;
    if (process.env.LETTA_BASE_URL) {
      targetBaseUrl = process.env.LETTA_BASE_URL.trim().replace(/^["']|["']$/g, '');
    } else if (process.env.LETTA_API_KEY) {
      targetBaseUrl = 'https://api.letta.com';
    } else {
      targetBaseUrl = taskPayload.suite_config.target.base_url;
    }
    
    if (targetBaseUrl && !targetBaseUrl.startsWith('http://') && !targetBaseUrl.startsWith('https://')) {
      throw new Error(`Invalid base_url: "${targetBaseUrl}" - must start with http:// or https://`);
    }

    // Create suite.yaml - use provided suite_yaml if available, otherwise generate from suite_config
    const suitePath = path.join(workDir, 'suite.yaml');
    
    if (taskPayload.suite_yaml && typeof taskPayload.suite_yaml === 'string') {
      // Use provided suite.yaml file, but override base_url and ensure dataset path is correct
      const suiteYamlContent = await this.downloadFile(taskPayload.suite_yaml);
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
      logger.info({ suitePath }, 'Updated provided suite.yaml');
    } else {
      // Generate suite.yaml from suite_config
      const suiteConfig = {
        name: taskPayload.suite_config.name,
        dataset: datasetPath ? path.basename(datasetPath) : taskPayload.suite_config.dataset,
        max_samples: taskPayload.suite_config.max_samples,
        target: {
          ...taskPayload.suite_config.target,
          ...(agentFilePath ? { agent_file: path.basename(agentFilePath) } : {}),
          ...(targetBaseUrl ? { base_url: targetBaseUrl } : {})
        },
        graders,
        gate,
      };

      // Add rubric path to graders if rubric file exists
      if (rubricPath && suiteConfig.graders) {
        for (const [key, grader] of Object.entries(suiteConfig.graders)) {
          if (typeof grader === 'object' && grader !== null && 'kind' in grader) {
            const graderObj = grader as any;
            if (graderObj.kind === 'model_judge' && !graderObj.prompt_path) {
              graderObj.prompt_path = 'rubric.txt';
            }
          }
        }
      }

      const suiteYaml = this.generateSuiteYaml(suiteConfig);
      await fs.writeFile(suitePath, suiteYaml, 'utf-8');
      logger.info({ suitePath }, 'Generated suite.yaml');
    }

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
  private generateSuiteYaml(config: any): string {
    // Build YAML object
    const yamlObj: any = {
      name: config.name
    };

    if (config.dataset) {
      // Use relative path if it's a local file
      yamlObj.dataset = typeof config.dataset === 'string' && 
        (config.dataset.startsWith('http://') || config.dataset.startsWith('https://') || config.dataset.includes('/'))
        ? config.dataset
        : 'dataset.jsonl';
    }

    yamlObj.graders_module = 'grader_lib.py';

    if (config.max_samples) {
      yamlObj.max_samples = config.max_samples;
    }

    // Transform target kind: 'agent' -> 'letta_agent' for compatibility
    let targetKind = config.target.kind;
    if (targetKind === 'agent') {
      targetKind = 'letta_agent';
    }

    yamlObj.target = {
      kind: targetKind
    };

    if (config.target.agent_file) {
      yamlObj.target.agent_file = config.target.agent_file;
    }
    if (config.target.base_url) {
      yamlObj.target.base_url = config.target.base_url;
    }

    // Graders are required by letta-evals (should already be set by prepareFiles, but double-check)
    if (!config.graders || Object.keys(config.graders).length === 0) {
      throw new Error('Suite config must define at least one grader (this should not happen - default grader should have been added)');
    }
    yamlObj.graders = config.graders;

    // Gate should always be present (set in prepareFiles)
    // Add kind and aggregation for letta-evals format
    if (config.gate) {
      yamlObj.gate = {
        kind: 'simple',
        aggregation: 'avg_score',
        ...config.gate, // metric_key, op, value from config
      };
    } else {
      // Fallback (should not happen, but just in case)
      const firstGraderKey = config.graders && Object.keys(config.graders).length > 0
        ? Object.keys(config.graders)[0]
        : 'quality';
      
      yamlObj.gate = {
        kind: 'simple',
        metric_key: firstGraderKey,
        aggregation: 'avg_score',
        op: 'gte',
        value: 0.0,
      };
    }

    return yaml.dump(yamlObj, { 
      lineWidth: -1, // No line wrapping
      quotingType: '"',
      forceQuotes: false,
      noRefs: true,
      sortKeys: false
    });
  }

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
          logger.info(
            { datasetPath, size: stats.size, suiteDataset: suiteConfig.dataset },
            'Dataset file verified before running letta-evals'
          );
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
    
    // Now run the evaluation
    const cmd = `${pythonCmd} -m ${cliModule} run "${suiteFile}" --output "${outputDir}"`;
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
      if (stdout) {
        logger.info({ stdout }, 'letta-evals stdout output');
      }

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
        
        // Process grade score
        const grade = resultData.grade as { score?: number; [key: string]: unknown } | undefined;
        if (grade && typeof grade.score === 'number') {
          grade.score = roundScore(grade.score)!;
        }
        
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
        
        const gradeMetadata = grade?.metadata as { usage?: { total_tokens?: number } } | undefined;
        
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
        
        // Add grading tokens
        // Note: grade and grades.quality may reference the same grading operation,
        // so we count graders first, then only use grade if no graders exist
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
        
        // If no graders or no tokens from graders, use grade tokens
        // (grade is typically an aggregate, so we prefer individual grader counts)
        if (gradingTokens === 0 && gradeMetadata?.usage?.total_tokens) {
          gradingTokens = gradeMetadata.usage.total_tokens;
        }
        
        totalTokens += gradingTokens;
        
        // Calculate token per score point
        const score = grade?.score ?? 0;
        const tokenPerScorePoint = score > 0 ? totalTokens / score : undefined;
        
        // Add performance key
        resultData.performance = {
          total_tokens: totalTokens,
          av_tokens: totalTokens, // Average tokens per sample (this is the total for this sample)
          token_per_score_point: tokenPerScorePoint !== undefined ? roundScore(tokenPerScorePoint) : undefined,
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
          if (typeof processedMetrics.avg_score_total === 'number') {
            processedMetrics.avg_score_total = roundScore(processedMetrics.avg_score_total)!;
          }
          
          // Round avg_score_attempted
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
   * Clean up MCP servers to prevent duplicate key errors on next run
   */
  private async cleanupMcpServers(workDir: string): Promise<void> {
    try {
      logger.info({ workDir }, 'Cleaning up MCP servers from Letta');
      
      const cleanupScript = `
from letta import create_client
client = create_client()
servers = client.list_mcp_servers()
for server in servers:
    try:
        client.delete_mcp_server(server.id)
        print(f"Deleted MCP server: {server.server_name}")
    except Exception as e:
        print(f"Failed to delete {server.server_name}: {e}")
`;
      
      const cleanupScriptPath = path.join(workDir, 'cleanup_mcp.py');
      await fs.writeFile(cleanupScriptPath, cleanupScript, 'utf-8');
      
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
      
      const { stdout, stderr } = await execAsync('python3 cleanup_mcp.py', { 
        cwd: workDir,
        env,
        maxBuffer: 1024 * 1024 // 1MB buffer
      });
      
      if (stdout) {
        logger.info({ stdout }, 'MCP cleanup output');
      }
      if (stderr) {
        logger.warn({ stderr }, 'MCP cleanup warnings');
      }
      
      // Clean up the script file
      try {
        await fs.unlink(cleanupScriptPath);
      } catch {
        // Ignore cleanup errors
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

