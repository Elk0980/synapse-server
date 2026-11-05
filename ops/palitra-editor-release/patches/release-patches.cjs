'use strict';

const path = require('node:path');
const upstream = require('./upstream-patches.cjs');
const EXPECTED_PUBLIC_URL = 'https://palitra-love-draft-1.synapsebusiness.ru/';

// Обязательный доверенный путь проверяет Root. Нет env, PATH, cwd или сетевого fallback.
function photoFeatureWithDecoder(sharpModule) {
  if (typeof sharpModule !== 'string' || !path.isAbsolute(sharpModule) || /[\x00-\x1f\x7f]/.test(sharpModule)) {
    throw new Error('Нужен явный абсолютный путь --sharp-module');
  }
  const edits = upstream.PHOTO_FEATURE.edits.map(edit => ({ ...edit, lines: [...edit.lines] }));
  edits[0].lines.push("const {createSharpDecoder}=require('./palitra-image-decoder');");
  edits[1].lines = [
    '// Фото черновика Palitra: только site-44bbe13f1bad5e005b2a/index.html (PALITRA-BOT-EDITOR-35).',
    `const palitraDecodeImage=createSharpDecoder(require(${JSON.stringify(sharpModule)}));`,
    'const photoFeature=createPalitraPhotoFeature({db,authStore,requireSession,requireCsrf,readJson,readRaw,',
    `  workspaceStore:workspaceFeature.store,assetsDir:ASSETS_DIR,decodeImage:palitraDecodeImage,expectedPublicUrl:${JSON.stringify(EXPECTED_PUBLIC_URL)}});`
  ];
  return { ...upstream.PHOTO_FEATURE, name: 'photo-feature-trusted-decoder', edits };
}

function patchServer(text, sharpModule) {
  const photo = upstream.applyPatch(text, photoFeatureWithDecoder(sharpModule));
  const price = upstream.applyPatch(photo.text, upstream.PRICE_CAS);
  return { text: price.text, inserted: [...photo.inserted, ...price.inserted], eol: photo.eol };
}

module.exports = { ...upstream, EXPECTED_PUBLIC_URL, photoFeatureWithDecoder, patchServer };
