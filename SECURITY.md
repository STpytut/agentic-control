# Security policy

Agentic Control runs AI agents with write access to your code and holds
credentials for GitHub and for AI providers. Please report vulnerabilities
privately.

## How to report

Use GitHub's **private vulnerability reporting**: open the repository's
**Security** tab and select **Report a vulnerability**. Please include:

- the affected version (`infra-cod version`);
- the steps to reproduce;
- what an attacker gains.

You will get an acknowledgement within a few days. Do not open a public issue,
and do not test against an installation you do not own.

## Supported versions

Only the latest release candidate receives fixes while the project is pre-1.0.

## Design

The threat model and the boundaries between the panel, the database, the
workers and the agent runtimes are described in
[docs/SECURITY.md](docs/SECURITY.md).
