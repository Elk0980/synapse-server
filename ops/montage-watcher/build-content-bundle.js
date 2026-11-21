'use strict';
// Воспроизводимая упаковка исходников для прежнего COPY *.js и адресного prpatch content.
// Здесь нет второго runtime, каталога моделей, ключей или бюджетного ledger.
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'../..'),OUTPUT=path.join(ROOT,'ops/content/montage-watcher-bundle.js');
const files={
  entry:['ops/montage-watcher/content-entry.js',{'./store':'store','./watcher':'watcher','./classifier':'classifier','./transport':'transport'}],
  store:['ops/montage-watcher/store.js',{}],watcher:['ops/montage-watcher/watcher.js',{}],transport:['ops/montage-watcher/transport.js',{}],
  classifier:['ops/montage-watcher/classifier.js',{'../hugh-runtime/limits':'limits'}],
  limits:['ops/hugh-runtime/limits.js',{'./errors':'errors'}],errors:['ops/hugh-runtime/errors.js',{}]
};
function build(){
  const definitions=Object.entries(files).map(([id,[file,imports]])=>`${JSON.stringify(id)}:[${JSON.stringify(imports)},function(module,exports,require){\n${fs.readFileSync(path.join(ROOT,file),'utf8').replace(/\r\n/g,'\n').trimEnd()}\n}]`).join(',\n');
  return `'use strict';\n// GENERATED: node ops/montage-watcher/build-content-bundle.js — не править вручную.\nconst definitions={\n${definitions}\n};\nconst cache={};\nfunction load(id){if(cache[id])return cache[id].exports;const [imports,fn]=definitions[id],module={exports:{}};cache[id]=module;fn(module,module.exports,spec=>{if(imports[spec])return load(imports[spec]);if(spec.startsWith('node:'))return require(spec);throw Error('UNEXPECTED_BUNDLE_IMPORT');});return module.exports;}\nmodule.exports=load('entry');\n`;
}
if(require.main===module){const expected=build();if(process.argv.includes('--check')){if(fs.readFileSync(OUTPUT,'utf8').replace(/\r\n/g,'\n')!==expected)process.exitCode=1;}else fs.writeFileSync(OUTPUT,expected);}
module.exports={build,OUTPUT};
