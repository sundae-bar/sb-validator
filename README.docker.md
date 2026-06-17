# Sundae Bar — Unified Docker Compose Setup

This `docker-compose.yaml` runs a complete SN121 validator stack on one host:
the validator, its Letta agent runtime, and the in-house skill evaluator
(`sb_evals`). Every image is pulled from Docker Hub — no source clone needed.

> Skill (`.md`) submissions are graded by the bundled **sbevals** sidecar; agent
> (`.af`) submissions go through **letta-server**. Both run locally.

## Quick Start

1. **Copy the example environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` and configure** (see [Environment Variables](#environment-variables)):
   - A validator key: one of `VALIDATOR_MNEMONIC`, `HOTKEY_PATH`, or `PRIVATE_KEY`
   - `API_URL` — coordinator endpoint (defaults to `https://api.sundaebar.ai/api/v2/validators`)
   - `SBEVALS_API_KEY` — shared secret between the validator and the sbevals sidecar
   - Model provider keys for the graders / agent runtime (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TOGETHER_API_KEY`)

3. **Start all services:**
   ```bash
   docker compose up -d
   ```

4. **View logs:**
   ```bash
   docker compose logs -f                  # all services
   docker compose logs -f validator        # just the validator
   docker compose logs -f letta-server     # just Letta
   docker compose logs -f sbevals          # just the skill evaluator
   ```

5. **Stop all services:**
   ```bash
   docker compose down
   ```

## Services

| Compose service | Container | Image | Port |
|---|---|---|---|
| `letta-db` | `sn121-letta-db` | `ankane/pgvector:v0.5.1` | — (internal) |
| `letta-server` | `sn121-letta` | `sundaebarai/letta:latest` | `8283` |
| `sbevals` | `sn121-sbevals` | `sundaebarai/sn121-skill-evals:latest` | `8090` |
| `validator` | `sn121-validator` | `sundaebarai/sn121-validator:latest` | `8080` (health) |
| `watchtower` | `sn121-watchtower` | `containrrr/watchtower:latest` | — |

The validator `depends_on` both `letta-server` and `sbevals` being healthy
before it starts. `watchtower` polls every 300s and auto-updates the
`sn121-validator`, `sn121-letta`, and `sn121-sbevals` containers when a new
`:latest` is published.

## Network

All services share the default Compose network and reach each other by service
name — no `host.docker.internal` needed. The compose file wires the validator
automatically:

- Validator → Letta via `LETTA_BASE_URL=http://letta-server:8283`
- Validator → skill evaluator via `SBEVALS_URL=http://sbevals:8090`

You do not set `LETTA_BASE_URL` or `SBEVALS_URL` yourself in this setup — they
are fixed in `docker-compose.yaml`.

## Environment Variables

The `.env` file is shared across services. See `.env.example` for the full,
documented list. The essentials:

**Validator identity (pick one):**
- `VALIDATOR_MNEMONIC` — 12-word BIP39 mnemonic
- `HOTKEY_PATH` — path to a Bittensor hotkey JSON file (resolve it under the
  mounted wallet dir, e.g. `/home/validator/.bittensor/wallets/<wallet>/hotkeys/<hotkey>`)
- `PRIVATE_KEY` — raw private key / hex seed (`0x...`)

**Validator config:**
- `API_URL` — coordinator API endpoint (required; default `https://api.sundaebar.ai/api/v2/validators`)
- `SBEVALS_API_KEY` — shared secret for the sbevals sidecar. The compose passes
  this same value to the sidecar as `EVAL_SERVICE_API_KEY=${SBEVALS_API_KEY}`, so
  the two are guaranteed to match — set it in one place.

**Model providers** (graders + agent runtime; set the ones your stack uses):
- `OPENROUTER_API_KEY` — default sbevals skill harness
- `OPENAI_API_KEY` — `model_judge` grader / OpenAI agents
- `ANTHROPIC_API_KEY`
- `TOGETHER_API_KEY` — Letta agent execution

**Letta database** — `LETTA_PG_USER` / `LETTA_PG_PASSWORD` / `LETTA_PG_DB`
default to `letta` and can be left unset for local use.

## Wallets

The validator container mounts your host wallet directory read-only:

```yaml
volumes:
  - ${HOME}/.bittensor/wallets:/home/validator/.bittensor/wallets:ro
```

This is what makes the `HOTKEY_PATH` option work — point `HOTKEY_PATH` at a file
under `/home/validator/.bittensor/wallets/...` inside the container.

## Updating images

`watchtower` handles updates automatically. To pull the latest manually:

```bash
docker compose pull && docker compose up -d
```

## Building the validator image locally

This compose consumes the published image (no `build:` stanza), so
`docker compose build` has nothing to build. To produce the image from source:

```bash
npm run docker:build     # multi-arch build, tags :latest + :<package.json version>
npm run docker:push      # build and push to Docker Hub (publisher account)
```

The `sundaebarai/letta` and `sundaebarai/sn121-skill-evals` images are built and
published separately; this compose only consumes them.

## Running without the bundled Letta (standalone)

If you already run a Letta server, or want to run the validator on its own
against an external Letta + sbevals, see **Option B: Standalone Validator** in
[`README.md`](./README.md).
