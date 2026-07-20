/**
 * HTTP server for health checks and status endpoints
 *
 * Uses Express for a familiar, widely-used HTTP server
 */

import express, { Express, Request, Response } from 'express';
import { logger } from './logger';
import { checkDependencies } from './dependency-checks';
import type { Validator } from './validator';

// Resolved at runtime so the endpoint reports the shipped package version
// (a static import would emit package.json outside tsconfig's rootDir).
let packageVersion = 'unknown';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  packageVersion = require('../package.json').version;
} catch {
  packageVersion = process.env.VERSION || 'unknown';
}

export function createServer(validator: Validator): Express {
  const app = express();

  // JSON middleware
  app.use(express.json());

  // Health check endpoint — intentionally cheap (no dependency probes) so
  // container/platform healthchecks never restart the validator because a
  // *dependency* is down. Use /status for dependency health.
  app.get('/health', (req: Request, res: Response) => {
    const status = validator.getStatus();
    res.json({
      status: 'ok',
      running: status.running,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // Status endpoint with detailed info, including live dependency checks
  // (sbevals sidecar, coordinator API, optional Letta backend)
  app.get('/status', async (req: Request, res: Response) => {
    const status = validator.getStatus();
    const report = await checkDependencies(status.apiUrl);

    res.json({
      status: status.running && report.overall === 'ok' ? 'ok' : 'degraded',
      validator: {
        running: status.running,
        hotkey: status.hotkey,
        evaluatorId: status.evaluatorId,
        apiUrl: status.apiUrl,
        startedAt: status.startedAt,
        uptimeSeconds: Math.round(process.uptime()),
        // Authenticated coordinator health: heartbeats and task polls use
        // signed requests, so these show whether the coordinator is actually
        // accepting this validator (vs. the plain reachability probe below).
        lastHeartbeat: status.lastHeartbeat,
        lastPoll: status.lastPoll,
        taskProcessor: status.taskProcessor,
      },
      dependencies: {
        overall: report.overall,
        checkedAt: report.checkedAt,
        cached: report.cached,
        ...report.dependencies,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Metrics endpoint (for monitoring)
  app.get('/metrics', async (req: Request, res: Response) => {
    const status = validator.getStatus();
    const report = await checkDependencies(status.apiUrl);

    res.json({
      validator: {
        running: status.running,
        hotkey: status.hotkey ? `${status.hotkey.substring(0, 10)}...` : 'unknown',
        evaluatorId: status.evaluatorId || 'not-registered',
        apiUrl: status.apiUrl,
        lastHeartbeat: status.lastHeartbeat,
        lastPoll: status.lastPoll,
      },
      tasks: {
        processing: status.taskProcessor?.processing ?? 0,
        maxConcurrent: status.taskProcessor?.maxConcurrent ?? 0,
      },
      dependencies: {
        overall: report.overall,
        sbevals: {
          status: report.dependencies.sbevals.status,
          latencyMs: report.dependencies.sbevals.latencyMs,
        },
        coordinator: {
          status: report.dependencies.coordinator.status,
          latencyMs: report.dependencies.coordinator.latencyMs,
        },
        letta: {
          status: report.dependencies.letta.status,
          latencyMs: report.dependencies.letta.latencyMs,
        },
      },
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Current competition + the validator's weight vote. Shows what the
  // validator last decided (targets + reproducible decision hash), when
  // weights last landed on-chain, and when the next interval tick fires —
  // so the local weight decision is observable and verifiable from outside.
  app.get('/competition', (req: Request, res: Response) => {
    const w = validator.getWeightsStatus();
    const d = w.lastDecision;

    res.json({
      competition: d?.competition ?? null,
      vote:
        d && d.targets
          ? {
              targets: d.targets,
              winnerUid: d.winnerUid,
              leader: d.leader,
              emissionsPercent: d.emissionsPercent,
              decisionHash: d.decisionHash,
            }
          : null,
      weights: {
        enabled: w.enabled,
        intervalMinutes: w.intervalMinutes,
        emissionsPercent: w.emissionsPercent,
        lastDecisionAt: d?.at ?? null,
        lastDecisionReason: d?.reason ?? null,
        submitted: d?.submitted ?? false,
        skipped: d?.skipped ?? null,
        nextAttemptAt: d?.nextAttemptAt ?? null,
        error: d?.error ?? null,
        lastSetAt: w.lastSetAt,
        nextSetAt: w.nextSetAt,
      },
      ...(d ? {} : { note: 'No weight cycle has completed yet — check again shortly.' }),
      timestamp: new Date().toISOString(),
    });
  });

  // Root endpoint
  app.get('/', (req: Request, res: Response) => {
    res.json({
      service: 'Sundae Bar Validator',
      version: packageVersion,
      endpoints: {
        health: '/health — process liveness only (used by container healthchecks)',
        status: '/status — validator state + live dependency checks (sbevals, coordinator, letta)',
        metrics: '/metrics — uptime, memory, task counts, dependency latencies',
        competition:
          "/competition — current competition + the validator's weight vote (targets, decision hash, last/next set time)",
      },
      dependencies: {
        sbevals: 'skill evaluation sidecar (required for skill challenges)',
        coordinator: 'Sundae Bar coordinator API (required)',
        letta: 'legacy agent backend (optional, dormant)',
      },
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
export async function startServer(app: Express, port: number = 8080): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const server = app.listen(port, () => {
        logger.info({ port }, 'HTTP server started');
        resolve();
      });

      server.on('error', (error: Error) => {
        logger.error({ error: error.message }, 'HTTP server error');
        reject(error);
      });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to start HTTP server',
      );
      reject(error);
    }
  });
}
