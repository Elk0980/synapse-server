'use strict';

// №194: доверенная стадия профиля codex-review-merge.
// Модель только читает PR в отдельной копии и выносит вердикт. Проверку CI на точном
// head, комментарий «КОД ПРИНЯТ» и обычный merge выполняет родительский обработчик.
// Метки защиты (например «сайты: инфраструктура») не ставятся и не снимаются; deploy нет.
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {githubRepo, publisherEnvironment} = require('./agent-launch-publisher');
const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/i;
const REVIEW_BRANCH_PREFIX = 'claude/';
const fail = code => { throw Object.assign(new Error(code), {code}); };

function tools({repo, execImpl = execute, env = process.env, signal}) {
  const options = {windowsHide:true, timeout:120000, maxBuffer:4 * 1024 * 1024, env:publisherEnvironment(env), encoding:'utf8', ...(signal ? {signal} : {})};
  const git = async args => (await execImpl('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-C', repo, ...args], options)).stdout || '';
  // gh pr checks завершается кодом 8 при ожидании и 1 при ошибке, но JSON печатает.
  const gh = async (args, {allowExit = false} = {}) => {
    try { return (await execImpl('gh', args, options)).stdout || ''; }
    catch (e) { if (allowExit && typeof e.stdout === 'string' && e.stdout.trim()) return e.stdout; throw e; }
  };
  return {git, gh};
}

async function viewPr(gh, remote, prNumber) {
  let data;
  try { data = JSON.parse(await gh(['pr', 'view', String(prNumber), '--repo', remote, '--json',
    'number,state,isDraft,headRefOid,headRefName,baseRefName,baseRefOid,url,mergeCommit,isCrossRepository,headRepositoryOwner,author'])); }
  catch { fail('REVIEW_PR_UNAVAILABLE'); }
  if (!data || data.number !== prNumber || !SHA.test(data.headRefOid || '') || typeof data.headRefName !== 'string') fail('REVIEW_PR_INVALID');
  const url = new URL(data.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.pathname !== `/${remote}/pull/${prNumber}`) fail('REVIEW_PR_INVALID');
  return data;
}

// Публичный репозиторий: «PR Claude» — только ветка claude/* этого же репозитория от его владельца.
// PR из форка или чужого автора не ревьюится и не сливается, даже если ветка названа claude/*.
function assertOwnClaudePr(pr, remote) {
  const owner = remote.split('/')[0].toLowerCase();
  if (pr.state !== 'OPEN') fail('REVIEW_PR_NOT_OPEN');
  if (pr.baseRefName !== 'main') fail('REVIEW_PR_BASE_REJECTED');
  if (pr.isCrossRepository !== false || String(pr.headRepositoryOwner?.login || '').toLowerCase() !== owner) fail('REVIEW_PR_FOREIGN');
  if (String(pr.author?.login || '').toLowerCase() !== owner) fail('REVIEW_PR_FOREIGN');
  if (!pr.headRefName.startsWith(REVIEW_BRANCH_PREFIX)) fail('REVIEW_PR_NOT_CLAUDE');
  // Черновик — сигнал автора «не готов»: не переводим в готовый за него.
  if (pr.isDraft) fail('REVIEW_PR_DRAFT');
}

// Подготовка до запуска модели: PR открыт, в main, ветка Claude; копия ровно на head.
async function prepareReview({repo, prNumber, target, execImpl, env, signal}) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) fail('REVIEW_PR_INVALID');
  const {git, gh} = tools({repo, execImpl, env, signal});
  const remote = githubRepo((await git(['remote', 'get-url', 'origin'])).trim());
  const pr = await viewPr(gh, remote, prNumber);
  assertOwnClaudePr(pr, remote);
  // Свежая база: модель сравнивает с точным main, а не с устаревшим origin/main на ПК.
  const ref = `refs/synapse-review/pr-${prNumber}`, baseRef = `refs/synapse-review/pr-${prNumber}-base`;
  await git(['fetch', '--no-tags', 'origin', `+refs/pull/${prNumber}/head:${ref}`, `+refs/heads/main:${baseRef}`]);
  if ((await git(['rev-parse', `${ref}^{commit}`])).trim().toLowerCase() !== pr.headRefOid.toLowerCase()) fail('REVIEW_HEAD_MOVED');
  const baseSha = (await git(['rev-parse', `${baseRef}^{commit}`])).trim().toLowerCase();
  if (!SHA.test(baseSha)) fail('REVIEW_BASE_UNAVAILABLE');
  await git(['worktree', 'add', '--detach', target, pr.headRefOid]);
  return {remote, reviewedSha:pr.headRefOid.toLowerCase(), baseSha, url:pr.url, branch:pr.headRefName};
}

