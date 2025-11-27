/**
 * Type definitions for validator client
 */

export interface ValidatorConfig {
  mnemonic: string; // Required: mnemonic phrase for key pair
  apiUrl: string; // API base URL
  displayName?: string;
  version?: string;
  capacity?: Record<string, unknown>;
  pollInterval?: number; // Poll interval in seconds (default: 5)
  heartbeatInterval?: number; // Heartbeat interval in seconds (default: 30)
  maxRetries?: number; // Max retries for failed requests (default: 3)
  retryDelay?: number; // Delay between retries in ms (default: 1000)
  logLevel?: string; // Log level (default: 'info')
}

export interface Task {
  id: string;
  brief_id: string;
  evaluator_id?: string;
  task_payload: {
    task_id: string;
    agent_file?: string; // URL, base64 encoded, or base64: prefixed string
    dataset?: string; // URL, base64 encoded dataset file, or base64: prefixed string (also in suite_config.dataset)
    suite_config: {
      name: string;
      dataset?: string; // URL, base64 encoded dataset file, or base64: prefixed string (also at top level)
      max_samples?: number;
      target: {
        kind: string;
        agent_file?: string;
        base_url?: string;
      };
      graders: Record<string, unknown>;
      gate?: {
        metric_key: string;
        op: string;
        value: number;
      };
    };
    suite_yaml?: string; // URL, base64 encoded suite.yaml file, or base64: prefixed string (optional, if provided will be used instead of generating from suite_config)
    rubric?: string; // URL, base64 encoded, or base64: prefixed string
    priority: number;
    metadata?: Record<string, unknown>;
  };
  status: string;
  created_at: string;
}

export interface TaskResponse {
  tasks: Task[];
  count: number;
}

export interface RegistrationResponse {
  evaluator_id: string;
  hotkey: string;
  display_name?: string;
  version?: string;
  last_seen_at: string;
}

export interface ClaimResponse {
  task_id: string;
  status: string;
  message: string;
}

export interface ResultResponse {
  task_id: string;
  status: string;
  message: string;
}

