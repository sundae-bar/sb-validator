/**
 * Type definitions for validator client
 */

// Machine-readable failure cause sent alongside the human-readable error message.
export type TaskFailureReason =
  | 'evaluator_unreachable'
  | 'evaluator_timeout'
  | 'evaluator_error'
  | 'coordinator_error'
  | 'internal_error';

export interface ValidatorConfig {
  mnemonic: string; // Required: mnemonic phrase for key pair
  apiUrl: string; // API base URL
  displayName?: string;
  version?: string;
  capacity?: Record<string, unknown>;
  pollInterval?: number; // Poll interval in seconds (default: 5)
  heartbeatInterval?: number; // Heartbeat interval in seconds (default: 30)
  weightsInterval?: number; // Bittensor weights fetch interval in minutes (default: 30)
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
    dataset_file_path?: string; // URL, base64 encoded dataset file, or base64: prefixed string
    suite_file_path: string; // URL, base64 encoded suite.yaml file, or base64: prefixed string (required)
    rubric_file_path?: string; // URL, base64 encoded, or base64: prefixed string
    skill_file_path?: string; // URL to SKILL.md; absent only on stale tasks from the removed agent track
    skill_backup_file_path?: string; // Backup URL for SKILL.md
    priority?: number;
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
