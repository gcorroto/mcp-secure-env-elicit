import { type InputType, type SecretMeta } from '../schemas/wrapper-config.js';

// Variable names matching this pattern are rendered as password inputs unless
// the config says otherwise, so credentials never echo on screen by accident.
const SENSITIVE_NAME =
  /(pass(word)?|pwd|secret|token|credential|api[_-]?key|access[_-]?key|private[_-]?key|auth)/i;

const EMAIL_NAME = /mail/i;

/** Infer an input type from the variable name alone. */
export function detectInputType(name: string): InputType {
  if (SENSITIVE_NAME.test(name)) {
    return 'password';
  }

  if (EMAIL_NAME.test(name)) {
    return 'email';
  }

  return 'text';
}

/**
 * Resolve the input type for a secret field. Priority: the explicit type in
 * the placeholder (`${secure:NAME:type}`), then the `secrets` metadata in the
 * config file, then detection from the variable name, then plain text.
 */
export function resolveInputType(
  name: string,
  placeholderType: InputType | undefined,
  meta: SecretMeta | undefined,
): InputType {
  return placeholderType ?? meta?.input ?? detectInputType(name);
}

/**
 * The `autocomplete` attribute for a field. Real autocomplete tokens (instead
 * of `off`) are what let the browser save submitted values and re-propose
 * them the next time the form is shown.
 */
export function autocompleteFor(name: string, input: InputType): string {
  switch (input) {
    case 'password':
      return 'current-password';
    case 'email':
      return 'email';
    case 'url':
      return 'url';
    case 'tel':
      return 'tel';
    default:
      // `on` lets the browser offer previously submitted values for this
      // field name; `section-` scopes them per variable so values do not
      // bleed between unrelated fields.
      return `section-${name.toLowerCase()} on`;
  }
}
