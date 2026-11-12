# Specification

## Requirement: Portable stdio path expansion

As a shared-config author, I want portable path variables expanded at stdio startup, so that the same configuration works on each developer's machine.

#### Scenario: Built-in variables in spawn fields

- GIVEN a stdio server has `${home}`, `${tmpdir}`, `${env:NAME}`, `${env:NAME:-default}`, or a leading `~/` in an argument, environment value, or cwd
- WHEN the server starts
- THEN each expression resolves using the wrapper process's home, temporary directory, or environment as appropriate, and path separators in expanded paths match the current operating system
- AND surrounding argument or environment text remains intact

#### Scenario: Missing environment variable

- GIVEN a stdio template references an unset environment variable without a fallback
- WHEN the server starts
- THEN startup fails before spawning with a message naming the missing variable

#### Scenario: Environment fallback

- GIVEN a stdio template references `${env:NAME:-default}` and NAME is unset or empty
- WHEN the server starts
- THEN the fallback is used

#### Scenario: Existing secrets remain supported

- GIVEN a server uses `${secure:NAME}` in a supported field
- WHEN the server starts with the secret available
- THEN the secret resolves as before and remains separate from local path settings

## Requirement: Per-user path settings

As a developer, I want locally configurable path values with shared defaults, so that team configuration can run without sharing my filesystem paths.

#### Scenario: Configure and reuse a path

- GIVEN a shared config declares a named path setting with input type `path`, kind `file` or `directory`, a default, and optional `createParent`
- AND a stdio server references that setting as `${path:NAME}` in args, env, or cwd
- WHEN the server starts and no local override exists
- THEN the expanded, valid absolute default is used in every reference without prompting for that path

#### Scenario: Display and save an override

- GIVEN a path setting is available on the local configuration form
- WHEN the developer opens the form
- THEN it is shown as a text input, not a browser file picker, prefilled with the expanded default or existing local override
- WHEN the developer submits a valid override
- THEN it is saved in a local non-secret settings file and used for subsequent starts, including after wrapper restart
- AND it is not saved into the shared config or the encrypted secret vault, nor requested as a secret

#### Scenario: Invalid path value

- GIVEN a default or submitted override expands to a relative or otherwise invalid path
- WHEN it is validated server-side
- THEN the value is rejected with a useful validation message and no child is spawned with that value

#### Scenario: Create parent before spawn

- GIVEN a valid path setting has `createParent: true` and its parent directory does not exist
- WHEN a server using the setting starts
- THEN the parent directory is created before the child is spawned
- AND a creation failure prevents spawn and is reported

#### Scenario: Paths do not collide across shared configs

- GIVEN two distinct shared config sources declare a path setting with the same name
- WHEN a developer overrides the setting for one source
- THEN the other source retains its own default or override

## Requirement: Document local path configuration

As a shared-config author, I want the path syntax and storage behavior documented, so that developers can configure and override paths safely.

#### Scenario: Shared session file example

- GIVEN a reader follows the documented shared-config example
- WHEN `AYG_SESSION_FILE` defaults to `${home}/.ayg-sesiones/ayg-session.json` and is referenced by both stdio env and the `--storage-state` argument
- THEN both resolve to the same user's absolute path on Windows, macOS, and Linux without a path prompt when the default is valid
- AND the documentation describes expansion, missing environment variables, validation, local overrides, storage location, and the distinction from secrets
