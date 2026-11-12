# Tasks

## 1. Configuration and expansion

- [x] 1.1 Extend the config schema with named non-secret path settings, file/directory kind, default, and optional createParent; define `${path:NAME}` references (Requirement: Per-user path settings).
- [x] 1.2 Implement platform-aware built-in expansion in stdio args, env, and cwd, including unset and empty environment behavior, while preserving surrounding text and existing secret resolution (Scenarios: Built-in variables in spawn fields, Missing environment variable, Environment fallback, Existing secrets remain supported).
- [x] 1.3 Add tests for schema validation and expansion on Windows, macOS, and Linux path semantics, missing variables, fallbacks, and secure placeholders (Scenarios: Built-in variables in spawn fields, Missing environment variable, Environment fallback, Existing secrets remain supported).

## 2. Local settings and form

- [x] 2.1 Implement local non-secret settings persistence scoped by stable config-source identity, with overrides taking precedence over defaults across restarts (Scenarios: Configure and reuse a path, Paths do not collide across shared configs).
- [x] 2.2 Add a way to open and submit path settings independently of secret collection; render text inputs prefilled with expanded defaults or overrides and keep paths out of the vault and shared config (Scenario: Display and save an override).
- [x] 2.3 Validate expanded defaults and submitted overrides as absolute paths server-side and return actionable errors without spawning on invalid input (Scenario: Invalid path value).
- [x] 2.4 Test default display, override submission, persistence across restart, source isolation, invalid and valid paths, and separation from secrets (Scenarios: Configure and reuse a path, Display and save an override, Invalid path value, Paths do not collide across shared configs).

## 3. Startup and documentation

- [x] 3.1 Resolve path settings consistently in stdio args, env, and cwd; use valid defaults without prompting and create requested parent directories before spawning, reporting failures (Scenarios: Configure and reuse a path, Create parent before spawn).
- [x] 3.2 Test startup with matching env and argument values, no prompt for a valid default, parent creation before spawn, and failure preventing spawn (Scenarios: Configure and reuse a path, Create parent before spawn, Shared session file example).
- [x] 3.3 Document the path config and reference format, local storage and override behavior, expansion and errors, validation, and the AYG_SESSION_FILE shared-config example (Scenario: Shared session file example).
