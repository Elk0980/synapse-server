'use strict';

/* Проверка хранилища корней проверяется на фикстуре, а не на машине, где идёт прогон:
   набор берётся из встроенного в Node списка корней (tls.rootCertificates) — это настоящие
   сертификаты, они разбираются X509 и никуда не ходят по сети. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const {X509Certificate} = require('node:crypto');
const {spawnSync} = require('node:child_process');

const {inspectCaBundle, checkCaBundle, DEFAULT_CA_BUNDLE_PATH, MIN_VALID_CERTIFICATES} = require('./ca-bundle');

const CHECK_SCRIPT = path.join(__dirname, 'test-support', 'check-ca-bundle.js');
const bundleText = `${tls.rootCertificates.join('\n')}\n`;
const validity = (pem) => {
  const certificate = new X509Certificate(pem);
  const from = certificate.validFromDate instanceof Date ? certificate.validFromDate.getTime() : Date.parse(certificate.validFrom);
  const to = certificate.validToDate instanceof Date ? certificate.validToDate.getTime() : Date.parse(certificate.validTo);
  return {from, to};
};
// Один заведомо действующий сегодня корень: набор Node обновляется, поэтому берём не первый
// попавшийся, а подходящий по сроку — иначе тест зависел бы от даты прогона.
const currentRoot = tls.rootCertificates.find((pem) => {
  const {from, to} = validity(pem);
  return from <= Date.now() && Date.now() <= to;
});

const tempFile = (t, name, content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hugh-ca-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
};

test('путь по умолчанию — системное хранилище Debian, которым пользуется клиент Codex', () => {
  assert.equal(DEFAULT_CA_BUNDLE_PATH, '/etc/ssl/certs/ca-certificates.crt');
  assert.ok(MIN_VALID_CERTIFICATES >= 20);
});

test('настоящий набор корней принимается: сертификаты разобраны и действуют сегодня', () => {
  const result = inspectCaBundle(bundleText);
  assert.equal(result.ok, true, `набор отклонён: ${result.reason}`);
  assert.equal(result.reason, 'ca_bundle_ok');
  assert.equal(result.unparsable, 0);
  assert.ok(result.parsed >= MIN_VALID_CERTIFICATES);
  assert.ok(result.valid >= MIN_VALID_CERTIFICATES);
});

test('пустой, «мусорный» и повреждённый файлы доказательством не считаются', () => {
  assert.equal(inspectCaBundle('').reason, 'ca_bundle_empty');
  assert.equal(inspectCaBundle('   \n\t ').reason, 'ca_bundle_empty');
  assert.equal(inspectCaBundle('# ca-certificates не установлен\n').reason, 'ca_bundle_without_certificates');
  // Блок на месте, но это не сертификат: «файл непустой» такую подмену не ловит.
  const broken = '-----BEGIN CERTIFICATE-----\nбольшене сертификат\n-----END CERTIFICATE-----\n';
  const result = inspectCaBundle(broken);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ca_bundle_unparsable');
  assert.equal(result.blocks, 1);
  assert.equal(result.unparsable, 1);
});

test('корень вне срока действия не считается действующим', () => {
  assert.ok(currentRoot, 'во встроенном наборе Node нет ни одного действующего корня');
  const pem = `${currentRoot}\n`;
  const {from: validFrom, to: validTo} = validity(pem);

  // Срок берётся у самого сертификата, поэтому проверка не зависит от даты прогона.
  for (const now of [validTo + 86_400_000, validFrom - 86_400_000]) {
    const result = inspectCaBundle(pem, {now, minValid: 1});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ca_bundle_without_valid_certificates');
    assert.equal(result.parsed, 1);
    assert.equal(result.valid, 0);
    assert.equal(result.expired, 1);
  }
  assert.equal(inspectCaBundle(pem, {now: validFrom + 1000, minValid: 1}).ok, true);
});

test('нехватка действующих корней отклоняется, даже если файл разобрался', () => {
  const single = `${currentRoot}\n`;
  assert.equal(inspectCaBundle(single).reason, 'ca_bundle_without_valid_certificates');
  assert.equal(inspectCaBundle(single, {minValid: 1}).ok, true);
});

test('отсутствующий файл и нечитаемый путь различаются и оба проваливают проверку', (t) => {
  const file = tempFile(t, 'ca-certificates.crt', bundleText);
  const ok = checkCaBundle({path: file});
  assert.equal(ok.ok, true);
  assert.equal(ok.path, file);
  assert.equal(ok.bytes, Buffer.byteLength(bundleText));

  const missing = checkCaBundle({path: path.join(path.dirname(file), 'нет-такого.crt')});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'ca_bundle_missing');
  assert.equal(missing.bytes, 0);

  // Каталог вместо файла: читается, но не как набор сертификатов.
  const directory = checkCaBundle({path: path.dirname(file)});
  assert.equal(directory.ok, false);
  assert.equal(directory.reason, 'ca_bundle_unreadable');
});

test('сборочная проверка образа падает на пустом наборе и проходит на настоящем', (t) => {
  const good = tempFile(t, 'good.crt', bundleText);
  const empty = tempFile(t, 'empty.crt', '');

  const passed = spawnSync(process.execPath, [CHECK_SCRIPT, '--path', good], {encoding: 'utf8'});
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /хранилище корневых сертификатов на месте/);

  const failed = spawnSync(process.execPath, [CHECK_SCRIPT, '--path', empty], {encoding: 'utf8'});
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /ca_bundle_empty/);
  assert.equal(failed.stdout, '');
});
