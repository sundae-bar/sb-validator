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
  processing_status?: 'pending' | 'parsing' | 'embedding' | 'completed' | 'error';
  total_chunks?: number;
  chunks_embedded?: number;
  error_message?: string;
  // Optional fields returned by Letta for files
  file_name?: string;
  original_file_name?: string;
}

export class LettaClient {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl?: string) {
    // Determine base URL (only support hosted instances)
    this.baseUrl = baseUrl || process.env.LETTA_BASE_URL || 'http://localhost:8283';
    if (!this.baseUrl) {
      throw new Error('LETTA_BASE_URL must be provided');
    }

    // Remove trailing slash
    this.baseUrl = this.baseUrl.replace(/\/$/, '');
    
    // Log the base URL being used for debugging
    logger.info({ baseUrl: this.baseUrl, envVar: process.env.LETTA_BASE_URL }, 'LettaClient initialized with base URL');

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 120000, // 2 minute timeout for file uploads
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        // Log at INFO level for folder creation to help debug the empty array issue
        const isFolderCreation = (config.url === '/v1/folders' || config.url === '/v1/folders/') && config.method === 'post';
        const logLevel = isFolderCreation ? 'info' : 'debug';
        logger[logLevel]({ 
          method: config.method, 
          url: config.url,
          fullUrl: `${config.baseURL}${config.url}`,
          baseURL: config.baseURL,
          headers: config.headers,
          data: config.data
        }, isFolderCreation ? 'Letta folder creation request' : 'Letta API request');
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
          { 
            status, 
            url: error.config?.url,
            method: error.config?.method,
            requestData: error.config?.data,
            responseData: error.response?.data,
            responseHeaders: error.response?.headers,
            message 
          },
          'Letta API error'
        );
        return Promise.reject(error);
      }
    );
  }

  /**
   * List agents
   * Uses simple request (no pagination) since pagination is not working reliably
   */
  async listAgents(): Promise<any[]> {
    logger.debug('Listing Letta agents');

    try {
      const params: any = { 
        limit: 100
        // Note: API only supports order_by: 'created_at' but created_at is always null, so no ordering
      };
      
      const response = await this.client.get<any[]>('/v1/agents/', { params });
      const agents = response.data || [];
      logger.debug(
        { totalAgents: agents.length },
        'Listed agents'
      );
      return agents;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to list agents'
      );
      throw error;
    }
  }

  /**
   * Delete an agent by ID
   */
  async deleteAgent(agentId: string): Promise<void> {
    logger.debug({ agentId }, 'Deleting Letta agent');

    try {
      await this.client.delete(`/v1/agents/${agentId}`);
      logger.debug({ agentId }, 'Agent deleted successfully');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), agentId },
        'Failed to delete agent'
      );
      throw error;
    }
  }

  /**
   * List folders, optionally filtered by name
   * Uses simple request (no pagination) since pagination is not working reliably
   */
  async listFolders(name?: string): Promise<Folder[]> {
    logger.debug({ name }, 'Listing Letta folders');

    try {
      const params: any = { 
        limit: 100
        // Note: API only supports order_by: 'created_at' but created_at is always null, so no ordering
      };
      if (name) {
        params.name = name;
      }
      
      const response = await this.client.get<Folder[]>('/v1/folders/', { params });
      const folders = response.data || [];
      logger.debug(
        { totalFolders: folders.length },
        'Listed folders'
      );
      return folders;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to list folders'
      );
      throw error;
    }
  }

  /**
   * Delete a folder by ID
   */
  async deleteFolder(folderId: string): Promise<void> {
    logger.debug({ folderId }, 'Deleting Letta folder');

    try {
      await this.client.delete(`/v1/folders/${folderId}`);
      logger.debug({ folderId }, 'Folder deleted successfully');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), folderId },
        'Failed to delete folder'
      );
      throw error;
    }
  }

  /**
   * Update/rename a folder
   */
  async updateFolder(folderId: string, updates: { name?: string; description?: string }): Promise<Folder> {
    logger.debug({ folderId, updates }, 'Updating Letta folder');

    try {
      const response = await this.client.patch<Folder>(`/v1/folders/${folderId}`, updates);
      logger.debug({ folderId, name: response.data.name }, 'Folder updated successfully');
      return response.data;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), folderId },
        'Failed to update folder'
      );
      throw error;
    }
  }

  /**
   * Clean up orphaned folders with hash suffixes (e.g., filesystem_data_*, company_policy_data_*)
   * This removes folders that have hash suffixes.
   * Uses an iterative approach: fetch 100, cleanup, fetch again (up to 10 iterations)
   * This works around pagination issues by deleting folders to "shift" later pages forward
   */
  async cleanupOrphanedFolders(): Promise<void> {
    logger.debug('Cleaning up orphaned folders with hash suffixes');

    try {
      const baseFolderNames = ['filesystem_data', 'company_policy_data'];
      const maxIterations = 10;
      let totalDeleted = 0;
      let iteration = 0;

      while (iteration < maxIterations) {
        iteration++;
        logger.debug({ iteration, maxIterations }, 'Cleanup iteration');

        // Fetch folders (simple request, no pagination - gets first 100)
        // Use consistent ordering to ensure we process folders in a predictable way
        let folders: Folder[];
        try {
          const params: any = { 
            limit: 100
            // Note: Not using order/order_by since created_at is always null
          };
          const response = await this.client.get<Folder[]>('/v1/folders/', { params });
          folders = response.data || [];
        } catch (error) {
          logger.warn(
            { error: error instanceof Error ? error.message : String(error), iteration },
            'Failed to fetch folders in cleanup iteration'
          );
          break; // Stop if we can't fetch folders
        }

        if (folders.length === 0) {
          logger.debug({ iteration }, 'No more folders to process');
          break;
        }

        // Find all exact match folders (without hash suffixes)
        const exactMatches = new Set<string>();
        for (const folder of folders) {
          if (baseFolderNames.includes(folder.name)) {
            exactMatches.add(folder.name);
          }
        }

        // Find all folders with hash suffixes that should be cleaned up
        // Also delete exact match company_policy_data folders (we don't want these at all)
        const foldersToDelete: Folder[] = [];
        for (const folder of folders) {
          // Check if this folder matches a pattern we want to clean up
          for (const baseName of baseFolderNames) {
            // Delete exact match company_policy_data folders (we don't want these)
            if (baseName === 'company_policy_data' && folder.name === baseName) {
              foldersToDelete.push(folder);
              break;
            }
            // Delete folders with hash suffixes
            if (folder.name.startsWith(baseName + '_')) {
              // Delete company_policy_data_* folders always (we don't want these)
              // Delete filesystem_data_* folders only if exact match exists (to avoid deleting if we haven't created exact match yet)
              if (baseName === 'company_policy_data' || exactMatches.has(baseName)) {
                foldersToDelete.push(folder);
                break;
              }
            }
          }
        }

        if (foldersToDelete.length === 0) {
          logger.debug({ iteration, totalDeleted }, 'No more orphaned folders found, cleanup complete');
          break;
        }

        logger.debug(
          { iteration, count: foldersToDelete.length, folders: foldersToDelete.map(f => f.name) },
          'Found orphaned folders with hash suffixes to delete'
        );

        // Delete the folders
        let deletedThisIteration = 0;
        for (const folder of foldersToDelete) {
          if (folder.id) {
            try {
              await this.deleteFolder(folder.id);
              logger.debug({ folderId: folder.id, name: folder.name, iteration }, 'Deleted orphaned folder');
              deletedThisIteration++;
              totalDeleted++;
            } catch (error) {
              logger.warn(
                { error: error instanceof Error ? error.message : String(error), folderId: folder.id },
                'Failed to delete orphaned folder (non-fatal)'
              );
            }
          }
        }

        logger.debug(
          { iteration, deletedThisIteration, totalDeleted, remainingInBatch: folders.length - foldersToDelete.length },
          'Completed cleanup iteration'
        );

        // If we deleted fewer than we found, or if there are no more folders to process, we're done
        if (deletedThisIteration === 0 || folders.length < 100) {
          logger.debug({ iteration, totalDeleted }, 'Cleanup complete (no more folders to delete or reached end)');
          break;
        }

        // Small delay between iterations to avoid overwhelming the API
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      logger.debug({ totalIterations: iteration, totalDeleted }, 'Finished cleanup of orphaned folders');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to cleanup orphaned folders'
      );
      // Don't throw - this is a cleanup operation
    }
  }

  /**
   * Find a folder by exact name, or create it if it doesn't exist.
   * If folders with hash suffixes exist, they will be deleted and a new exact match will be created.
   */
  async findOrCreateFolder(name: string, description?: string): Promise<Folder> {
    logger.debug({ name }, 'Finding or creating Letta folder');

    try {
      // First, try to find exact match by querying specifically by name
      // This is more reliable than searching through all folders
      let exactMatch: Folder | undefined;
      try {
        const foldersByName = await this.listFolders(name);
        exactMatch = foldersByName.find(f => f.name === name);
        if (exactMatch) {
          logger.debug({ folderId: exactMatch.id, name: exactMatch.name }, 'Found exact match folder by name query');
        }
      } catch (error) {
        logger.debug(
          { error: error instanceof Error ? error.message : String(error) },
          'Name-based folder query failed, will search all folders'
        );
      }

      // If not found by name query, search all folders
      if (!exactMatch) {
        const folders = await this.listFolders();
        exactMatch = folders.find(f => f.name === name);
      }
      
      if (exactMatch) {
        if (!exactMatch.id) {
          throw new Error(`Existing folder missing id: ${JSON.stringify(exactMatch)}`);
        }
        logger.debug({ folderId: exactMatch.id, name: exactMatch.name }, 'Found exact match folder');
        
        // Clean up any old folders with hash suffixes (they shouldn't exist, but just in case)
        // Get all folders to find hash-suffixed ones
        const allFolders = await this.listFolders();
        const oldFolders = allFolders.filter(f => f.name.startsWith(name + '_') && f.id !== exactMatch.id);
        if (oldFolders.length > 0) {
          logger.debug({ count: oldFolders.length }, 'Found old folders with hash suffixes, cleaning up');
          for (const oldFolder of oldFolders) {
            if (oldFolder.id) {
              try {
                await this.deleteFolder(oldFolder.id);
                logger.debug({ folderId: oldFolder.id, name: oldFolder.name }, 'Deleted old folder');
              } catch (error) {
                logger.warn(
                  { error: error instanceof Error ? error.message : String(error), folderId: oldFolder.id },
                  'Failed to delete old folder (non-fatal)'
                );
              }
            }
          }
        }
        
        return exactMatch;
      }

      // No exact match found - check for old folders with hash suffixes
      const allFolders = await this.listFolders();
      const oldFolders = allFolders.filter(f => f.name.startsWith(name + '_'));
      
      if (oldFolders.length > 0) {
        logger.debug({ count: oldFolders.length }, 'Found old folders with hash suffixes, cleaning up before creating exact match');
        // Delete all old folders
        for (const oldFolder of oldFolders) {
          if (oldFolder.id) {
            try {
              await this.deleteFolder(oldFolder.id);
              logger.debug({ folderId: oldFolder.id, name: oldFolder.name }, 'Deleted old folder');
            } catch (error) {
              logger.warn(
                { error: error instanceof Error ? error.message : String(error), folderId: oldFolder.id },
                'Failed to delete old folder (non-fatal)'
              );
            }
          }
        }
        
        // Wait a moment after deletion to ensure Letta has processed the deletions
        // This helps prevent duplicate name conflicts that might cause hash suffixes
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Create new folder with exact name (per API docs, should create with exact name)
      logger.debug({ name }, 'Creating new folder with exact name');
      const newFolder = await this.createFolder(name, description);
      
      if (!newFolder || !newFolder.id) {
        throw new Error(`Created folder missing id: ${JSON.stringify(newFolder)}`);
      }
      
      // If Letta added a hash suffix, log a warning
      if (newFolder.name !== name) {
        logger.warn(
          { requestedName: name, actualName: newFolder.name, folderId: newFolder.id },
          'Folder created with different name than requested (Letta may have added hash suffix)'
        );
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
    logger.debug({ name, description }, 'Creating Letta folder');

    try {
      const requestPayload = {
        name,
        description,
        embedding: 'openai/text-embedding-3-small' // Default embedding
      };
      // Use trailing slash to avoid 307 redirects
      const folderUrl = '/v1/folders/';
      logger.debug({ requestPayload, url: folderUrl }, 'Folder creation request');
      
      // Try to catch any response transformation issues
      let response;
      try {
        response = await this.client.post<Folder>(folderUrl, requestPayload);
      } catch (error: any) {
        // Log the full error details
        logger.error(
          {
            error: error.message,
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            headers: error.response?.headers,
            config: {
              url: error.config?.url,
              method: error.config?.method,
              data: error.config?.data,
              headers: error.config?.headers
            }
          },
          'Folder creation request failed'
        );
        throw error;
      }

      // Log full response for debugging
      // Also check the raw response if data is empty array
      const rawResponse = response.data;
      logger.info(
        { 
          responseData: rawResponse,
          responseDataString: JSON.stringify(rawResponse),
          responseStatus: response.status,
          responseStatusText: response.statusText,
          responseHeaders: response.headers,
          isArray: Array.isArray(rawResponse),
          arrayLength: Array.isArray(rawResponse) ? rawResponse.length : undefined,
          requestedName: name,
          requestConfig: {
            url: response.config?.url,
            method: response.config?.method,
            headers: response.config?.headers,
            data: response.config?.data
          }
        }, 
        'Folder creation response'
      );
      
      // If we got an empty array, this is unexpected - log a warning
      if (Array.isArray(rawResponse) && rawResponse.length === 0) {
        logger.warn(
          {
            status: response.status,
            headers: response.headers,
            requestPayload
          },
          'Folder creation returned empty array - this may indicate an authentication or server-side error'
        );
      }
      
      // Handle case where API returns an array instead of a single object
      let folderData: Folder | null = null;
      if (Array.isArray(response.data)) {
        logger.warn(
          { arrayLength: response.data.length, requestedName: name },
          'Folder creation API returned array instead of single object'
        );
        
        if (response.data.length === 0) {
          // Empty array - folder might still have been created, query for it
          logger.info(
            { requestedName: name },
            'Folder creation API returned empty array, querying API to verify folder was created'
          );
          
          // Wait a moment for the folder to be created
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Query folders by name to find the one we just created
          const folders = await this.listFolders(name);
          const foundFolder = folders.find(f => f.name === name) || folders.find(f => f.name.startsWith(name + '_'));
          
          if (foundFolder) {
            folderData = foundFolder;
            logger.info(
              { folderId: foundFolder.id, name: foundFolder.name, requestedName: name },
              'Found created folder by querying API after empty array response'
            );
          } else {
            // Still not found - this is an error
            // The empty array response with 200 status suggests a server-side issue
            // Possible causes:
            // 1. Embedding config lookup failed (embedding model 'openai/text-embedding-3-small' not available)
            // 2. Authentication issue (missing user_id header or actor creation failed)
            // 3. Server-side exception being caught and returning empty array
            throw new Error(
              `Failed to create folder '${name}'. ` +
              `API returned empty array (status ${response.status}), which indicates a server-side error. ` +
              `Possible causes: embedding model 'openai/text-embedding-3-small' not available, ` +
              `authentication issue, or server misconfiguration. ` +
              `Please check Letta server logs for details.`
            );
          }
        } else {
          // Array with items - try to find the folder we just created
          folderData = response.data.find(f => f.name === name) || null;
          if (!folderData) {
            folderData = response.data.find(f => f.name.startsWith(name + '_')) || null;
          }
        }
      } else {
        folderData = response.data;
      }
      
      // If we couldn't find the folder in the response, query the API again to find it
      if (!folderData || folderData.name !== name) {
        logger.info(
          { requestedName: name, foundInResponse: !!folderData },
          'Folder not found in creation response, querying API to find it'
        );
        
        // Wait a moment for the folder to be created
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Query folders by name to find the one we just created
        const folders = await this.listFolders(name);
        const foundFolder = folders.find(f => f.name === name) || folders.find(f => f.name.startsWith(name + '_'));
        
        if (foundFolder) {
          folderData = foundFolder;
          logger.info(
            { folderId: foundFolder.id, name: foundFolder.name, requestedName: name },
            'Found created folder by querying API'
          );
        } else {
          // Still not found - this is an error
          throw new Error(
            `Failed to find created folder '${name}' after creation. ` +
            `API returned ${Array.isArray(response.data) ? 'array' : 'object'} but folder not found.`
          );
        }
      }
      
      if (!folderData || !folderData.id) {
        logger.error({ responseData: response.data, folderData }, 'Folder creation response missing id field');
        throw new Error(`Folder creation response missing id field: ${JSON.stringify(response.data)}`);
      }

      // If the folder name doesn't match what we requested, try to rename it
      if (folderData.name !== name) {
        logger.warn(
          { requestedName: name, actualName: folderData.name, folderId: folderData.id },
          'Folder created with different name than requested, attempting to rename'
        );
        
        try {
          // Try to rename the folder to the exact name we want
          const oldName = folderData.name;
          folderData = await this.updateFolder(folderData.id, { name });
          logger.info(
            { folderId: folderData.id, oldName, newName: folderData.name },
            'Successfully renamed folder to exact name'
          );
        } catch (error) {
          // If rename fails with 409 (conflict), it means the exact name folder already exists
          // Query for it specifically to find and use it instead
          if (error instanceof AxiosError && error.response?.status === 409) {
            logger.info(
              { requestedName: name, error: error.message },
              'Rename failed with 409 conflict - exact name folder likely exists, searching for it'
            );
            
            try {
              // Query specifically for the exact name
              const exactMatchFolders = await this.listFolders(name);
              const exactMatch = exactMatchFolders.find(f => f.name === name);
              
              if (exactMatch && exactMatch.id) {
                logger.info(
                  { folderId: exactMatch.id, name: exactMatch.name, requestedName: name },
                  'Found existing exact match folder, using it instead'
                );
                // Delete the folder we just created (with hash suffix)
                try {
                  await this.deleteFolder(folderData.id);
                  logger.debug({ folderId: folderData.id, name: folderData.name }, 'Deleted duplicate folder with hash suffix');
                } catch (deleteError) {
                  logger.warn(
                    { error: deleteError instanceof Error ? deleteError.message : String(deleteError), folderId: folderData.id },
                    'Failed to delete duplicate folder (non-fatal)'
                  );
                }
                return exactMatch;
              } else {
                logger.warn(
                  { requestedName: name },
                  'Rename failed with 409 but exact match folder not found in search'
                );
              }
            } catch (searchError) {
              logger.warn(
                { error: searchError instanceof Error ? searchError.message : String(searchError), requestedName: name },
                'Failed to search for exact match folder after rename conflict'
              );
            }
          }
          
          logger.warn(
            { error: error instanceof Error ? error.message : String(error), folderId: folderData.id, requestedName: name },
            'Failed to rename folder (non-fatal, continuing with hash-suffixed name)'
          );
          // Continue with the hash-suffixed name if rename fails
        }
      }

      logger.debug({ folderId: folderData.id, name: folderData.name, requestedName: name }, 'Folder created successfully');
      return folderData;
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
    logger.debug({ folderId }, 'Listing files in folder');

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
  async getFileSize(filePath: string): Promise<number> {
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
    logger.debug({ folderId, filePath, fileName: actualFileName, duplicateHandling }, 'Uploading file to folder');

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
            ...formData.getHeaders()
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
