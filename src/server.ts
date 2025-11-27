/**
 * HTTP server for health checks and status endpoints
 * 
 * Uses Express for a familiar, widely-used HTTP server
 */

import express, { Express, Request, Response } from 'express';
import { logger } from './logger';
import type { Validator } from './validator';

export function createServer(validator: Validator): Express {
  const app = express();

  // JSON middleware
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    const status = validator.getStatus();
    res.json({
      status: 'ok',
      running: status.running,
      timestamp: new Date().toISOString()
    });
  });

  // Status endpoint with detailed info
  app.get('/status', (req: Request, res: Response) => {
    const status = validator.getStatus();
    res.json({
      status: 'ok',
      validator: {
        running: status.running,
        hotkey: status.hotkey,
        evaluatorId: status.evaluatorId,
        apiUrl: status.apiUrl
      },
      timestamp: new Date().toISOString()
    });
  });

  // Metrics endpoint (for monitoring)
  app.get('/metrics', (req: Request, res: Response) => {
    const status = validator.getStatus();
    res.json({
      validator: {
        running: status.running,
        hotkey: status.hotkey ? `${status.hotkey.substring(0, 10)}...` : 'unknown',
        evaluatorId: status.evaluatorId || 'not-registered',
        apiUrl: status.apiUrl
      },
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
      },
      timestamp: new Date().toISOString()
    });
  });

  // Root endpoint
  app.get('/', (req: Request, res: Response) => {
    res.json({
      service: 'Sundae Bar Validator',
      version: '1.0.0',
      endpoints: {
        health: '/health',
        status: '/status',
        metrics: '/metrics'
      }
    });
  });

  // Error handling middleware
  app.use((err: Error, req: Request, res: Response, next: express.NextFunction) => {
    logger.error({ error: err.message, path: req.path }, 'Server error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

/**
 * Start HTTP server using Express
 */
export async function startServer(
  app: Express,
  port: number = 8080
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const server = app.listen(port, () => {
        logger.info({ port }, 'HTTP server started');
        resolve();
      });

      server.on('error', (error: Error) => {
        logger.error(
          { error: error.message },
          'HTTP server error'
        );
        reject(error);
      });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to start HTTP server'
      );
      reject(error);
    }
  });
}

