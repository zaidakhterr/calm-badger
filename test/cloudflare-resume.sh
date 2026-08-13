#!/usr/bin/env bash

set -euo pipefail

REPOSITORY_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_DIRECTORY=$(mktemp -d)
trap 'rm -rf "$TEST_DIRECTORY"' EXIT

mkdir -p "$TEST_DIRECTORY/bin"
for command_name in gh git pnpm; do
  ln -s "$REPOSITORY_ROOT/test/fixtures/wizard-command-stub.sh" \
    "$TEST_DIRECTORY/bin/$command_name"
done

SETUP_STATE_FILE="$TEST_DIRECTORY/setup.vars"
printf '%s\n' \
  'INFRA_SLUG=calm-badger' \
  'CLOUDFLARE_API_TOKEN=saved-cloudflare-token' \
  'CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef' \
  > "$SETUP_STATE_FILE"

set +e
OUTPUT=$(
  printf '\ny\n' | env \
    PATH="$TEST_DIRECTORY/bin:$PATH" \
    SETUP_STATE_FILE="$SETUP_STATE_FILE" \
    WIZARD_DRY_RUN=1 \
    bash "$REPOSITORY_ROOT/scripts/setup-infrastructure.sh" 2>&1
)
STATUS=$?
set -e

[[ "$STATUS" -ne 0 ]] || {
  printf 'Expected the wizard to stop at the next unanswered confirmation.\n' >&2
  exit 1
}

[[ "$OUTPUT" == *"Cloudflare authentication is ready."* ]] || {
  printf 'The wizard did not authenticate using the saved credentials.\n%s\n' "$OUTPUT" >&2
  exit 1
}

[[ "$OUTPUT" != *"Paste the Cloudflare deployment token:"* ]] || {
  printf 'The wizard prompted for an already-saved Cloudflare token.\n' >&2
  exit 1
}

[[ "$OUTPUT" != *"Paste the Cloudflare Account ID:"* ]] || {
  printf 'The wizard prompted for an already-saved Cloudflare Account ID.\n' >&2
  exit 1
}
