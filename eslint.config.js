import globals from 'globals';

const correctnessRules = {
  'constructor-super': 'error',
  'for-direction': 'error',
  'getter-return': 'error',
  'no-async-promise-executor': 'error',
  'no-class-assign': 'error',
  'no-compare-neg-zero': 'error',
  'no-const-assign': 'error',
  'no-control-regex': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-else-if': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-ex-assign': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-invalid-regexp': 'error',
  'no-loss-of-precision': 'error',
  'no-new-native-nonconstructor': 'error',
  'no-obj-calls': 'error',
  'no-promise-executor-return': 'error',
  'no-self-assign': 'error',
  'no-setter-return': 'error',
  'no-sparse-arrays': 'error',
  'no-this-before-super': 'error',
  'no-undef': 'error',
  'no-unexpected-multiline': 'error',
  'no-unreachable': 'error',
  'no-unreachable-loop': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-unused-labels': 'error',
  'no-useless-backreference': 'error',
  'no-useless-catch': 'error',
  'no-useless-escape': 'error',
  'no-with': 'error',
  'require-yield': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error'
};

export default [
  { ignores: ['node_modules/**', 'src/sidepanel/lib/**', 'typst-side-agent.zip', 'plans/**'] },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions }
    },
    rules: correctnessRules
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    },
    rules: correctnessRules
  },
  {
    files: ['test/browser/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions }
    }
  }
];
