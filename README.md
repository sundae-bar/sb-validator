# sundae_bar Validator

Secure validator client for sundae_bar SN121 subnet. This validator polls for evaluation tasks, processes them, and submits results back to the coordinator.

## Features

- ✅ **Secure Authentication**: Hotkey-based signature authentication
- ✅ **Task Processing**: Polls, claims, and evaluates agent submissions
- ✅ **Bittensor Integration**: Submits weights to Bittensor subnet 121 based on leader performance
- ✅ **Robust Error Handling**: Comprehensive retry logic with exponential backoff
- ✅ **Health Monitoring**: Automatic heartbeats and HTTP health endpoints
- ✅ **Production Ready**: Dockerized, non-root user, health checks
- ✅ **Structured Logging**: Configurable log levels with structured output
- ✅ **Graceful Shutdown**: Handles SIGTERM/SIGINT properly

## Quick Start

There are two recommended ways to run the validator:

- **Option A (recommended)**: Use the **unified Docker Compose** setup at the repo root to run **both Letta (our fork)** and the validator together.
- **Option B**: Run the validator container by itself and point it at an existing Letta server (self-hosted).

If you're not sure which to pick, **start with Option A**; it will run Letta and the validator for you with a single `docker compose up -d`.

### Option A: Unified Docker Compose (Letta + Validator)

**Recommended for most users.** This runs both Letta (our fork) and the validator together.

#### Quick Start

1. **Copy the example environment file:**

   ```bash
   cd validator
   cp .env.example .env
   ```

2. **Edit `.env` and configure:**
   - Letta API keys (for agent execution), e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
   - Validator mnemonic: `VALIDATOR_MNEMONIC` (your existing **Bittensor validator hotkey**, 12-word phrase)
   - Validator API URL: `API_URL` (coordinator endpoint, e.g., `https://api.sundaebar.ai/api/v2/validators`)
   - Model provider API keys for graders (same keys used by Letta)

3. **Start all services:**

   ```bash
   docker compose up -d
   ```

4. **View logs:**

   ```bash
   # All services
   docker compose logs -f
   
   # Just Letta
   docker compose logs -f letta-server
   
   # Just Validator
   docker compose logs -f validator
   ```

5. **Stop all services:**

   ```bash
   docker compose down
   ```

#### What Gets Started

- **letta-db**: PostgreSQL database with pgvector extension
- **letta-server**: Letta API server using our fork (`sundaebarai/letta:latest`) on ports 8083, 8283
- **validator**: Validator service (`sundaebarai/sn121-validator:latest`) on port 8080, automatically configured to connect to Letta via `LETTA_BASE_URL=http://letta-server:8283`
- **watchtower**: Optional auto-updater for images

#### Network

All services run on the same Docker network, so they can communicate using service names:
- Validator connects to Letta via: `http://letta-server:8283`
- No need for `host.docker.internal` when services are in the same compose file

#### Environment Variables

The `.env` file is shared between all services. Key variables:

**For Letta:**
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. (for agent execution)
- `LETTA_PG_USER`, `LETTA_PG_PASSWORD`, `LETTA_PG_DB` (database config, defaults provided)

**For Validator:**
- `VALIDATOR_MNEMONIC`: Required – your Bittensor validator hotkey mnemonic
- `API_URL`: Required – coordinator API endpoint
- `LETTA_BASE_URL`: Automatically set to `http://letta-server:8283` in `docker-compose.yaml` (no need to configure)
- Model provider API keys (for graders, same as Letta)

#### Building Images

If you need to rebuild the validator image:

```bash
docker compose build validator
```

The Letta image (`sundaebarai/letta:latest`) is pulled from Docker Hub and doesn't need to be built locally.

### Option B: Standalone Validator (existing Letta server)

#### 1. Configure Environment

You'll need your **existing Bittensor validator hotkey mnemonic**. This is the same mnemonic you use for your Bittensor validator on subnet 121.

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` and set:
- `VALIDATOR_MNEMONIC`: Your **Bittensor validator hotkey mnemonic** (the same 12-word phrase you use for subnet 121)
- `API_URL`: Coordinator API URL (e.g., `https://api.sundaebar.ai/api/v2/validators`)
- `LETTA_BASE_URL`: URL of your running Letta server (e.g., `http://localhost:8283` or `http://letta-server:8283`)

