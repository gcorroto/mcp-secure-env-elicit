# Tasks

## 1. Portable test expectations

- [ ] 1.1 Update the spawn-fields test in `src/application/path-settings.test.ts` to expect the current platform's normalized `/tmp/a` in args and env while retaining the `secret` and cwd assertions; compute the expected path without widening the production signature (Scenario: Path and secret templates in spawn fields).
- [ ] 1.2 Review `src/application/path-settings.test.ts`, `src/adapters/http/path-settings.test.ts`, and the path-related cases in `tests/child-server-manager.test.ts` for hard-coded separators, temporary paths, manually joined cwd paths, and platform-dependent absolute-path assumptions; fix any nonportable expectations without skipping or removing cases (Scenario: Path-settings coverage across platforms).
- [ ] 1.3 Confirm production path normalization behavior is unchanged; explain any necessary production file edit in the PR (Scenario: Existing path normalization remains unchanged).

## 2. Verification

- [ ] 2.1 Run `npm run check` on Linux and Windows, covering lint, typecheck, tests, and build; record results and any unavailable platform validation (Scenario: Project checks pass).
