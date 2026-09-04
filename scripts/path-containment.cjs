/* eslint-disable @typescript-eslint/no-require-imports -- Shared with CommonJS Electron build hooks. */
const path = require('node:path');

function isPathInside(base, candidate, pathApi = path) {
  const value = pathApi.relative(base, candidate);
  return value === '' || (
    value !== '..' &&
    !value.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(value)
  );
}

module.exports = {isPathInside};
