import { describe, expect, it } from 'vitest';

import { autocompleteFor, detectInputType, resolveInputType } from './input-type.js';

describe('detectInputType', () => {
  it.each([
    ['ORACLE_PASSWORD', 'password'],
    ['DB_PASS', 'password'],
    ['PGPASSWORD', 'password'],
    ['API_KEY', 'password'],
    ['ACCESS_KEY', 'password'],
    ['GITHUB_TOKEN', 'password'],
    ['CLIENT_SECRET', 'password'],
    ['AUTH_HEADER', 'password'],
    ['PRIVATE_KEY', 'password'],
    ['SMTP_PWD', 'password'],
    ['USER_MAIL', 'email'],
    ['EMAIL', 'email'],
    ['ORACLE_USER', 'text'],
    ['DB_HOST', 'text'],
    ['PORT', 'text'],
  ] as const)('classifies %s as %s', (name, expected) => {
    expect(detectInputType(name)).toBe(expected);
  });
});

describe('resolveInputType', () => {
  it('prefers the explicit placeholder type over everything', () => {
    expect(resolveInputType('ORACLE_PASSWORD', 'text', { input: 'email' })).toBe('text');
  });

  it('falls back to the config metadata before detection', () => {
    expect(resolveInputType('DB_HOST', undefined, { input: 'url' })).toBe('url');
  });

  it('detects from the name when nothing is explicit', () => {
    expect(resolveInputType('DB_PASSWORD', undefined, undefined)).toBe('password');
  });
});

describe('autocompleteFor', () => {
  it('uses real autocomplete tokens so the browser can save values', () => {
    expect(autocompleteFor('X', 'password')).toBe('current-password');
    expect(autocompleteFor('X', 'email')).toBe('email');
    expect(autocompleteFor('DB_HOST', 'text')).toBe('section-db_host on');
  });
});
