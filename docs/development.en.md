# Apex development

[简体中文](development.md) | **English**

This repository maintains the upstream version lock, Apex-owned packages, and launch scripts. The official DeepSeek Harness checkout in `.submodules/deepseek-harness` stays read-only. The [package directory](../packages/README.en.md) follows `packages/<group>/<pkg>/` and currently contains documentation only, with no implemented Apex packages.

The official OpenHarmony 7.0 manifest is in `.submodules/openharmony`; complete source is obtained or reused outside the project. See [OpenHarmony source](openharmony.en.md) for the baseline, prerequisites, and verification steps. The build and run commands below target Harness and do not produce an OpenHarmony system image.

## Build and run

Use Git, tar, a supported Node.js version starting at 22.19, Python 3.10 or later, and initialized official submodules. First make the pnpm version declared in the root `package.json` `packageManager` field available, currently 11.7.0; check it with `pnpm --version`. All development entry points use pnpm, and dependency installation preserves the lockfile.

The root `pnpm-workspace.yaml` includes only the root command entry point and disables automatic dependency installation before `pnpm run`, keeping dependencies out of the root. The upstream workspace and its dependencies live in the external working directory.

```sh
pnpm run verify
pnpm run install:runtime
pnpm run build
pnpm run dsh --help
pnpm run web --no-open
```

Official source is exported unchanged outside the project under `~/.cache/apex/workspaces/`, alongside dependencies and build outputs. Run `pnpm run prepare:runtime` to see the exact directory and verify source contents and file modes against the locked Git tree. Set `APEX_WORKSPACE_DIR` to choose another external directory. Existing unrelated directories are rejected, and modified source files are never overwritten.

CLI and Web commands retain the caller's project directory and use the official default interface. User data defaults to `~/.dsh`, with `DSH_HOME` available as an override. `pnpm run dev:web` watches and rebuilds Web source; run `pnpm run web` separately to serve it. The standalone desktop application is outside the current build scope.

## Validate and edit

```sh
pnpm run test --maxWorkers=4
pnpm run lint
pnpm run doc-sync
pnpm run verify
```

`pnpm run verify` checks both upstream version locks, source entry points, the Paper submodule, and repository layout. `pnpm run test:wrapper` runs the Apex launcher, Paper validation, CI scope, and OpenHarmony acquisition and verification tests; `pnpm run test` then runs the official Harness default tests, with each part executed once. Ordinary CI does not download complete OpenHarmony source or build a system image. Verify a complete external checkout with `pnpm run oh:verify --source-dir <external-source-directory>`.

Forward other upstream commands through `pnpm run runtime <command> [arguments]`. Build, test, and documentation checks run in the external workspace using the pinned release's original tests. Implement Apex extensions in `packages/<group>/<pkg>/`. Groups are containers; source and package configuration belong inside each package. Do not copy or link upstream packages. Apex package builds and loading require separate integration. Edits in a generated directory do not automatically become repository changes.

## CI check scope

Pushes to `main` / `master`, pull requests, and manual runs still trigger CI. `pnpm run ci:scope` examines the event's complete change range. Lightweight checks apply only when the sole change updates the Git commit pointer of the existing `.submodules/deepseek-harness-paper` submodule.

- Lightweight checks run `pnpm run paper:verify` and `pnpm run test:ci` to validate the Paper source, Git pointer, actual checkout, and working tree, and test the Paper validator and CI scope logic. They do not install Harness dependencies or run Harness builds and tests.
- All other changes retain full CI, including Harness, OpenHarmony, Apex code, version locks, `.gitmodules`, CI configuration, and mixed changes. Adding or removing the Paper submodule also requires full checks.
- First pushes, manual runs, unavailable comparison bases, and uncertain change ranges use full checks. Pushes compare the entire `before..after` range. Pull requests qualify for lightweight checks only after the checked-out merge commit is confirmed to match the event's base/head commits.

Paper is pinned by the parent repository's Git pointer, without a duplicate version lock. `pnpm run paper:verify` only reads and validates the designated official source and local checkout; it does not switch versions or repair anything. Lightweight and full checks each have a CI run record, with the selected scope shown in the run summary.

## PowerShell in CI

The pinned persistent terminal forwards PTY data but does not answer cursor-position queries. PowerShell on Linux waits for a response, causing startup and subsequent commands to time out. The CI [environment setup](../.github/workflows/ci.yml) generates a launcher in the runner's temporary directory. Only the official interactive arguments `-NoLogo -NoProfile` receive PTY input settings and a pipe that forwards stdout unchanged to the terminal. This makes .NET use redirected-output behavior without cursor queries. Stdin remains a real PTY and the console remains interactive. PSReadLine is disabled because it does not support redirected output, avoiding an exception and fallback to basic input at every prompt. Other PowerShell invocations pass through unchanged. The output relay reads a nonzero file descriptor so upstream does not mistake it for a shell waiting for user input.

Startup also loads the built-in `Microsoft.PowerShell.Management` and `Microsoft.PowerShell.Utility` modules and runs `Set-Location -LiteralPath $PWD.Path` in the original directory to complete first-use initialization for filesystem commands and ordinary output. Otherwise, the first directory change can remain silent while loading that module for longer than the upstream test's 300 ms idle threshold, yielding `inferred_idle` before the command finishes. This initialization preserves the working directory and neither changes that threshold nor fabricates readiness.

This adapter is limited to headless CI tests. It changes no official source or tests and excludes no failing cases. The [real-terminal check](../scripts/ci/verify-pwsh.py), invoked through `pnpm run test:ci:pwsh`, verifies the unchanged startup directory, interactive input, UTF-8 output, and nonzero exit codes before the complete default suite runs once with two workers. This reduces contention from process-heavy tests around short readiness-detection windows without changing upstream timeouts or assertions.

Keep backups and validation logs outside the project. Preserve the backups you need instead of clearing the repository or restoring the full upstream tree to its root. Handle upstream upgrades separately from feature changes. Commits and pushes still require explicit authorization.
