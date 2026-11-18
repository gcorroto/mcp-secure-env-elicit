# Specification

## Requirement: Publicación npm desde CI

As a maintainer, I want releases to be published exclusively by Jenkins, so that npm publication follows the shared CI standard.

#### Scenario: Configuración del job

- GIVEN el repositorio de la librería
- WHEN Jenkins carga el Jenkinsfile de la raíz
- THEN el fichero contiene exactamente `@Library('jenkins-voip-reporter@main') _` y `publishNpmLibrary(nodeImage: 'node:22')` en líneas separadas

#### Scenario: Patch automático

- GIVEN un push a `main` que no es una actualización de versión minor o major
- WHEN Jenkins procesa el cambio
- THEN incrementa el patch, crea el commit `chore(release): vX.Y.Z [ci skip]` y el tag `vX.Y.Z`, y publica en npm

#### Scenario: Preparación de minor o major

- GIVEN un mantenedor que solicita una nueva versión minor o major
- WHEN ejecuta respectivamente `npm run release:minor` o `npm run release:major`
- THEN se incrementa la versión sin crear tag, se crea el commit `chore(release): vX.Y.0` sin `[ci skip]` y se hace push
- AND Jenkins publica esa versión sin volver a incrementarla

#### Scenario: Scripts de versión y publicación

- GIVEN los scripts de `package.json`
- WHEN se inspeccionan los comandos de versión y release
- THEN `version:patch`, `version:minor` y `version:major` ejecutan `npm version` con el tipo correspondiente y `--no-git-tag-version`
- AND ningún script ejecuta `npm publish`
- AND los demás scripts existentes permanecen sin cambios

#### Scenario: Documentación y verificación

- GIVEN el cambio preparado para revisión
- WHEN se revisan el README y el paquete
- THEN la sección «Releasing» explica el patch automático en CI, los comandos minor y major, la publicación exclusiva desde CI y que CI usa `node:22` porque los tests necesitan `git`
- AND el campo `version` conserva su valor anterior al cambio
- AND `npm run check` termina correctamente
