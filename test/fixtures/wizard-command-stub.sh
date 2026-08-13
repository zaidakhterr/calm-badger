#!/usr/bin/env bash

set -euo pipefail

case "$(basename "$0"):$*" in
  gh:--version)
    printf 'gh version 2.83.2\n'
    ;;
  gh:"auth status")
    ;;
  git:"remote get-url origin")
    printf 'https://example.com/rfq-relay.git\n'
    ;;
  pnpm:--version)
    printf '11.21.0\n'
    ;;
  pnpm:"exec wrangler --version")
    printf '4.121.0\n'
    ;;
  pnpm:"exec wrangler whoami")
    ;;
  *)
    printf 'Unexpected mocked command: %s %s\n' "$(basename "$0")" "$*" >&2
    exit 1
    ;;
esac
