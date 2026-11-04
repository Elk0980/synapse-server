'use strict';

// Project layers execute outside the task sandbox (MCP/hooks) and may replace
// its permission profile. Do not load them for this fixed code-only executor.
const fs = require('node:fs/promises');
const path = require('node:path');
const reject = () => { throw Object.assign(new Error('PROJECT_CONFIG_UNSUPPORTED'),{code:'PROJECT_CONFIG_UNSUPPORTED'}); };
const absent = error => ['ENOENT','ENOTDIR'].includes(error.code);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;

async function assertNoProjectConfig(cwd,{ownerHomes=[]}={}) {
  if (!path.isAbsolute(cwd || '')) reject();
  let real;
  try { real = await fs.realpath(cwd); if (!(await fs.stat(real)).isDirectory()) reject(); }
  catch { reject(); }
  const globalHomes = new Set();
  for (const home of ownerHomes.filter(value=>typeof value==='string'&&path.isAbsolute(value))) {
    globalHomes.add(key(path.resolve(home)));
    try {globalHomes.add(key(await fs.realpath(home)));} catch {}
  }
  const inspected = new Set();
  for (const start of new Set([path.resolve(cwd),real])) {
    let cursor=start;
    while (!inspected.has(key(cursor))) {
      inspected.add(key(cursor));
      // The owner's global config is replaced by private CODEX_HOME, rather
      // than treated as an executable project layer for a descendant cwd.
      if (!globalHomes.has(key(cursor))) {
        const folder=path.join(cursor,'.codex');
        try {
          const info=await fs.lstat(folder);
          if (info.isSymbolicLink() || !info.isDirectory()) reject();
          try {await fs.lstat(path.join(folder,'config.toml')); reject();}
          catch(error) {if(!absent(error))throw error;}
        } catch(error) {if(!absent(error))throw error;}
      }
      const parent=path.dirname(cursor); if(parent===cursor)break; cursor=parent;
    }
  }
}

module.exports={assertNoProjectConfig};
