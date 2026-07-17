import { describe, expect, it } from 'vitest';

import { createSecretVault } from './secret-vault.js';

describe('createSecretVault', () => {
  it('round-trips values through encryption', () => {
    const vault = createSecretVault();
    vault.set('A', 'value-a');
    vault.set('B', 'v@lué-β with spaces');

    expect(vault.reveal(['A', 'B'])).toEqual({ A: 'value-a', B: 'v@lué-β with spaces' });
  });

  it('reports missing names', () => {
    const vault = createSecretVault();
    vault.set('A', 'x');

    expect(vault.has('A')).toBe(true);
    expect(vault.has('B')).toBe(false);
    expect(vault.missing(['A', 'B', 'C', 'B'])).toEqual(['B', 'C']);
  });

  it('throws when revealing an unknown secret', () => {
    const vault = createSecretVault();

    expect(() => vault.reveal(['NOPE'])).toThrow("Secret 'NOPE' is not in the vault");
  });

  it('overwrites an existing value', () => {
    const vault = createSecretVault();
    vault.set('A', 'first');
    vault.set('A', 'second');

    expect(vault.reveal(['A'])).toEqual({ A: 'second' });
  });

  it('refuses to work after dispose', () => {
    const vault = createSecretVault();
    vault.set('A', 'x');
    vault.dispose();

    expect(vault.has('A')).toBe(false);
    expect(() => { vault.set('B', 'y'); }).toThrow('disposed');
  });
});