#### 2. Run Locally

```bash
npm install
npm run dev
```

#### 3. Build and Run with Docker

**Using the deployment script:**

```bash
# Make script executable (first time only)
chmod +x scripts/deploy.sh

# Run deployment script
./scripts/deploy.sh
```

The script will:
- Check that `.env` file exists and is configured
- Build the Docker image (`sundae-bar-validator:latest`)
- Optionally run the container

**Or use manual Docker commands:**

```bash
# Build image
docker build -t sundae-bar-validator:latest .

# Run with environment variables
docker run --rm --env-file .env -p 8080:8080 sundae-bar-validator:latest
```

Or with inline environment variables:

```bash
# Note: Use host.docker.internal for Mac/Windows, or your host IP for Linux
docker run --rm \
  -e VALIDATOR_MNEMONIC="your mnemonic here" \
  -e API_URL="http://host.docker.internal:3002/api/v2/validators" \
  -e LETTA_BASE_URL="http://host.docker.internal:8283" \
  -e DISPLAY_NAME="My Validator" \
  -e OPENAI_API_KEY="your-openai-key" \
  -e ANTHROPIC_API_KEY="your-anthropic-key" \
  -e GITHUB_TOKEN="ghp_your_token" \
  -e MAX_STEPS="10" \
  -p 8080:8080 \
  sundae-bar-validator:latest
```

**Important for Docker:** When running in Docker, `localhost` refers to the container, not your host machine. Use:
- **Mac/Windows**: `host.docker.internal` (e.g., `http://host.docker.internal:3002/api/v2/validators`)
- **Linux**: Your host machine's IP address or use `--network host`

**Note:** The `API_URL` can include the full path (e.g., `http://host.docker.internal:3002/api/v2/validators`) or just the base URL (e.g., `http://host.docker.internal:3002`). The validator will automatically handle both formats.

**Example with Local Letta Server:**

```bash
docker run --rm \
  --env-file .env \
  -e LETTA_BASE_URL="http://localhost:8283" \
  -e OPENAI_API_KEY="sk-..." \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  sundae-bar-validator:latest
```


## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VALIDATOR_MNEMONIC` | Yes | - | Bittensor validator hotkey mnemonic (12-word phrase). Also used for signing Bittensor weight transactions. |
| `API_URL` | Yes | - | Coordinator API URL. Can be base URL (e.g., `http://localhost:3002`) or full path (e.g., `http://localhost:3002/api/v2/validators`) |
| `DISPLAY_NAME` | No | - | Validator display name |
| `VERSION` | No | `1.0.1` | Validator version |
| `POLL_INTERVAL` | No | `5` | Poll interval in seconds |
| `HEARTBEAT_INTERVAL` | No | `30` | Heartbeat interval in seconds |
| `MAX_RETRIES` | No | `3` | Max retries for failed requests |
| `RETRY_DELAY` | No | `1000` | Retry delay in milliseconds |
| `LOG_LEVEL` | No | `info` | Log level (trace, debug, info, warn, error, fatal) |
| `WORK_DIR` | No | `/tmp/validator-work` | Working directory for task files |
| `LETTA_BASE_URL` | Yes | - | Letta server URL (e.g., `http://localhost:8283`) |
| `GITHUB_TOKEN` | No | - | GitHub personal access token for authenticated API requests (increases rate limits) |
| `MAX_STEPS` | No | `10` | Maximum number of agent steps/tool calls per evaluation sample |
| `BITTENSOR_WEIGHTS_INTERVAL_MINUTES` | No | `30` | Interval for fetching and submitting Bittensor weights (minutes) |
| `BITTENSOR_WEIGHTS_DISABLED` | No | `false` | Set to `true` to disable on-chain weight submission (still fetches and logs) |
| `BITTENSOR_VALIDATOR_SECRET` | No | - | **Deprecated**: Use `VALIDATOR_MNEMONIC` instead. Legacy support for backwards compatibility. |
| `SERVER_PORT` | No | `8080` | HTTP server port for health checks |
| `MAX_CONCURRENT_TASKS` | No | `1` | Maximum number of tasks to process concurrently |
| `KEEP_TASK_FILES` | No | - | Set to `1` to keep task files after processing (for debugging) |
| `LETTA_EMBEDDING_WAIT_MINUTES` | No | `30` | Maximum time to wait for file embeddings to complete |
| `LETTA_EVALS_PYTHON` | No | `python3` | Python command to use for running letta-evals |
| `LETTA_EVALS_MODULE` | No | `letta_evals.cli` | Python module to use for letta-evals CLI |
| `LETTA_URL` | No | - | Alternative to `LETTA_BASE_URL` (deprecated, use `LETTA_BASE_URL`) |
| `TOGETHERAI_API_KEY` | No | - | Alternative to `TOGETHER_API_KEY` for Together AI |

