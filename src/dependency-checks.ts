/**
 * Live health checks for the validator's external dependencies:
 *
 * - sbevals      — the skill evaluation sidecar (required for skill challenges)
 * - coordinator  — the Sundae Bar coordinator API (required)
 * - letta        — the legacy agent (.af) backend (optional, dormant)
 *
 * Results are cached for a short TTL so /status and /metrics can be polled
 * frequently without hammering the dependencies themselves.
 */

import axios from 'axios';
import logger from './logger';

const CHECK_TIMEOUT_MS = Number(process.env.DEPENDENCY_CHECK_TIMEOUT_MS || '3000');
const CACHE_TTL_MS = Number(process.env.DEPENDENCY_CHECK_CACHE_SECONDS || '15') * 1000;

export type DependencyState =
  | 'ok' // reachable and healthy
  | 'degraded' // reachable but misconfigured (e.g. missing API key)
  | 'unauthorized' // reachable but rejected our credentials
  | 'unreachable' // connection failed (container down / wrong URL / network)
  | 'error' // reachable but returned an unexpected error
  | 'disabled'; // optional dependency, not configured

export interface DependencyCheck {
  name: string;
  description: string;
  required: boolean;
  url: string | null;
  status: DependencyState;
  latencyMs: number | null;
  message: string;
  hint?: string;
}

export interface DependencyReport {
  /** 'ok' when every required dependency is ok, otherwise 'degraded' */
  overall: 'ok' | 'degraded';
  checkedAt: string;
  cached: boolean;
  dependencies: {
    sbevals: DependencyCheck;
    coordinator: DependencyCheck;
    letta: DependencyCheck;
  };
}

interface ProbeResult {
  status: DependencyState;
  latencyMs: number | null;
  message: string;
  hint?: string;
}

/**
 * GET a health URL and classify the outcome. Any HTTP response counts as
 * "reachable"; only network-level failures are 'unreachable'.
 */
async function probe(url: string, headers: Record<string, string> = {}): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const response = await axios.get(url, {
      headers,
      timeout: CHECK_TIMEOUT_MS,
      validateStatus: () => true,
    });
    const latencyMs = Date.now() - started;

    if (response.status >= 200 && response.status < 300) {
      return {
        status: 'ok',
        latencyMs,
        message: `healthy (HTTP ${response.status})`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'unauthorized',
        latencyMs,
        message: `reachable but rejected credentials (HTTP ${response.status})`,
      };
    }
    return {
      status: 'error',
      latencyMs,
      message: `reachable but unhealthy (HTTP ${response.status})`,
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const code = axios.isAxiosError(error) ? error.code : undefined;
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'unreachable',
      latencyMs,
      message: code ? `${code}: ${detail}` : detail,
    };
  }
}

async function checkSbEvals(): Promise<DependencyCheck> {
  const baseUrl = (process.env.SBEVALS_URL || 'http://localhost:8090').replace(/\/$/, '');
  const apiKey = process.env.SBEVALS_API_KEY || '';

  const result = await probe(`${baseUrl}/health`, apiKey ? { 'X-Api-Key': apiKey } : {});

  const check: DependencyCheck = {
    name: 'sbevals',
    description:
      'Skill evaluation service (sundaebarai/sn121-skill-evals). Required to evaluate skill (.md) challenges.',
    required: true,
    url: baseUrl,
    ...result,
  };

  if (check.status === 'ok' && !apiKey) {
    check.status = 'degraded';
    check.message =
      'reachable, but SBEVALS_API_KEY is not set — skill task submissions will be rejected';
    check.hint =
      'Set SBEVALS_API_KEY in .env (compose passes the same value to the sidecar as EVAL_SERVICE_API_KEY).';
  } else if (check.status === 'unauthorized') {
    check.hint =
      "SBEVALS_API_KEY must equal the sidecar's EVAL_SERVICE_API_KEY. Check for a stale .env or an override.";
  } else if (check.status === 'unreachable') {
    check.hint =
      'Is the sbevals container running? Check `docker compose ps` and `docker compose logs -f sbevals`. In compose the URL should be http://sbevals:8090.';
  }

  return check;
}

async function checkCoordinator(apiUrl: string): Promise<DependencyCheck> {
  const baseUrl = apiUrl.replace(/\/$/, '');
  const result = await probe(baseUrl);

  const check: DependencyCheck = {
    name: 'coordinator',
    description:
      'Sundae Bar coordinator API (task polling, heartbeats, result submission, weights).',
    required: true,
    url: baseUrl,
    ...result,
  };

  // Coordinator endpoints require signed requests, so an auth/4xx response to
  // a bare GET still proves the service is reachable — that is all this probe
  // can establish. Real request health shows up in validator.lastHeartbeat.
  if (check.status === 'unauthorized' || check.status === 'error') {
    check.status = 'ok';
    check.message = `reachable (${check.message}; endpoints require signed requests — see validator.lastHeartbeat for authenticated health)`;
  } else if (check.status === 'unreachable') {
    check.hint = 'Check API_URL and outbound network connectivity from the validator.';
  }

  return check;
}

async function checkLetta(): Promise<DependencyCheck> {
  const rawUrl = process.env.LETTA_BASE_URL;
  if (!rawUrl) {
    return {
      name: 'letta',
      description: 'Legacy agent (.af) backend. Optional — skill challenges never touch it.',
      required: false,
      url: null,
      status: 'disabled',
      latencyMs: null,
      message: 'LETTA_BASE_URL not set — running skill-only (legacy agent track disabled)',
    };
  }

  const baseUrl = rawUrl
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\/$/, '');
  const result = await probe(`${baseUrl}/v1/health`);

  const check: DependencyCheck = {
    name: 'letta',
    description: 'Legacy agent (.af) backend. Optional — skill challenges never touch it.',
    required: false,
    url: baseUrl,
    ...result,
  };

  if (check.status === 'unreachable') {
    check.hint =
      'Optional dependency. Check `docker compose logs -f letta-server` if the legacy agent track is needed.';
  }

  return check;
}

let cachedReport: DependencyReport | null = null;
let cacheExpiresAt = 0;
let inFlight: Promise<DependencyReport> | null = null;

/**
 * Run all dependency checks in parallel. Results are cached for
 * DEPENDENCY_CHECK_CACHE_SECONDS (default 15s); concurrent callers share a
 * single in-flight check.
 */
export async function checkDependencies(apiUrl: string): Promise<DependencyReport> {
  const now = Date.now();
  if (cachedReport && now < cacheExpiresAt) {
    return { ...cachedReport, cached: true };
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    const [sbevals, coordinator, letta] = await Promise.all([
      checkSbEvals(),
      checkCoordinator(apiUrl),
      checkLetta(),
    ]);

    const requiredOk = [sbevals, coordinator, letta]
      .filter((d) => d.required)
      .every((d) => d.status === 'ok');

    const report: DependencyReport = {
      overall: requiredOk ? 'ok' : 'degraded',
      checkedAt: new Date().toISOString(),
      cached: false,
      dependencies: { sbevals, coordinator, letta },
    };

    if (report.overall !== 'ok') {
      logger.warn(
        {
          sbevals: { status: sbevals.status, message: sbevals.message },
          coordinator: {
            status: coordinator.status,
            message: coordinator.message,
          },
        },
        'Dependency check reported degraded state',
      );
    }

    cachedReport = report;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return report;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
