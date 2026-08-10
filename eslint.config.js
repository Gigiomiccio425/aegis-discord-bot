// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/db/generated/**',
      'apps/web/dist/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Il progetto usa spesso `void promise` per gli handler di eventi, dove
      // attendere bloccherebbe il gateway.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Le classi di caratteri combinanti (rilevamento zalgo) sono scritte con
      // sequenze di escape: in quella forma non c'è ambiguità su quali punti
      // di codice siano inclusi.
      'no-misleading-character-class': ['error', { allowEscape: true }],
    },
  },
);
