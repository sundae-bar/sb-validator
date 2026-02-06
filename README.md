# Sundae Bar Validator

Secure validator client for Sundae Bar SN121 subnet. This validator polls for evaluation tasks, processes them, and submits results back to the coordinator.

## Features

- ✅ **Secure Authentication**: Hotkey-based signature authentication
- ✅ **Robust Error Handling**: Comprehensive retry logic with exponential backoff
- ✅ **Health Monitoring**: Automatic heartbeats to maintain online status
- ✅ **Production Ready**: Dockerized, non-root user, health checks
- ✅ **Structured Logging**: Pino-based logging with configurable levels
- ✅ **Graceful Shutdown**: Handles SIGTERM/SIGINT properly

## Quick Start

### 1. Generate Keys

First, generate a mnemonic and hotkey:

```bash
cd ../sn121
npm run generate-keys
```

Save the mnemonic securely - you'll need it to run the validator.

### 2. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` and set:
- `MNEMONIC`: Your mnemonic phrase
- `API_URL`: Coordinator API URL (e.g., `http://localhost:3002` or `http://localhost:3002/api/v2/validators`)

### 3. Run Locally

```bash
npm install
npm run dev
```

### 4. Build and Run with Docker

```bash
# Build image
docker build -t sn121-validator .

# Run with environment variables
docker run --rm --env-file .env sn121-validator
```

Or with inline environment variables:

```bash
# Note: Use host.docker.internal for Mac/Windows, or your host IP for Linux
docker run --rm \
  -e MNEMONIC="your mnemonic here" \
  -e API_URL="http://host.docker.internal:3002/api/v2/validators" \
  -e DISPLAY_NAME="My Validator" \
  -e OPENAI_API_KEY="your-openai-key" \
  -e ANTHROPIC_API_KEY="your-anthropic-key" \
  -p 8080:8080 \
  -p 8283:8283 \
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
| `MNEMONIC` | Yes | - | Mnemonic phrase for key pair |
| `API_URL` | Yes | - | Coordinator API URL. Can be base URL (e.g., `http://localhost:3002`) or full path (e.g., `http://localhost:3002/api/v2/validators`) |
| `DISPLAY_NAME` | No | - | Validator display name |
| `VERSION` | No | `1.0.0` | Validator version |
| `POLL_INTERVAL` | No | `5` | Poll interval in seconds |
| `HEARTBEAT_INTERVAL` | No | `30` | Heartbeat interval in seconds |
| `MAX_RETRIES` | No | `3` | Max retries for failed requests |
| `RETRY_DELAY` | No | `1000` | Retry delay in milliseconds |
| `LOG_LEVEL` | No | `info` | Log level (trace, debug, info, warn, error, fatal) |
| `WORK_DIR` | No | `/tmp/validator-work` | Working directory for task files |

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

**For Letta Cloud:**
API keys are managed in your Letta Cloud account settings. You configure which models/providers you want to use in the Letta Cloud dashboard.

#### 2. **Grading/Evaluation** (Model Judges)

The graders in the suite.yaml use API keys passed to `letta-evals` by the validator. These are the API keys you set in the validator's environment:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | No* | OpenAI API key (for GPT grader models) |
| `ANTHROPIC_API_KEY` | No* | Anthropic API key (for Claude grader models) |
| `GOOGLE_API_KEY` | No* | Google API key (for Gemini grader models) |
| `OPENROUTER_API_KEY` | No* | OpenRouter API key (for multi-provider access) |
| `TOGETHER_API_KEY` | No* | Together AI API key (alternative: `TOGETHERAI_API_KEY`) |

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
- **Agent models**: Configured in the `.af` file, API keys needed on the **Letta server** (local or cloud)
- **Grader models**: Configured in `suite.yaml` with `provider` field, API keys needed in the **validator** environment

### Letta Configuration

The validator now expects an existing Letta server. Configure one of the supported modes below.

#### Self-hosted Letta server (preferred for validators)

Run a Letta server yourself (for example using the `../letta-server` Docker Compose setup) and point the validator at it:

| Variable | Required | Description |
|----------|----------|-------------|
| `LETTA_BASE_URL` | Yes | Letta server URL (e.g., `http://localhost:8283` or `http://letta-server:8283`) |

**Example:**
```bash
docker run --rm \
  -e MNEMONIC="..." \
  -e API_URL="http://localhost:3002/api/v2/validators" \
  -e LETTA_BASE_URL="http://host.docker.internal:8283" \
  -e OPENAI_API_KEY="sk-..." \
  sundae-bar-validator:latest
```



## How It Works

1. **Initialization**:
   - Creates key pair from mnemonic
   - Registers with coordinator using hotkey + signature
   - Starts heartbeat loop

2. **Polling**:
   - Polls coordinator for tasks (`GET /api/v2/validators/tasks?hotkey=...&status=queued`)
   - Claims tasks and processes them
   - Runs `letta-evals` with appropriate API keys
   - Submits results back to coordinator
   - Continues polling at configured interval

3. **Heartbeat**:
   - Sends periodic heartbeats to maintain online status
   - Allows coordinator to track validator availability

4. **Error Handling**:
   - Automatic retries with exponential backoff
   - Network errors and 5xx responses are retried
   - Non-retryable errors (4xx) fail immediately
   - Graceful shutdown on errors

## Letta Server Setup

There are two supported ways to provide a Letta server:

1. **Self-hosted (recommended for validators)**  
   - Use the `letta-server/` directory in this repo.  
   - Copy `env.letta.example` → `.env.letta`, fill in your model API keys, then run `docker compose up -d`.  
   - Set `LETTA_BASE_URL` (e.g., `http://host.docker.internal:8283` or `http://your-server:8283`) when launching the validator container.

Graders still need their own API keys in the validator environment (OpenAI, Anthropic, etc.) so `letta-evals` can call the requested judge models.

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

The validator uses structured logging with Pino. Log levels:

- `trace`: Very detailed debugging
- `debug`: Debug information
- `info`: General information (default)
- `warn`: Warnings
- `error`: Errors
- `fatal`: Fatal errors

Set log level via `LOG_LEVEL` environment variable.

## Next Steps

Currently, the validator only logs tasks. Future enhancements:

1. **Task Claiming**: Claim tasks before processing
2. **File Handling**: Decode base64 files from task payload
3. **Evaluation**: Run letta-evals on tasks
4. **Result Submission**: Submit evaluation results back to coordinator

## Troubleshooting

### "Mnemonic is required"
- Make sure `MNEMONIC` environment variable is set
- Check that mnemonic is valid (12 words)

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

## License

ISC

