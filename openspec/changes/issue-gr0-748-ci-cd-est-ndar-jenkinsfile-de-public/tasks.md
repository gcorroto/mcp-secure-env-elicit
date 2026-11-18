# Tasks

## 1. Configuración y documentación

- [x] 1.1 Crear el `Jenkinsfile` raíz con las dos líneas exactas indicadas en GR0-748 (Scenario: Configuración del job).
- [x] 1.2 Añadir en `package.json` los cinco scripts `version:patch`, `version:minor`, `version:major`, `release:minor` y `release:major` exactamente como indica GR0-748; conservar los demás scripts y el campo `version` (Scenario: Preparación de minor o major; Scenario: Scripts de versión y publicación).
- [x] 1.3 Añadir al README una sección «Releasing» de cuatro líneas que describa el estándar sin detalles internos del pipeline (Scenario: Documentación y verificación).

## 2. Verificación local

- [x] 2.1 Comprobar el contenido exacto del Jenkinsfile y los cinco scripts, incluidos el commit y push de minor/major sin tag ni publicación (Scenario: Configuración del job; Scenario: Preparación de minor o major; Scenario: Scripts de versión y publicación).
- [x] 2.2 Comprobar que ningún script ejecuta `npm publish`, que los demás scripts no cambian, que `version` conserva su valor anterior y que el README cumple el formato solicitado (Scenario: Scripts de versión y publicación; Scenario: Documentación y verificación).
- [x] 2.3 Instalar las dependencias según el lockfile y ejecutar `npm run check` (Scenario: Documentación y verificación).

## Verificación tras el despliegue

- [ ] Comprobar en Jenkins que un push a `main` produce el patch, commit con `[ci skip]`, tag y publicación, y que una versión minor o major ya preparada se publica sin incrementarla de nuevo (Scenario: Patch automático; Scenario: Preparación de minor o major).
