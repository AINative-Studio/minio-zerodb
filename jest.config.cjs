module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.cjs'],
  // coverage.test.cjs uses the native node:test runner (see its own header
  // comment) and has no jest describe/it/expect globals — jest picking it
  // up produces a spurious "must contain at least one test" failure even
  // though its 21 real tests pass fine under `node --test`. Run it via
  // `npm run test:coverage` instead (wired into `npm test` as a second step).
  testPathIgnorePatterns: ['/node_modules/', 'coverage.test.cjs'],
  transform: {},
};
