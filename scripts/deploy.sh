#!/usr/bin/env bash
set -euo pipefail

# Sundae Bar Validator Deployment Script
# This script helps deploy the validator Docker container

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-sundae-bar-validator:latest}"
ENV_FILE="${ENV_FILE:-$VALIDATOR_DIR/.env}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if .env file exists
if [ ! -f "$ENV_FILE" ]; then
    error "Missing $ENV_FILE"
    info "Create it from env.example:"
    echo "  cp $VALIDATOR_DIR/env.example $ENV_FILE"
    echo "  # Then edit $ENV_FILE and set your values"
    exit 1
fi

# Check for required variables
source "$ENV_FILE" 2>/dev/null || true

if [ -z "${MNEMONIC:-}" ] || [ "$MNEMONIC" = "word1 word2 word3 ..." ]; then
    error "MNEMONIC is not set or is still the placeholder"
    info "Use your existing Bittensor validator hotkey mnemonic (the same one you use for subnet 121)"
    info "Then update MNEMONIC in $ENV_FILE"
    exit 1
fi

if [ -z "${API_URL:-}" ]; then
    error "API_URL is not set"
    exit 1
fi

if [ -z "${LETTA_BASE_URL:-}" ]; then
    error "LETTA_BASE_URL is not set"
    exit 1
fi

# Build Docker image
info "Building Docker image: $IMAGE_NAME"
cd "$VALIDATOR_DIR"
docker build -t "$IMAGE_NAME" .

if [ $? -ne 0 ]; then
    error "Docker build failed"
    exit 1
fi

info "Build successful!"

# Ask if user wants to run the container
read -p "Do you want to run the validator now? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    info "Starting validator container..."
    docker run --rm \
        --env-file "$ENV_FILE" \
        -p 8080:8080 \
        "$IMAGE_NAME"
else
    info "To run the validator, use:"
    echo "  docker run --rm --env-file $ENV_FILE -p 8080:8080 $IMAGE_NAME"
fi
