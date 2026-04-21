# Sundae Bar - Unified Docker Compose Setup

This unified Docker Compose setup runs both Letta and the Validator together, making it easy to deploy and manage both services.

## Quick Start

1. **Copy the example environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` and configure:**
   - Letta API keys (for agent execution)
   - Validator mnemonic (generate with `cd sn121 && npm run generate-keys`)
   - Validator API URL (coordinator endpoint)
   - Model provider API keys (for graders)

3. **Start all services:**
   ```bash
   docker compose up -d
   ```

4. **View logs:**
   ```bash
   # All services
   docker compose logs -f
   
   # Just Letta
   docker compose logs -f letta_server
   
   # Just Validator
   docker compose logs -f validator
   ```

5. **Stop all services:**
   ```bash
   docker compose down
   ```

## Services

- **letta_db**: PostgreSQL database with pgvector extension
- **letta_server**: Letta API server (ports 8083, 8283)
- **letta_nginx**: Nginx reverse proxy (port 80, optional)
- **validator**: Validator service (connects to letta_server automatically)

## Network

All services run on the `sundae-bar-network` bridge network, so they can communicate using service names:
- Validator connects to Letta via: `http://letta-server:8283`
- No need for `host.docker.internal` when services are in the same compose file

## Environment Variables

See `.env.example` for all available configuration options.

### Key Variables:

**Letta:**
- `CHUTES_API_KEY`: Chutes API key (if using Chutes provider)
- `OPENAI_API_KEY`: OpenAI API key (if using OpenAI)
- Other provider keys as needed

**Validator:**
- `VALIDATOR_MNEMONIC`: Required - mnemonic phrase for validator identity
- `VALIDATOR_API_URL`: Required - coordinator API endpoint
- `LETTA_BASE_URL`: Automatically set to `http://letta-server:8283` (no need to configure)

## Building Validator Image

If you need to rebuild the validator image:
```bash
docker compose build validator
```

## Development Mode

For development with live code reloading, you can use the dev-compose files:
```bash
# Letta with dev mode
docker compose -f docker-compose.yaml -f letta/dev-compose.yaml up -d --build letta_server
```
