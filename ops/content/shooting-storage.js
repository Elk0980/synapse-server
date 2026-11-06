'use strict';
/* Адаптер хранилища дублей «Съёмки». Сейчас — локальная папка тома content, интерфейс
   повторяет S3 multipart: size ≈ сумма принятых частей, append ≈ uploadPart, read ≈ GetObject
   с Range. Замена на S3 — новая реализация тех же методов, маршруты не меняются. */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };

function createLocalStorage(root, {statfs = (dir) => fs.statfsSync(dir)} = {}) {
  const file = (code, key) => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code) || !/^[a-f0-9]{32}$/.test(key)) fail(400, 'Некорректный ключ файла');
    return path.join(root, code, key);
  };
  return {
    kind: 'local',
    disk() {
      fs.mkdirSync(root, {recursive: true, mode: 0o700});
      const stat = statfs(root);
      return {free: Number(stat.bavail) * Number(stat.bsize), total: Number(stat.blocks) * Number(stat.bsize)};
    },
    size(code, key) {
      try { return fs.statSync(file(code, key)).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    },
    /* Кусок атомарен: при обрыве соединения или превышении предела файл обрезается до
       начального смещения, и клиент повторяет тот же кусок. */
    async append(code, key, offset, source, maxBytes) {
      const target = file(code, key);
      fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
      const handle = await fsp.open(target, fs.existsSync(target) ? 'r+' : 'w+', 0o600);
      let written = 0;
      try {
        if ((await handle.stat()).size !== offset) fail(409, 'Смещение файла изменилось');
        for await (const chunk of source) {
          if (written + chunk.length > maxBytes) fail(413, 'Кусок больше допустимого');
          await handle.write(chunk, 0, chunk.length, offset + written);
          written += chunk.length;
        }
        await handle.sync();
        return written;
      } catch (error) {
        await handle.truncate(offset).catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
    },
    async head(code, key, length = 16) {
      const handle = await fsp.open(file(code, key), 'r');
      try {
        const buffer = Buffer.alloc(length);
        const {bytesRead} = await handle.read(buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
    },
    async sha256(code, key) {
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(file(code, key))) hash.update(chunk);
      return hash.digest('hex');
    },
    read(code, key, range = {}) { return fs.createReadStream(file(code, key), range); },
    remove(code, key) { fs.rmSync(file(code, key), {force: true}); },
  };
}

module.exports = {createLocalStorage};
