'use strict';

// Only the authenticated orchestrator supplies this immutable publication scope.
// Entries are exact repository paths or directory prefixes ending in '/'.
function validateAllowedPaths(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw Object.assign(new Error('Нужен явный список разрешённых файлов'),{status:400});
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || entry.length > 500 || entry !== entry.trim() ||
        entry.startsWith('/') || /[\x00-\x1f\x7f\\:*?\[\]{}]/.test(entry)) {
      throw Object.assign(new Error('Некорректная область файлов запуска'),{status:400});
    }
    const parts = (entry.endsWith('/') ? entry.slice(0,-1) : entry).split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) {
      throw Object.assign(new Error('Некорректная область файлов запуска'),{status:400});
    }
  }
  return [...value];
}

module.exports = {validateAllowedPaths};
