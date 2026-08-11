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
  {
    /*
     * Il supervisore del container è JavaScript puro, non TypeScript: gira
     * dentro l'immagine senza passare da una compilazione, perché è il primo
     * processo ad avviarsi e non può dipendere dal risultato della build che
     * sta per lanciare.
     *
     * Senza questo blocco ESLint non conosce i globali di Node e segnala
     * `console`, `setTimeout` e `process` come non definiti.
     */
    files: ['docker/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
);
