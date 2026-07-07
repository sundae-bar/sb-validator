# sundae_bar Validator

**Docker image:** [`sundaebarai/sn121-validator`](https://hub.docker.com/r/sundaebarai/sn121-validator) · **Source:** [github.com/sundae-bar/sb-validator](https://github.com/sundae-bar/sb-validator)

Secure validator client for the sundae_bar **SN121** subnet. This validator polls for evaluation tasks, routes each task to the correct evaluator, processes it, and submits results back to the coordinator.

## How challenges are evaluated

The validator evaluates **skill challenges (`.md`)** by routing them to the in-house **`sbevals`** evaluator over HTTP. This is the active track and the only one you need to set up. `sbevals` runs the skill: it executes a test agent loaded with the submitted `SKILL.md` (making LLM calls to produce outputs) and then scores those outputs with LLM-as-judge graders.

Routing is automatic. If a task carries a `skill_file_path` (a `SKILL.md`), the validator sends it to `sbevals` and polls for the result.

> **Legacy agent track (`.af`):** an older agent track (Letta + the Python `letta-evals` runner) still exists in the codebase and ships with the default stack, but it is **dormant**: agent challenges have been retired in favour of skills. You do not need to set up, configure, or think about Letta to run a validator. It is kept only so the agent track can be brought back if we ever run agent challenges again.

## Features

- ✅ **Secure Authentication**: Hotkey-based signature authentication
- ✅ **Skill Evaluation**: Routes skill (`.md`) submissions to the `sbevals` evaluator and submits scores
- ✅ **Bittensor Integration**: Computes weights **locally** from public competition data (current #1 miner takes `EMISSIONS_PERCENT`, remainder burned to UID 0) and submits them to subnet 121 — no central weight server
- ✅ **Robust Error Handling**: Comprehensive retry logic with exponential backoff
- ✅ **Health Monitoring**: Automatic heartbeats and HTTP health endpoints
- ✅ **Production Ready**: Dockerized, non-root user, health checks
- ✅ **Structured Logging**: Configurable log levels with structured output
- ✅ **Graceful Shutdown**: Handles SIGTERM/SIGINT properly

## System Requirements

### vCPU

- **Minimum**: 1 vCPU
- **Recommended**: 2+ vCPUs for better concurrent task processing
- The validator can process tasks sequentially or concurrently (configurable via `MAX_CONCURRENT_TASKS`)

### Memory

- **Minimum**: 2 GB RAM
- **Recommended**: 4 GB RAM or more
- Memory usage scales with:
  - Number of concurrent tasks (`MAX_CONCURRENT_TASKS`)
  - Task complexity (number of samples, file sizes)
  - The `sbevals` skill evaluator running alongside the validator

### Storage

- **Minimum**: 5 GB free disk space
- **Recommended**: 10+ GB for:
  - Docker images (~2-3 GB)
  - Temporary task files (cleaned up after processing by default)
  - Logs and working directory (`WORK_DIR`, defaults to `/tmp/validator-work`)
- Storage requirements increase if `KEEP_TASK_FILES=1` is set (for debugging)

### GPU

- **Not required**: The validator runs entirely on CPU
- No GPU dependencies or CUDA requirements
- All model inference is handled via third-party API calls (Chutes, OpenRouter, etc.)

### Third-Party API Requirements

Evaluating a skill challenge makes model-provider calls in two places: running the skill agent harness and running the LLM-as-judge graders. The validator (via `sbevals`) needs API keys for whichever providers the challenge's `suite.yaml` references.

**Most skill challenges run on Chutes or OpenRouter**, so prioritize those keys:

- `CHUTES_API_KEY` - Chutes provider (OpenAI-compatible API). Primary for most skill challenges.
- `OPENROUTER_API_KEY` - OpenRouter (multi-provider access). Primary for most skill challenges.

**Also supported** (set if a challenge's `suite.yaml` references them):

- `OPENAI_API_KEY` - OpenAI models (GPT-4, GPT-5, etc.)
- `ANTHROPIC_API_KEY` - Anthropic models (Claude)
- `GOOGLE_API_KEY` - Google models (Gemini)
- `TOGETHER_API_KEY` or `TOGETHERAI_API_KEY` - Together AI models
- `GITHUB_TOKEN` - GitHub personal access token for authenticated API requests (increases rate limits, useful if evaluations need GitHub access)

**Note**: The specific keys you need depend on the challenge's `suite.yaml` (the `provider` field selects which key is used). Since most skill challenges use Chutes or OpenRouter, setting `CHUTES_API_KEY` and `OPENROUTER_API_KEY` covers the common case.

**API Usage**:

- API calls happen during skill evaluation, in two places: running the skill agent harness (a test agent loaded with the `SKILL.md` makes LLM calls to produce outputs) and grading those outputs with LLM-as-judge graders
- Rate limits depend on your API provider plan
- Costs vary by provider and model used

## Prerequisites: a registered SN121 validator hotkey

A Bittensor wallet has two keys: a **coldkey** (holds your TAO and stake — keep it offline) and a **hotkey** (the operational key your validator signs with). The validator signs with the **hotkey**, which must be **registered on netuid 121 (finney mainnet) and hold a validator permit** before you start it — the validator never registers or stakes on-chain for you.

Set this up once with `btcli`, following Bittensor's own guides (use **netuid 121** wherever they ask for the subnet):

- [Wallets, coldkeys & hotkeys](https://docs.learnbittensor.org/keys/wallets) — create the wallet.
- [Validating in Bittensor](https://docs.learnbittensor.org/validators) — register the hotkey and add the stake needed for a validator permit.

This **hotkey** is what you give the validator — as `VALIDATOR_MNEMONIC` (its mnemonic), `HOTKEY_PATH` (the file at `~/.bittensor/wallets/<wallet>/hotkeys/<hotkey>`), or `PRIVATE_KEY`. The same key authenticates the coordinator API calls **and** signs the on-chain `setWeights` extrinsic — there is no separate weight-signing key. At weight-submission time the validator checks the metagraph and refuses if the hotkey isn't registered or lacks a permit.

## Quick Start

Run the validator with the **unified Docker Compose** stack at the repo root. It starts the validator alongside the `sbevals` skill evaluator, so a single `docker compose up -d` gives you a working node. (The stack also brings up the dormant Letta backend for the legacy agent track; it needs no configuration from you. See [the note below](#about-the-dormant-letta-services).)

### Steps

1. **Copy the example environment file:**

   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` and configure:**

   - Validator key: `VALIDATOR_MNEMONIC` (your existing **Bittensor validator hotkey**, 12-word phrase)
   - Coordinator URL: `API_URL` (e.g., `https://api.sundaebar.ai/api/v2/validators`)
   - Skill evaluator secret: `SBEVALS_API_KEY` (shared with the `sbevals` sidecar, see below)
   - Model-provider keys for the skill harness and graders (most challenges use `CHUTES_API_KEY` or `OPENROUTER_API_KEY`)

3. **Start all services:**

   ```bash
   docker compose up -d
   ```

4. **View logs:**

   ```bash
   docker compose logs -f             # all services
   docker compose logs -f validator   # just the validator
   docker compose logs -f sbevals     # just the skill evaluator
   ```

5. **Confirm health:**

   ```bash
   curl http://localhost:8080/health    # validator
   curl http://localhost:8090/health    # sbevals
   ```

6. **Stop all services:**

   ```bash
   docker compose down
   ```

### What Gets Started

- **sbevals**: Skill evaluation service (`sundaebarai/sn121-skill-evals:latest`) on port 8090. This is what evaluates skill (`.md`) challenges. The validator reaches it at `http://sbevals:8090`.
- **validator**: Validator service (`sundaebarai/sn121-validator:latest`) on port 8080 (health), automatically wired to `sbevals` (`SBEVALS_URL=http://sbevals:8090`).
- **watchtower**: Auto-updater that keeps the `sn121-validator`, `sn121-sbevals`, and `sn121-letta` images current (polls every 5 minutes).
- **letta-db** and **letta-server**: the dormant legacy agent backend. They start with default config and need no setup from you. See [the note below](#about-the-dormant-letta-services).

### Network

All services run on the same Docker network and reach each other by service name:

- Validator → skill evaluator: `http://sbevals:8090`
- No need for `host.docker.internal` when services share the compose file

### About the dormant Letta services

The default compose still launches `letta-db` and `letta-server` for the retired agent (`.af`) track. You do not need to set them up, provide Letta keys, or point anything at them to evaluate skill challenges. They are retained only so the agent track can be reactivated later. If you prefer not to run them at all, you can remove the `letta-db` and `letta-server` services (and the validator's `depends_on: letta-server`) from your local `docker-compose.yaml`.

### Environment Variables

The `.env` file is shared between all services. Key variables:

**Validator:**

- One of the following key options (required):
  - `VALIDATOR_MNEMONIC`: 12-word BIP39 mnemonic
  - `HOTKEY_PATH`: Path to a Bittensor hotkey JSON file (mount via Docker volume)
  - `PRIVATE_KEY`: Raw private key / hex seed (`0x...`)
- `API_URL`: Required — coordinator API endpoint
- `SBEVALS_URL`: Automatically set to `http://sbevals:8090` in `docker-compose.yaml` (no need to configure)

**Skill evaluator (`sbevals`):**

- `SBEVALS_API_KEY`: Shared secret between the validator and the `sbevals` sidecar. Compose passes the same value to the sidecar as `EVAL_SERVICE_API_KEY`, so set it once in `.env`.
- `CHUTES_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.: model-provider keys used to run the skill agent harness and the LLM-as-judge graders. Most skill challenges use Chutes or OpenRouter. The compose forwards all of them to `sbevals`; unset ones stay empty.

### Updating images

`watchtower` keeps the images current automatically (it polls every 5 minutes), so you normally don't need to do anything. To force an update immediately:

```bash
docker compose pull && docker compose up -d
```

### Building images

The compose consumes the published images, so `docker compose build` does nothing. The `sundaebarai/sn121-validator`, `sundaebarai/sn121-skill-evals`, and `sundaebarai/letta` images are all pulled from Docker Hub. To build the validator image from source instead (maintainers):

```bash
npm run docker:build     # multi-arch, tags :latest and :<package.json version>
npm run docker:push      # build and push to Docker Hub
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VALIDATOR_MNEMONIC` | One of three required | - | 12-word BIP39 mnemonic. Used for validator identity and signing Bittensor weight transactions. |
| `HOTKEY_PATH` | One of three required | - | Path to a Bittensor hotkey JSON file (reads `secretPhrase`). Mount via Docker volume when running in a container. |
| `PRIVATE_KEY` | One of three required | - | Raw private key / hex seed (`0x...`). |
| `API_URL` | Yes | - | Coordinator API URL (e.g., `https://api.sundaebar.ai/api/v2/validators`). Accepts a base URL or the full `…/api/v2/validators` path. Falls back to `http://localhost:3002` for local dev. |
| `DISPLAY_NAME` | No | - | Validator display name reported on registration. |
| `VERSION` | No | `1.0.0` | Validator version string reported to the coordinator. |
| `POLL_INTERVAL` | No | `5` | Poll interval in seconds. |
| `HEARTBEAT_INTERVAL` | No | `30` | Heartbeat interval in seconds. |
| `MAX_RETRIES` | No | `3` | Max retries for failed coordinator requests. |
| `RETRY_DELAY` | No | `1000` | Base retry delay in milliseconds (exponential backoff). |
| `LOG_LEVEL` | No | `info` | Log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`). |
| `WORK_DIR` | No | `/tmp/validator-work` | Working directory for per-task files. |
| `SBEVALS_URL` | No | `http://localhost:8090` | Skill evaluator base URL. The unified compose sets this to `http://sbevals:8090`. |
| `SBEVALS_API_KEY` | Yes | - | Sent as `X-Api-Key` to `sbevals`. **Must equal the sidecar's `EVAL_SERVICE_API_KEY`.** Compose keeps them in sync. |
| `SBEVALS_POLL_INTERVAL_SECONDS` | No | `5` | How often the validator polls `sbevals` for a job result. |
| `LETTA_EMBEDDING_WAIT_MINUTES` | No | `30` | Skill-task timeout in minutes (how long the validator waits for an `sbevals` job to finish). The legacy name is kept for backwards compatibility. |
| `LETTA_BASE_URL` | No | - | Optional. Legacy agent (`.af`) track only; unused for skill challenges. When unset, the validator runs skill-only. The compose sets it for the dormant Letta backend. |
| `SERVER_PORT` | No | `8080` | HTTP server port for health checks. |
| `MAX_CONCURRENT_TASKS` | No | `1` | Maximum number of tasks to process concurrently. |
| `KEEP_TASK_FILES` | No | - | Set to `1` to keep task files after processing (for debugging). |
| `EMISSIONS_PERCENT` | No | `0.2` | Share of weight paid to the current #1 miner; the rest is burned to UID 0 (`0.2` = 20% to the leader, 80% burned). |
| `BITTENSOR_WEIGHTS_INTERVAL_MINUTES` | No | `30` | Interval for recomputing and submitting weights (minutes). Also recomputed immediately when a newly scored submission changes the standings. |
| `BITTENSOR_WEIGHTS_DISABLED` | No | `false` | Set to `true` to disable on-chain weight submission (still computes and logs the target weights as a dry run). |
| `CHUTES_API_KEY` | No | - | Chutes provider key. Used by most skill challenges. |
| `OPENROUTER_API_KEY` | No | - | OpenRouter key. Used by most skill challenges. |
| `TOGETHERAI_API_KEY` | No | - | Alternative to `TOGETHER_API_KEY` for Together AI. |

> `MNEMONIC` is accepted as a **deprecated** alias for `VALIDATOR_MNEMONIC`.

### Skill track (`sbevals`) configuration

Skill (`.md`) tasks are evaluated by the `sbevals` service over HTTP. The validator submits the task payload, then polls for the result.

| Variable | Default | Description |
| --- | --- | --- |
| `SBEVALS_URL` | `http://localhost:8090` | Skill evaluator base URL. The unified compose sets this to `http://sbevals:8090`. |
| `SBEVALS_API_KEY` | — | Sent as `X-Api-Key` to `sbevals`. **Must equal the sidecar's `EVAL_SERVICE_API_KEY`.** Compose keeps them in sync. |
| `SBEVALS_POLL_INTERVAL_SECONDS` | `5` | How often the validator polls `sbevals` for a job result. |

**Note:** In the unified compose, `SBEVALS_API_KEY` (validator) and `EVAL_SERVICE_API_KEY` (sidecar) are populated from the same `.env` value, so they always match.

### Model Provider API Keys

Evaluating a skill challenge uses model-provider keys in two places, both run by `sbevals`:

1. **Skill agent harness**: a test agent is loaded with the submitted `SKILL.md` and makes LLM calls to produce outputs.
2. **LLM-as-judge graders**: the graders in `suite.yaml` score those outputs.

Set these keys in the **validator's** environment; the validator passes them through to `sbevals`. **Most skill challenges run on Chutes or OpenRouter**, so those are the keys to prioritize.

| Variable | Description |
| --- | --- |
| `CHUTES_API_KEY` | Chutes provider (OpenAI-compatible API). Primary for most skill challenges. |
| `OPENROUTER_API_KEY` | OpenRouter (multi-provider access). Primary for most skill challenges. |
| `OPENAI_API_KEY` | OpenAI models (GPT-4, GPT-5, etc.) |
| `ANTHROPIC_API_KEY` | Anthropic models (Claude) |
| `GOOGLE_API_KEY` | Google models (Gemini) |
| `TOGETHER_API_KEY` | Together AI models (alternative: `TOGETHERAI_API_KEY`) |
| `GITHUB_TOKEN` | GitHub personal access token (useful if evaluations need GitHub access) |

The evaluator picks the key based on the `provider` field in each grader's `suite.yaml` entry — and it can differ from one challenge to the next, so hold keys for every provider you expect to see:

```yaml
graders:
  quality:
    kind: model_judge
    model: deepseek-ai/DeepSeek-V3.1   # Model name
    provider: chutes                    # ← This determines which API key to use
```

- `provider: chutes` → uses `CHUTES_API_KEY`
- `provider: openrouter` → uses `OPENROUTER_API_KEY`
- `provider: openai` → uses `OPENAI_API_KEY`
- `provider: anthropic` → uses `ANTHROPIC_API_KEY`
- `provider: google` → uses `GOOGLE_API_KEY`
- `provider: together` → uses `TOGETHER_API_KEY` or `TOGETHERAI_API_KEY`

> **Legacy:** the retired agent (`.af`) track ran the agent on a Letta server with model keys configured on that server. That path is dormant and needs no key setup to evaluate skill challenges.

## How It Works

1. **Initialization**:
   - Creates the key pair from the mnemonic
   - Registers with the coordinator using hotkey + signature
   - Starts the heartbeat loop
   - Starts the weights submission loop (if configured)
2. **Task Processing**:
   - Polls the coordinator for queued tasks (`POST /api/v2/validators/tasks/poll`, with status + limit in the request body)
   - Claims the task
   - **Evaluates the skill**: a skill task carries a `skill_file_path` (a `SKILL.md`), which the validator submits to `sbevals`, then polls for the result. (Tasks without a `skill_file_path` fall through to the dormant legacy agent path.)
   - Uploads the raw evaluation output to the coordinator (for inspection)
   - Submits the compact, scored result back to the coordinator
   - Continues polling at the configured interval
3. **Heartbeat**:
   - Sends periodic heartbeats to maintain online status
   - Allows the coordinator to track validator availability
4. **Bittensor Weights (decided locally, not fetched)**:
   - The validator **decides weights itself** — it no longer asks the coordinator which weights to set.
   - Each cycle it pulls the active competition + leaderboard from the coordinator (read-only **data**), deterministically selects the current **#1 miner by score**, resolves that miner's hotkey → metagraph UID, and sets weights: **`EMISSIONS_PERCENT` (default 20%) to the leader, the remaining ~80% burned to UID 0**.
   - Recomputed on the periodic interval **and** immediately whenever a newly scored submission changes the standings.
   - Over a competition's lifetime, whoever holds #1 the longest collects the most emissions — "time at the top takes all" emerges from continuously paying the current leader.
   - If there is no active competition (or no eligible winner), 100% is burned to UID 0.
   - Validates validator status on subnet 121, then submits on-chain via the `setWeights` extrinsic. Can be disabled (dry run) with `BITTENSOR_WEIGHTS_DISABLED=true`.
5. **Error Handling**:
   - Automatic retries with exponential backoff
   - Network errors and 5xx responses are retried
   - Non-retryable errors (4xx) fail immediately
   - Graceful shutdown on errors

### Bittensor Weights Configuration

The validator **computes weights locally** from public competition data — the weight decision
lives in the validator, not on a central server. This is the core of the subnet's
decentralization: the coordinator is a **data source**, not the arbiter of emissions.

| Variable | Required | Description |
| --- | --- | --- |
| `EMISSIONS_PERCENT` | No | Share of weight paid to the current #1 miner; the rest is burned to UID 0. `0.2` = 20% to the leader, 80% burned. (default: `0.2`) |
| `BITTENSOR_WEIGHTS_INTERVAL_MINUTES` | No | How often to recompute + submit weights (default: 30 minutes). Weights are also recomputed immediately when a newly scored submission changes the standings. |
| `BITTENSOR_WEIGHTS_DISABLED` | No | Set to `true` to disable on-chain submission (still computes and logs the target weights as a dry run) |

**Note:** `VALIDATOR_MNEMONIC` is used for both validator identity and signing Bittensor weight transactions. If `BITTENSOR_WEIGHTS_DISABLED` is not set to `true`, a validator key is required.

**How it works:**

- Pulls the active competition + leaderboard from the coordinator (`GET /api/v2/validators/competitions/active`) — read-only **data**, not a weight verdict.
- Deterministically selects the current **#1 miner by score** (ties broken by earliest submission, then hotkey). The selection is pure and reproducible, so any validator running this code derives the same winner from the same data.
- Resolves the winner's hotkey → metagraph UID on subnet 121 (via the `getMetagraph` runtime API).
- Builds the weight vector: **`EMISSIONS_PERCENT` to the winner's UID, the remainder to UID 0 (burn)**. If there is no active competition or no eligible/resolvable winner, 100% is burned to UID 0.
- Validates that the validator account is registered on subnet 121 and holds a validator permit.
- Converts the float weights to integers scaled to sum to `10000` (range-checked against the u16 max of 65535) and submits on-chain via the Polkadot API (`setWeights` on finney, netuid 121).

**Winner-takes-all over the competition lifetime:** because each cycle pays whoever is #1
*right now*, the miner who holds the top spot the longest accumulates the most emissions —
i.e. "time at the top takes all", with the rest burned.

**Reproducibility:** after scoring a submission, the validator pushes the score back to the
coordinator with a `sha256` integrity hash over the canonical scoring inputs (task, competition,
miner/validator hotkeys, score, verdict, timestamp). The web app recomputes the same hash to
verify the displayed leaderboard matches what the validator actually scored.

**Example:**

```bash
docker run --rm \
  --env-file .env \
  -e VALIDATOR_MNEMONIC="your validator mnemonic here" \
  -e EMISSIONS_PERCENT=0.2 \
  -e BITTENSOR_WEIGHTS_INTERVAL_MINUTES=30 \
  -p 8080:8080 \
  sundaebarai/sn121-validator:latest
```

> The chain endpoint (`wss://entrypoint-finney.opentensor.ai:443`) and netuid (`121`) are hardcoded — there are no env vars for them.

## Security

- **Non-root user**: Docker container runs as a non-root user
- **Secure credentials**: Mnemonic and API keys should be stored securely (env vars, secrets manager)
- **Signature verification**: All coordinator requests are signed with the validator key (sr25519)
- **Timeout protection**: 30-second timeout on all API requests
- **Error isolation**: Errors in one task don't affect others
- **API key isolation**: Only required API keys are passed to child processes

## Development

```bash
# Install dependencies
npm install

# Run in development mode (ts-node)
npm run dev

# Build TypeScript
npm run build

# Run production build
npm start
```

### Testing

```bash
# Unit tests for the deterministic weight logic (winner selection, the
# EMISSIONS_PERCENT / burn split, and the integrity hash). No network or chain
# access required.
npm test

# Dry-run the weight DECISION against a mock (or file-provided) leaderboard and
# print the winner + weight targets, without a coordinator or a validator key:
npm run dry-run:weights
npm run dry-run:weights ./my-competition.json
EMISSIONS_PERCENT=0.3 npm run dry-run:weights
```

For a full end-to-end dry run against the real coordinator without touching the
chain, run the validator with `BITTENSOR_WEIGHTS_DISABLED=true` — it computes and
logs the target weights every cycle but never submits `setWeights`.

The coordinator-side API changes this validator depends on are specified in
[`docs/coordinator-api-prd.md`](docs/coordinator-api-prd.md).

## Logging

The validator uses structured logging with configurable levels:

- `trace`: Very detailed debugging
- `debug`: Debug information
- `info`: General information (default)
- `warn`: Warnings
- `error`: Errors
- `fatal`: Fatal errors

Set the log level via the `LOG_LEVEL` environment variable.

## Health Endpoints

The validator exposes HTTP endpoints for monitoring on port 8080 (configurable via `SERVER_PORT`):

- `GET /health` - Cheap liveness check for container/platform healthchecks. Never probes dependencies, so a down sidecar can't restart the validator. `running` is the real liveness signal.
- `GET /status` - Detailed validator status **plus live dependency checks** (see below)
- `GET /metrics` - Memory, uptime, task counts, and dependency status/latency summary

### Dependency checks on `/status`

`/status` probes each external dependency and reports per-dependency `status`, `latencyMs`, a human-readable `message`, and a `hint` when something is wrong:

| Dependency | Required | What is checked |
| --- | --- | --- |
| `sbevals` | Yes | `GET {SBEVALS_URL}/health` with the `X-Api-Key` header. Distinguishes **unreachable** (container down / wrong URL), **unauthorized** (`SBEVALS_API_KEY` ≠ sidecar's `EVAL_SERVICE_API_KEY`), and **degraded** (reachable but `SBEVALS_API_KEY` unset). |
| `coordinator` | Yes | Reachability of `API_URL`. Since coordinator endpoints require signed requests, authenticated health is reported separately via `validator.lastHeartbeat` and `validator.lastPoll` (timestamp, ok/error of the most recent signed heartbeat and task poll). |
| `letta` | No | `GET {LETTA_BASE_URL}/v1/health`. Reported as `disabled` when `LETTA_BASE_URL` is unset (skill-only mode). |

Possible per-dependency statuses: `ok`, `degraded`, `unauthorized`, `unreachable`, `error`, `disabled`. The top-level `status` is `degraded` unless the validator is running and every **required** dependency is `ok` — so a glance at `/status` tells you whether skill submissions can currently succeed.

Checks run in parallel with a 3s timeout (`DEPENDENCY_CHECK_TIMEOUT_MS`) and results are cached for 15s (`DEPENDENCY_CHECK_CACHE_SECONDS`), so `/status` and `/metrics` are safe to poll frequently.

## Troubleshooting

### "No key configured"

- Set one of `VALIDATOR_MNEMONIC` / `HOTKEY_PATH` / `PRIVATE_KEY`
- Check that the mnemonic is valid (12 words) and you replaced the placeholder in `.env.example`
- Note: `MNEMONIC` is a deprecated alias — prefer `VALIDATOR_MNEMONIC`

### "Failed to register evaluator" / 404 "Validator not found"

- Check that the coordinator API is reachable and `API_URL` is correct
- Verify your hotkey is registered on subnet 121
- Check network connectivity

### "No tasks available"

- This is normal — the validator will keep polling
- Make sure submissions are being processed on the coordinator
- Verify the validator is registered and online

### "Signature verification failed"

- Check that the mnemonic matches the registered hotkey
- Verify the coordinator is not in local bypass mode

### "Failed to submit bittensor weights"

- Verify `VALIDATOR_MNEMONIC` is set (the same hotkey mnemonic registered on subnet 121)
- Check that the account is registered as a validator on subnet 121 and holds a validator permit
- Ensure network connectivity to the Bittensor entrypoint
- Check logs for detailed error information

### `sbevals` errors or `401 Unauthorized`

- Verify `SBEVALS_URL` is reachable from the validator (in compose this is `http://sbevals:8090`)
- A `401` usually means `SBEVALS_API_KEY` does not match the sidecar's `EVAL_SERVICE_API_KEY`. In the unified compose both come from the same `.env` value, so check for a stale `.env` or an override.
- Check the sidecar logs: `docker compose logs -f sbevals`
- "polling timed out" means the job did not finish within `LETTA_EMBEDDING_WAIT_MINUTES`; check the sbevals logs for a stuck or failing grader (harness or judge)

### Missing or wrong model key

- A grader failed because the `provider` in `suite.yaml` has no matching key set. Most skill challenges use Chutes or OpenRouter, so make sure `CHUTES_API_KEY` / `OPENROUTER_API_KEY` are set.

> The dormant Letta services are not involved in skill evaluation. If you see Letta errors in the logs, they come from the unused legacy backend and do not affect skill challenges.

## Architecture

```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐
│ Coordinator │◄─────┤   Validator  │──────►│   sbevals   │
│    API      │      │              │      │ (skill eval)│
└─────────────┘      └──────┬───────┘      └─────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │  Bittensor   │
                    │   Network    │
                    └──────────────┘
```

## License

ISC
