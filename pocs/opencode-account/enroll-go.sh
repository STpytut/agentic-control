#!/usr/bin/env bash
# The OpenCode 1.18.3 CLI login prompt does not consume a piped API key.
# Keeping the old helper would tempt operators to use an unverified or leaky
# workaround. Enrollment is therefore available only through the in-app broker,
# which encrypts in-browser and uses the authenticated localhost server API.
set -eu
echo "Manual CLI enrollment is disabled: use Settings > OpenCode Go > Connect." >&2
exit 2
