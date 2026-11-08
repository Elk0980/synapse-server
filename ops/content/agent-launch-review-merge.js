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
  try { data = JSON.parse(await gh(['pr', 'view', String(prNumber), '--repo', remote, '--json', 'number,state,isDraft,headRefOid,headRefName,baseRefName,url,mergeCommit'])); }
  catch { fail('REVIEW_PR_UNAVAILABLE'); }
  if (!data || data.number !== prNumber || !SHA.test(data.headRefOid || '') || typeof data.headRefName !== 'string') fail('REVIEW_PR_INVALID');
  const url = new URL(data.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.pathname !== `/${remote}/pull/${prNumber}`) fail('REVIEW_PR_INVALID');
  return data;
}

// Подготовка до запуска модели: PR открыт, в main, ветка Claude; копия ровно на head.
async function prepareReview({repo, prNumber, target, execImpl, env, signal}) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) fail('REVIEW_PR_INVALID');
  const {git, gh} = tools({repo, execImpl, env, signal});
  const remote = githubRepo((await git(['remote', 'get-url', 'origin'])).trim());
  const pr = await viewPr(gh, remote, prNumber);
  if (pr.state !== 'OPEN') fail('REVIEW_PR_NOT_OPEN');
  if (pr.baseRefName !== 'main') fail('REVIEW_PR_BASE_REJECTED');
  if (!pr.headRefName.startsWith(REVIEW_BRANCH_PREFIX)) fail('REVIEW_PR_NOT_CLAUDE');
  const ref = `refs/synapse-review/pr-${prNumber}`;
  await git(['fetch', '--no-tags', 'origin', `+refs/pull/${prNumber}/head:${ref}`]);
  if ((await git(['rev-parse', `${ref}^{commit}`])).trim().toLowerCase() !== pr.headRefOid.toLowerCase()) fail('REVIEW_HEAD_MOVED');
  await git(['worktree', 'add', '--detach', target, pr.headRefOid]);
  return {remote, reviewedSha:pr.headRefOid.toLowerCase(), url:pr.url, branch:pr.headRefName};
}

async function checksState(gh, remote, prNumber) {
  let list;
  try { list = JSON.parse(await gh(['pr', 'checks', String(prNumber), '--repo', remote, '--json', 'name,bucket'], {allowExit:true})); }
  catch { return 'unknown'; }
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
  sleep = wait, now = Date.now, ciWaitMs = 15 * 60000, pollMs = 60000}) {
  if (!SHA.test(reviewedSha || '') || typeof comment !== 'function') fail('REVIEW_STATE_INVALID');
  const {gh} = tools({repo, execImpl, env, signal});
  const head = async () => {
    const pr = await viewPr(gh, remote, prNumber);
    if (pr.state !== 'OPEN') fail('REVIEW_PR_NOT_OPEN');
    if (pr.headRefOid.toLowerCase() !== reviewedSha) fail('REVIEW_HEAD_MOVED');
    return pr;
  };
  await head();
  const deadline = now() + ciWaitMs;
  let state = await checksState(gh, remote, prNumber);
  while ((state === 'pending' || state === 'unknown') && now() < deadline) {
    await sleep(pollMs, signal);
    state = await checksState(gh, remote, prNumber);
  }
  if (state !== 'green') return {merged:false, reason:{failed:'CI_FAILED', missing:'CI_MISSING'}[state] || 'CI_PENDING_TIMEOUT'};
  const pr = await head();
  await comment(`КОД ПРИНЯТ — PR #${prNumber}, head ${reviewedSha.slice(0, 12)}. Независимое ревью (профиль codex-review-merge), CI зелёный на этом head. Метки защиты не ставились; deploy не выполнялся.`);
  try {
    if (pr.isDraft) await gh(['pr', 'ready', String(prNumber), '--repo', remote]);
    await gh(['pr', 'merge', String(prNumber), '--repo', remote, '--merge', '--match-head-commit', reviewedSha]);
  } catch { return {merged:false, reason:'MERGE_REJECTED', accepted:true}; }
  const merged = await viewPr(gh, remote, prNumber);
  if (merged.state !== 'MERGED' || !SHA.test(merged.mergeCommit?.oid || '')) return {merged:false, reason:'MERGE_UNCONFIRMED', accepted:true};
  return {merged:true, accepted:true, merge_commit:merged.mergeCommit.oid.toLowerCase(), url:merged.url};
}

module.exports = {prepareReview, mergeReviewed, checksState, REVIEW_BRANCH_PREFIX};
