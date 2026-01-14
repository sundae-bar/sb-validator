/**
 * Validator entrypoint
 * 
 * Secure validator client for Sundae Bar SN121 subnet
 */

import 'dotenv/config';
import { Validator } from './validator';
import logger from './logger';
import { createServer, startServer } from './server';
import type { ValidatorConfig } from './types';

// Load configuration from environment variables
function loadConfig(): ValidatorConfig {
  const mnemonic = process.env.MNEMONIC;
  const apiUrl = process.env.API_URL || 'http://localhost:3002';

  if (!mnemonic) {
    throw new Error(
      'MNEMONIC environment variable is required.\n' +
      'Generate one with: cd ../sn121 && npm run generate-keys\n' +
      'Then set it in your .env file or environment.'
    );
  }

  // Check if it's the placeholder from .env.example
  if (mnemonic.includes('word1 word2 word3')) {
    throw new Error(
      'Please replace the placeholder mnemonic in your .env file.\n' +
      'Generate a valid mnemonic with: cd ../sn121 && npm run generate-keys\n' +
      'Then update MNEMONIC in your .env file.'
    );
  }

  return {
    mnemonic,
    apiUrl,
    displayName: process.env.DISPLAY_NAME,
    version: process.env.VERSION || '1.0.0',
    pollInterval: parseInt(process.env.POLL_INTERVAL || '5', 10),
    heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '30', 10),
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
    retryDelay: parseInt(process.env.RETRY_DELAY || '1000', 10),
    logLevel: process.env.LOG_LEVEL || 'info'
  };
}

async function main(): Promise<void> {
  try {
    logger.info('=== Sundae Bar Validator ===');
    logger.info('Starting validator client...');

    // Load configuration
    const config = loadConfig();
    logger.info(
      {
        apiUrl: config.apiUrl,
        displayName: config.displayName,
        version: config.version,
        pollInterval: config.pollInterval,
        heartbeatInterval: config.heartbeatInterval
      },
      'Configuration loaded'
    );

    // Require either LETTA_BASE_URL (self-hosted) or LETTA_API_KEY (Letta Cloud)
    const hasLettaConfig = Boolean(process.env.LETTA_BASE_URL || process.env.LETTA_API_KEY);

    if (!hasLettaConfig) {
      throw new Error(
        'No LETTA_BASE_URL or LETTA_API_KEY configured.\n' +
        'Run the Letta server separately (see ../letta-server) and set LETTA_BASE_URL,\n' +
        'or supply a Letta Cloud API key via LETTA_API_KEY.'
      );
    }

    if (process.env.LETTA_BASE_URL) {
      // Strip quotes if present (common when set in docker-compose or shell scripts)
      const baseUrl = process.env.LETTA_BASE_URL.trim().replace(/^["']|["']$/g, '');
      logger.info({ url: baseUrl, raw: process.env.LETTA_BASE_URL }, 'Using external Letta server');
    } else {
      logger.info('Using Letta Cloud via LETTA_API_KEY');
    }

    // Create and start validator
    const validator = new Validator(config);

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');
      await validator.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      logger.error({ error: error.message, stack: error.stack }, 'Uncaught exception');
      Promise.all([validator.stop()]).finally(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error(
        { reason: reason instanceof Error ? reason.message : String(reason) },
        'Unhandled rejection'
      );
      Promise.all([validator.stop()]).finally(() => process.exit(1));
    });

    // Start HTTP server for health checks (runs in background)
    const serverPort = parseInt(process.env.SERVER_PORT || '8080', 10);
    const serverApp = createServer(validator);
    startServer(serverApp, serverPort).catch((error) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to start HTTP server (continuing without it)'
      );
      // Don't exit - validator can still work without HTTP server
    });

    // Start validator - this will run continuously
    // The start() method contains an infinite loop that only exits when stop() is called
    logger.info('Starting validator (will run continuously until stopped)...');
    await validator.start();
    
    // This line should never be reached unless stop() was called
    logger.info('Validator exited normally');
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined },
      'Fatal error - validator will exit'
    );
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { Validator };
export type { ValidatorConfig } from './types';

