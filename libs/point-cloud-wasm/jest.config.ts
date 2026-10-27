module.exports = {
  displayName: 'point-cloud-wasm',
  preset: '../../jest.preset.ts',
  globals: {
    'ts-jest': {
      tsconfig: '<rootDir>/tsconfig.spec.json',
      // wasm-engine.ts uses import.meta, which ts-jest (CommonJS) rejects; the transformer stubs it.
      diagnostics: { ignoreCodes: [1343] },
      astTransformers: { before: ['<rootDir>/tests/import-meta-transformer.cjs'] },
    },
  },
  transform: {
    '^.+\\.[tj]s$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  moduleNameMapper: {
    // Sources use explicit .js extensions for ESM; map them back to the .ts files.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // The engine and parser import values from the sibling lib through the path alias.
    '^@dp-software/point-cloud$': '<rootDir>/../point-cloud/src/index.ts',
  },
  coverageDirectory: '../../coverage/libs/point-cloud-wasm',
};
