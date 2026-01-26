/**
 * Letta HTTP client for creating folders and uploading files
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import FormData from 'form-data';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import logger from './logger';

export interface Folder {
  id: string;
  name: string;
  description?: string;
  created_at: string;
}

export interface FileMetadata {
  id: string;
  name: string;
  source_id: string;
  created_at: string;
  size?: number;
  updated_at?: string;
}

export class LettaClient {
  private client: AxiosInstance;
  private baseUrl: string;
  private apiKey?: string;

  constructor(baseUrl?: string, apiKey?: string) {
    // Determine base URL
    if (apiKey) {
      this.baseUrl = baseUrl || 'https://api.letta.com';
      this.apiKey = apiKey;
    } else {
      this.baseUrl = baseUrl || process.env.LETTA_BASE_URL || 'http://localhost:8283';
      if (!this.baseUrl) {
        throw new Error('Either LETTA_BASE_URL or LETTA_API_KEY must be provided');
      }
    }

    // Remove trailing slash
    this.baseUrl = this.baseUrl.replace(/\/$/, '');

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 120000, // 2 minute timeout for file uploads
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add authentication header if API key is provided
    if (this.apiKey) {
      this.client.defaults.headers.common['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // Add request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        logger.debug({ method: config.method, url: config.url }, 'Letta API request');
        return config;
      },
      (error) => {
        logger.error({ error: error.message }, 'Letta request interceptor error');
        return Promise.reject(error);
      }
    );

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => {
        logger.debug(
          { status: response.status, url: response.config.url },
          'Letta API response'
        );
        return response;
      },
      (error: AxiosError) => {
        const status = error.response?.status;
        const message = error.response?.data || error.message;
        logger.error(
          { status, url: error.config?.url, message },
          'Letta API error'
        );
        return Promise.reject(error);
      }
    );
  }

  /**
   * List folders, optionally filtered by name
   */
  async listFolders(name?: string): Promise<Folder[]> {
    logger.info({ name }, 'Listing Letta folders');

    try {
      const params: any = { limit: 100 };
      if (name) {
        params.name = name;
      }

      const response = await this.client.get<Folder[]>('/v1/folders', { params });
      return response.data;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to list folders'
      );
      throw error;
    }
  }

  /**
   * Find a folder by name, or create it if it doesn't exist
   */
  async findOrCreateFolder(name: string, description?: string): Promise<Folder> {
    logger.info({ name }, 'Finding or creating Letta folder');

    try {
      // Try to find existing folder
      const folders = await this.listFolders(name);
      const existingFolder = folders.find(f => f.name === name);

      if (existingFolder) {
        if (!existingFolder.id) {
          throw new Error(`Existing folder missing id: ${JSON.stringify(existingFolder)}`);
        }
        logger.info({ folderId: existingFolder.id, name }, 'Found existing folder');
        return existingFolder;
      }

      // Create new folder if not found
      logger.info({ name }, 'Folder not found, creating new folder');
      const newFolder = await this.createFolder(name, description);
      
      if (!newFolder || !newFolder.id) {
        throw new Error(`Created folder missing id: ${JSON.stringify(newFolder)}`);
      }
      
      return newFolder;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to find or create folder'
      );
      throw error;
    }
  }

  /**
   * Create a new folder in Letta
   */
  async createFolder(name: string, description?: string): Promise<Folder> {
    logger.info({ name, description }, 'Creating Letta folder');

    try {
      const response = await this.client.post<Folder>('/v1/folders', {
        name,
        description,
        embedding: 'openai/text-embedding-3-small' // Default embedding
      });

      // Log full response for debugging
      logger.debug({ responseData: response.data, responseStatus: response.status }, 'Folder creation response');
      
      if (!response.data || !response.data.id) {
        logger.error({ responseData: response.data }, 'Folder creation response missing id field');
        throw new Error(`Folder creation response missing id field: ${JSON.stringify(response.data)}`);
      }

      logger.info({ folderId: response.data.id, name }, 'Folder created successfully');
      return response.data;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to create folder'
      );
      throw error;
    }
  }

  /**
   * List files in a folder
   */
  async listFilesInFolder(folderId: string): Promise<FileMetadata[]> {
    logger.info({ folderId }, 'Listing files in folder');

    try {
      const response = await this.client.get<FileMetadata[]>(`/v1/folders/${folderId}/files`, {
        params: { limit: 1000 } // Get all files
      });
      return response.data;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), folderId },
        'Failed to list files in folder'
      );
      throw error;
    }
  }

  /**
   * Calculate MD5 hash of a file
   */
  private async calculateFileHash(filePath: string): Promise<string> {
    const fileBuffer = await fs.readFile(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex');
  }

  /**
   * Get file size in bytes
   */
  private async getFileSize(filePath: string): Promise<number> {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  /**
   * Upload a file to a folder with duplicate handling
   */
  async uploadFileToFolder(
    folderId: string,
    filePath: string,
    fileName?: string,
    duplicateHandling: 'replace' | 'skip' | 'suffix' | 'error' = 'replace'
  ): Promise<FileMetadata> {
    const actualFileName = fileName || path.basename(filePath);
    logger.info({ folderId, filePath, fileName: actualFileName, duplicateHandling }, 'Uploading file to folder');

    try {
      // Read file
      const fileBuffer = await fs.readFile(filePath);
      
      // Create form data
      const formData = new FormData();
      formData.append('file', fileBuffer, {
        filename: actualFileName,
        contentType: this.getContentType(actualFileName)
      });

      // Make request with form data
      const response = await this.client.post<FileMetadata>(
        `/v1/folders/${folderId}/upload`,
        formData,
        {
          params: {
            duplicate_handling: duplicateHandling
          },
          headers: {
            ...formData.getHeaders(),
            ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }
      );

      logger.info(
        { fileId: response.data.id, fileName: actualFileName, folderId },
        'File uploaded successfully'
      );
      return response.data;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), filePath, folderId },
        'Failed to upload file'
      );
      throw error;
    }
  }

  /**
   * Upload file only if it's new or changed (compares by name and size)
   */
  async uploadFileIfChanged(
    folderId: string,
    filePath: string,
    fileName?: string
  ): Promise<{ uploaded: boolean; fileMetadata?: FileMetadata; reason: string }> {
    const actualFileName = fileName || path.basename(filePath);
    
    try {
      // Get local file info
      const localSize = await this.getFileSize(filePath);
      
      // List existing files in folder
      const existingFiles = await this.listFilesInFolder(folderId);
      const existingFile = existingFiles.find(f => f.name === actualFileName);
      
      if (existingFile) {
        // File exists - check if size changed
        if (existingFile.size && existingFile.size === localSize) {
          logger.info(
            { fileName: actualFileName, folderId, size: localSize },
            'File exists with same size, skipping upload'
          );
          return {
            uploaded: false,
            fileMetadata: existingFile,
            reason: 'File exists with same size'
          };
        } else {
          // Size changed or no size info - replace it
          logger.info(
            { fileName: actualFileName, folderId, existingSize: existingFile.size, newSize: localSize },
            'File exists but size changed, replacing'
          );
          const fileMetadata = await this.uploadFileToFolder(folderId, filePath, actualFileName, 'replace');
          return {
            uploaded: true,
            fileMetadata,
            reason: 'File replaced due to size change'
          };
        }
      } else {
        // File doesn't exist - upload it
        logger.info(
          { fileName: actualFileName, folderId },
          'File does not exist, uploading'
        );
          const fileMetadata = await this.uploadFileToFolder(folderId, filePath, actualFileName, 'replace');
        return {
          uploaded: true,
          fileMetadata,
          reason: 'New file uploaded'
        };
      }
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), filePath, folderId },
        'Failed to check and upload file'
      );
      throw error;
    }
  }

  /**
   * Get content type from file extension
   */
  private getContentType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.csv': 'text/csv',
      '.json': 'application/json',
      '.jsonl': 'application/jsonl',
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.html': 'text/html',
      '.xml': 'application/xml'
    };
    return contentTypes[ext] || 'application/octet-stream';
  }
}