### Model Provider API Keys

There are **two different uses** for API keys in the evaluation process:

#### 1. **Agent Execution** (Running the `.af` file)

The agent itself (defined in the `.af` file) specifies which model it uses. For example, an agent might be configured with:
```json
{
  "llm_config": {
    "model": "gpt-4.1-mini",
    "provider_name": "openai",
    "handle": "openai/gpt-4.1-mini"
  }
}
```

**For Local Letta Server:**
The Letta server needs API keys configured on the **server side** (not in the validator). When you start your local Letta server, set environment variables:
```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
# etc.
letta server
```

#### 2. **Grading/Evaluation** (Model Judges)

The graders in the suite.yaml use API keys passed to `letta-evals` by the validator. These are the API keys you set in the validator's environment:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | No* | OpenAI API key (for GPT grader models) |
| `ANTHROPIC_API_KEY` | No* | Anthropic API key (for Claude grader models) |
| `GOOGLE_API_KEY` | No* | Google API key (for Gemini grader models) |
| `OPENROUTER_API_KEY` | No* | OpenRouter API key (for multi-provider access) |
| `TOGETHER_API_KEY` | No* | Together AI API key (alternative: `TOGETHERAI_API_KEY`) |
| `GITHUB_TOKEN` | No | GitHub personal access token (passed to letta-evals, useful if evaluations need GitHub access) |

\* At least one model provider API key is required for evaluations to run (for the graders).

**How Grader API Key Selection Works:**

`letta-evals` determines which API key to use for graders based on the `provider` field in the suite configuration (suite.yaml):

```yaml
graders:
  quality:
    kind: model_judge
    model: gpt-5-mini        # Model name
    provider: openai          # ← This determines which API key to use
```

When `provider: openai` is specified, `letta-evals` will use `OPENAI_API_KEY`. Similarly:
- `provider: openai` → uses `OPENAI_API_KEY`
- `provider: anthropic` → uses `ANTHROPIC_API_KEY`
- `provider: google` → uses `GOOGLE_API_KEY`
- `provider: openrouter` → uses `OPENROUTER_API_KEY`
- `provider: together` → uses `TOGETHER_API_KEY` or `TOGETHERAI_API_KEY`

**Summary:**
- **Agent models**: Configured in the `.af` file, API keys needed on the **Letta server** (self-hosted)
- **Grader models**: Configured in `suite.yaml` with `provider` field, API keys needed in the **validator** environment

### Letta Configuration

When running the validator standalone (Option B), you need to point it at an existing Letta server:

| Variable | Required | Description |
|----------|----------|-------------|
| `LETTA_BASE_URL` | Yes | Letta server URL (e.g., `http://localhost:8283` for local, `http://letta-server:8283` for Docker Compose, or `https://your-letta-server.com` for remote) |

**Note:** If using Option A (unified Docker Compose), `LETTA_BASE_URL` is automatically set to `http://letta-server:8283` and you don't need to configure it.



## How It Works

1. **Initialization**:
   - Creates key pair from mnemonic
   - Registers with coordinator using hotkey + signature
   - Starts heartbeat loop
   - Starts weights submission loop (if configured)

2. **Task Processing**:
   - Polls coordinator for tasks (`GET /api/v2/validators/tasks?hotkey=...&status=queued`)
   - Claims tasks and processes them
   - Uploads files to Letta server
   - Runs `letta-evals` with appropriate API keys
   - Uploads raw evaluation output to coordinator
   - Submits compact results back to coordinator
   - Continues polling at configured interval

3. **Heartbeat**:
   - Sends periodic heartbeats to maintain online status
   - Allows coordinator to track validator availability

