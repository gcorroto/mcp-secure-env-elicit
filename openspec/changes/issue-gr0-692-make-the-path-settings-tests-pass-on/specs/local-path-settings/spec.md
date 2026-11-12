# Specification

## Requirement: Portable path-settings tests

As a developer, I want path-settings tests to run on Windows, macOS, and Linux, so that the same checks verify path behavior on each platform.

#### Scenario: Path and secret templates in spawn fields

- GIVEN a stdio server uses `${path:SESSION}` in its arguments and environment and `${secure:TOKEN}` in its arguments
- WHEN the templates resolve with SESSION set to `/tmp/a` and TOKEN set to `secret`
- THEN the test asserts that the argument and environment path use the current operating system's normalized separators
- AND the test asserts that the secret argument is `secret` and the cwd resolves

#### Scenario: Path-settings coverage across platforms

- GIVEN the application path-settings tests, HTTP path-settings tests, and path-related child-server-manager tests
- WHEN the tests run on Windows, macOS, or Linux
- THEN their path expectations and absolute-path checks are valid for the current operating system
- AND every case runs without a platform-specific skip or removal

#### Scenario: Existing path normalization remains unchanged

- GIVEN path expansion normalizes separators for the current operating system
- WHEN the portability tests are updated
- THEN production path normalization behavior remains unchanged

#### Scenario: Project checks pass

- GIVEN the updated tests and project dependencies
- WHEN `npm run check` runs on Windows or Linux
- THEN lint, typecheck, tests, and build pass
