const base = require('/home/user/workspace/wt/B-CI-116-1/jest.config.js');
const t = base.transform['^.+\\.ts$'];
module.exports = { ...base, rootDir: '/home/user/workspace/wt/B-CI-116-1',
  transform: { ...base.transform, '^.+\\.ts$': ['ts-jest', { ...t[1], tsconfig: { ...t[1].tsconfig, isolatedModules: true } }] } };
