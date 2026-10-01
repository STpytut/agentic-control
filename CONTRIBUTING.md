# Contributing

Thank you for your interest. The project is pre-1.0 and maintained by one
person, so the most useful contributions right now are:

- **Bug reports from a real installation.** Include `sudo infra-cod doctor --json`,
  the release version and what you expected.
- **Install reports.** Did a clean Ubuntu 24.04 server get to a working panel?
  Where did it stop?
- **Small, focused pull requests.** For anything larger, open an issue first so
  we can agree on the approach before you spend time on it.

## Before a pull request

1. **Sign the [Contributor License Agreement](CLA.md).** The CLA check on your
   first pull request asks for it. It lets the project stay AGPL-3.0 while also
   being offered under a commercial license.
2. **Run the suites.** `scripts/run-suites-in-container.sh` runs them in the same
   environment as CI. It tests the committed `HEAD`, so commit first.
3. **Keep the change in one pull request.** A database change is a new numbered
   migration in `db/migrations/` with a test in `db/tests/` and an entry in
   `db/schema-compatibility.json`.

## Conventions

- Commit messages follow `type(scope): what changed`. The body says why.
- Comments explain why, not what. A rule that came from a production incident
  says which one.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
