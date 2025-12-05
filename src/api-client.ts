/**
 * Secure API client with retry logic and signature authentication
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import type { KeyringPair } from '@polkadot/keyring/types';
import { signRequest, getHotkey } from './signature';
import { retry, retryWithCondition } from './retry';
import logger from './logger';
import type {
  TaskResponse,
  RegistrationResponse,
  ClaimResponse,
  ResultResponse
} from './types';

export class ApiClient {
  private client: AxiosInstance;
  private pair: KeyringPair;
  private hotkey: string;
  private apiUrl: string;
  private maxRetries: number;
  private retryDelay: number;

  constructor(
    pair: KeyringPair,
    apiUrl: string,
    maxRetries: number = 3,
    retryDelay: number = 1000
  ) {
    this.pair = pair;
    this.hotkey = getHotkey(pair);
    
    // Handle API_URL that might include the full path (e.g., http://localhost:3002/api/v2/validators)
    // or just the base URL (e.g., http://localhost:3002)
    let baseUrl = apiUrl.replace(/\/$/, ''); // Remove trailing slash
    
    // If API_URL already includes /api/v2/validators, use it as-is
    // Otherwise, we'll append the path in each method
    this.apiUrl = baseUrl;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;

    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        logger.debug({ method: config.method, url: config.url }, 'API request');
        return config;
      },
      (error) => {
        logger.error({ error: error.message }, 'Request interceptor error');
        return Promise.reject(error);
      }
    );

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => {
        logger.debug(
          { status: response.status, url: response.config.url },
          'API response'
        );
        return response;
      },
      (error: AxiosError) => {
        const status = error.response?.status;
        const message = error.response?.data || error.message;
        logger.error(
          { status, url: error.config?.url, message },
          'API error'
        );
        return Promise.reject(error);
      }
    );
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: Error): boolean {
    // Network errors, timeouts, and 5xx errors are retryable
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (!status) {
        // Network error or timeout
        return true;
      }
      // Retry on 5xx errors, rate limits (429), and some 4xx errors
      return status >= 500 || status === 429 || status === 408;
    }
    return false;
  }

  /**
   * Get the full API path, handling both base URL and full URL cases
   * 
   * If API_URL includes /api/v2/validators (e.g., http://localhost:3002/api/v2/validators),
   * then baseURL is already set correctly and we use relative paths like /register.
   * 
   * If API_URL is just the base (e.g., http://localhost:3002),
   * then we prepend /api/v2/validators to the path.
   */
  private getApiPath(endpoint: string): string {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    
    // If API_URL already includes /api/v2/validators, use endpoint as-is (relative to baseURL)
    if (this.apiUrl.includes('/api/v2/validators')) {
      return cleanEndpoint;
    }
    
    // Otherwise, prepend /api/v2/validators
    return `/api/v2/validators${cleanEndpoint}`;
  }

  /**
   * Make a signed request
   */
  private async signedRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    payload?: object
  ): Promise<T> {
    const url = this.getApiPath(path);
    let signature: string | undefined;
    let body: any = payload;

    // Sign the request if there's a payload
    if (payload) {
      signature = signRequest(this.pair, payload);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (signature) {
      headers['X-Signature'] = signature;
    }

    const makeRequest = async () => {
      const response = await this.client.request<T>({
        method,
        url,
        data: body,
        headers
      });
      return response.data;
    };

    return retryWithCondition(
      makeRequest,
      this.isRetryableError.bind(this),
      {
        maxRetries: this.maxRetries,
        retryDelay: this.retryDelay
      }
    );
  }

  /**
   * Register evaluator
   */
  async register(
    displayName?: string,
    version?: string,
    capacity?: Record<string, unknown>
  ): Promise<RegistrationResponse> {
    logger.info({ hotkey: this.hotkey, displayName }, 'Registering evaluator');

    const payload = {
      hotkey: this.hotkey,
      display_name: displayName,
      version: version || '1.0.0',
      capacity: capacity || {}
    };

    try {
      const response = await this.signedRequest<RegistrationResponse>(
        'POST',
        '/register',
        payload
      );

      logger.info(
        { evaluatorId: response.evaluator_id, hotkey: response.hotkey },
        'Successfully registered evaluator'
      );

      return response;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to register evaluator'
      );
      throw error;
    }
  }

  /**
   * Send heartbeat
   */
  async heartbeat(version?: string, capacity?: Record<string, unknown>): Promise<void> {
    logger.debug({ hotkey: this.hotkey }, 'Sending heartbeat');

    const payload = {
      hotkey: this.hotkey,
      version: version || '1.0.0',
      capacity: capacity || {}
    };

    try {
      await this.signedRequest('POST', '/heartbeat', payload);
      logger.debug({ hotkey: this.hotkey }, 'Heartbeat sent successfully');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to send heartbeat'
      );
      throw error;
    }
  }

  /**
   * Poll for tasks
   */
  async pollTasks(status: string = 'queued', limit: number = 10): Promise<TaskResponse> {
    logger.info({ hotkey: this.hotkey, status, limit }, 'Polling for tasks');

    try {
      const response = await this.client.get<TaskResponse>(this.getApiPath('/tasks'), {
        params: {
          hotkey: this.hotkey,
          status,
          limit
        }
      });

      logger.info(
        { count: response.data.count, status, taskIds: response.data.tasks?.map(t => t.id) || [] },
        'Fetched tasks'
      );

      return response.data;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to poll tasks'
      );
      throw error;
    }
  }

  /**
   * Claim a task
   */
  async claimTask(taskId: string): Promise<ClaimResponse> {
    logger.info({ taskId, hotkey: this.hotkey }, 'Claiming task');

    const payload = {
      hotkey: this.hotkey
    };

    try {
      const response = await this.signedRequest<ClaimResponse>(
        'POST',
        `/tasks/${taskId}/claim`,
        payload
      );

      logger.info({ taskId, status: response.status }, 'Task claimed successfully');
      return response;
    } catch (error) {
      logger.error(
        { taskId, error: error instanceof Error ? error.message : String(error) },
        'Failed to claim task'
      );
      throw error;
    }
  }

  /**
   * Submit task results
   */
  async submitResults(
    taskId: string,
    status: 'completed' | 'failed',
    resultData: Record<string, unknown>,
    errorMessage?: string
  ): Promise<ResultResponse> {
    logger.info(
      { 
        taskId, 
        hotkey: this.hotkey, 
        status,
        hasSummary: !!resultData.summary,
        hasResults: !!resultData.results,
        resultsCount: Array.isArray(resultData.results) ? resultData.results.length : 0,
        errorMessage: errorMessage || undefined
      }, 
      'Submitting task results'
    );

    const payload = {
      hotkey: this.hotkey,
      status,
      result_data: resultData,
      ...(errorMessage ? { error_message: errorMessage } : {})
    };

    try {
      const response = await this.signedRequest<ResultResponse>(
        'POST',
        `/tasks/${taskId}/result`,
        payload
      );

      logger.info({ taskId, status: response.status }, 'Results submitted successfully');
      return response;
    } catch (error) {
      logger.error(
        { taskId, error: error instanceof Error ? error.message : String(error) },
        'Failed to submit results'
      );
      throw error;
    }
  }
}

