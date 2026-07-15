/** @type {import('jest').Config} */
module.exports = {
  displayName: 'admin-web',
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', {
      useESM: true,
      tsconfig: '<rootDir>/tsconfig.app.json'
    }]
  },
  moduleNameMapper: {
    '\\.(css|less|scss)$': '<rootDir>/src/test/style-mock.cjs'
  },
  clearMocks: true,
  restoreMocks: true
}