// Копия ревью и служебные ссылки не копятся на диске.
async function cleanupReview({repo, prNumber, target, execImpl, env}) {
  const {git} = tools({repo, execImpl, env});
  try { await git(['worktree', 'remove', '--force', target]); } catch {}
  for (const ref of [`refs/synapse-review/pr-${prNumber}`, `refs/synapse-review/pr-${prNumber}-base`]) {
    try { await git(['update-ref', '-d', ref]); } catch {}
  }
}

async function checksState(gh, remote, prNumber) {
  let list, raw;
  try { raw = await gh(['pr', 'checks', String(prNumber), '--repo', remote, '--json', 'name,bucket'], {allowExit:true}); }
  catch (e) { return /no checks reported/i.test(String(e?.stderr || '')) ? 'missing' : 'unknown'; }
  try { list = JSON.parse(raw); } catch { return 'unknown'; }
  if (!Array.isArray(list) || !list.length) return 'missing';
  if (list.some(check => ['fail', 'cancel'].includes(check.bucket))) return 'failed';
  if (list.some(check => check.bucket === 'pending')) return 'pending';
  return list.every(check => ['pass', 'skipping'].includes(check.bucket)) && list.some(check => check.bucket === 'pass') ? 'green' : 'failed';
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error('REVIEW_ABORTED'), {code:'REVIEW_ABORTED'}));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('REVIEW_ABORTED'), {code:'REVIEW_ABORTED'})); }, {once:true});
});

// Слияние только того head, который прочитала модель, и только при зелёном CI.
async function mergeReviewed({repo, remote, prNumber, reviewedSha, comment, execImpl, env, signal,
  sleep = wait, now = Date.now, ciWaitMs = 15 * 60000, pollMs = 60000, deadlineAt = Infinity, settleMs = 90000}) {
  if (!SHA.test(reviewedSha || '') || typeof comment !== 'function') fail('REVIEW_STATE_INVALID');
  const {gh} = tools({repo, execImpl, env, signal});
  const head = async () => {
    const pr = await viewPr(gh, remote, prNumber);
    assertOwnClaudePr(pr, remote);
    if (pr.headRefOid.toLowerCase() !== reviewedSha) fail('REVIEW_HEAD_MOVED');
    return pr;
  };
  await head();
  // Не начинаем слияние, если до общего лимита запуска остаётся меньше двух минут.
  const deadline = Math.min(now() + ciWaitMs, deadlineAt - 2 * 60000);
  // Сразу после push список проверок может быть неполным: ждём, пока он устоится.
  if (settleMs > 0) await sleep(Math.min(settleMs, Math.max(0, deadline - now())), signal);
  let state = await checksState(gh, remote, prNumber);
  while ((state === 'pending' || state === 'unknown') && now() < deadline) {
    await sleep(pollMs, signal);
    state = await checksState(gh, remote, prNumber);
  }
  if (state !== 'green') return {merged:false, reason:{failed:'CI_FAILED', missing:'CI_MISSING'}[state] || 'CI_PENDING_TIMEOUT'};
  if (now() >= deadlineAt - 2 * 60000) return {merged:false, reason:'RUN_TIME_LIMIT'};
  await head();
  await comment(`КОД ПРИНЯТ — PR #${prNumber}, head ${reviewedSha.slice(0, 12)}. Независимое ревью (профиль codex-review-merge), CI зелёный на этом head. Метки защиты не ставились.`);
  let mergeError = false;
  try { await gh(['pr', 'merge', String(prNumber), '--repo', remote, '--merge', '--match-head-commit', reviewedSha]); }
  catch { mergeError = true; }
  // Ошибка или обрыв gh не доказывает, что слияния нет: перечитываем фактическое состояние.
  let merged;
  try { merged = await tools({repo, execImpl, env}).gh(['pr', 'view', String(prNumber), '--repo', remote, '--json', 'state,mergeCommit,url']).then(JSON.parse); }
  catch { return {merged:false, reason:'MERGE_UNCONFIRMED', accepted:true}; }
  if (merged?.state === 'MERGED' && SHA.test(merged.mergeCommit?.oid || '')) return {merged:true, accepted:true, merge_commit:merged.mergeCommit.oid.toLowerCase(), url:prUrl(remote, prNumber)};
  return {merged:false, reason:mergeError ? 'MERGE_REJECTED' : 'MERGE_UNCONFIRMED', accepted:true};
}

const prUrl = (remote, prNumber) => `https://github.com/${remote}/pull/${prNumber}`;

module.exports = {prepareReview, mergeReviewed, cleanupReview, checksState, assertOwnClaudePr, REVIEW_BRANCH_PREFIX};