4. **Bittensor Weights**:
   - Periodically fetches weights from coordinator based on leader performance
   - Validates validator status on subnet 121
   - Submits weights on-chain via `setWeights` extrinsic
   - Can be disabled with `BITTENSOR_WEIGHTS_DISABLED=true`

5. **Error Handling**:
   - Automatic retries with exponential backoff
   - Network errors and 5xx responses are retried
   - Non-retryable errors (4xx) fail immediately
   - Graceful shutdown on errors

### Bittensor Weights Configuration

The validator can submit weights to the Bittensor network based on leader performance:

| Variable | Required | Description |
|----------|----------|-------------|
| `BITTENSOR_WEIGHTS_INTERVAL_MINUTES` | No | Interval for fetching weights (default: 30 minutes) |
| `BITTENSOR_WEIGHTS_DISABLED` | No | Set to `true` to disable on-chain submission (still fetches and logs) |
| `BITTENSOR_VALIDATOR_SECRET` | No | **Deprecated**: Use `VALIDATOR_MNEMONIC` instead |

**Note:** `VALIDATOR_MNEMONIC` is used for both validator identity and signing Bittensor weight transactions. If `BITTENSOR_WEIGHTS_DISABLED` is not set to `true`, `VALIDATOR_MNEMONIC` is required.

**How it works:**
- Fetches weights from coordinator API based on leader minutes in the time window
- Validates that the validator account is registered on subnet 121
- Converts floating-point weights (0.0-1.0) to u16 integers (0-65535)
- Submits weights on-chain via Polkadot API
- Logs detailed information about the submission process

**Example:**
```bash
docker run --rm \
  --env-file .env \
  -e VALIDATOR_MNEMONIC="your validator mnemonic here" \
  -e BITTENSOR_WEIGHTS_INTERVAL_MINUTES=30 \
  -p 8080:8080 \
  sundae-bar-validator:latest
```

## Security

- **Non-root user**: Docker container runs as non-root user
- **Secure credentials**: Mnemonic and API keys should be stored securely (env vars, secrets manager)
- **Signature verification**: All requests are signed with private key
- **Timeout protection**: 30-second timeout on all API requests
- **Error isolation**: Errors in one task don't affect others
- **API key isolation**: Only required API keys are passed to child processes

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build TypeScript
npm run build

# Run production build
npm start
```

## Logging

The validator uses structured logging with configurable levels. Log levels:

- `trace`: Very detailed debugging
- `debug`: Debug information
- `info`: General information (default)
- `warn`: Warnings
- `error`: Errors
- `fatal`: Fatal errors

Set log level via `LOG_LEVEL` environment variable.

## Health Endpoints

The validator exposes HTTP endpoints for monitoring:

- `GET /health` - Basic health check
- `GET /status` - Detailed validator status
- `GET /metrics` - Memory and uptime metrics

These endpoints are available on port 8080 by default (configurable via `SERVER_PORT`).

## Troubleshooting

### "Mnemonic is required"
- Make sure `VALIDATOR_MNEMONIC` environment variable is set
- Check that mnemonic is valid (12 words)
- Note: `MNEMONIC` is deprecated, use `VALIDATOR_MNEMONIC` instead

### "Failed to register evaluator"
- Check that coordinator API is running
- Verify `API_URL` is correct
- Check network connectivity

### "No tasks available"
- This is normal - validator will keep polling
- Make sure briefs are being processed on coordinator
- Verify evaluator is registered and online

### "Signature verification failed"
- Check that mnemonic matches the registered hotkey
- Verify coordinator is not in local bypass mode

### "Failed to submit bittensor weights"
- Verify `VALIDATOR_MNEMONIC` is set (same as your validator hotkey mnemonic)
- Check that the account is registered as a validator on subnet 121
- Ensure network connectivity to Bittensor entrypoint
- Check logs for detailed error information
- Note: `BITTENSOR_VALIDATOR_SECRET` is deprecated, use `VALIDATOR_MNEMONIC` instead

### "Letta API error" or "502 Bad Gateway"
- Verify `LETTA_BASE_URL` is correct and accessible
- Check that Letta server is running
- Ensure network connectivity between validator and Letta server

## Architecture

```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐
│ Coordinator │◄─────┤   Validator   │──────►│ Letta Server│
│    API      │      │              │      │             │
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

