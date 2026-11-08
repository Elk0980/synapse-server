'use strict';
// №194: профиль codex-review-merge — доверенная стадия слияния на синтетических ответах git/gh.
const test = require('node:test');
const assert = require('node:assert/strict');
const {prepareReview, mergeReviewed, checksState} = require('./agent-launch-review-merge');

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40), MERGE = 'c'.repeat(40);
const REMOTE = 'Elk0980/synapse-server';
const pr = (fields = {}) => ({number:621, state:'OPEN', isDraft:false, headRefOid:SHA, headRefName:'claude/sample-branch',
  baseRefName:'main', url:`https://github.com/${REMOTE}/pull/621`, mergeCommit:null, ...fields});

function fakeExec({views = [pr()], checks = [[{name:'ci',bucket:'pass'}]], fetched = SHA, mergeFails = false} = {}) {
  const calls = [];
  let view = 0, check = 0;
  const exec = async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'git') {
      const rest = args.slice(args.indexOf('-C') + 2);
      if (rest[0] === 'remote') return {stdout:`https://github.com/${REMOTE}.git\n`};
      if (rest[0] === 'rev-parse') return {stdout:`${fetched}\n`};
      return {stdout:''};
    }
    if (args[0] === 'pr' && args[1] === 'view') return {stdout:JSON.stringify(views[Math.min(view++, views.length - 1)])};
    if (args[0] === 'pr' && args[1] === 'checks') {
      const list = checks[Math.min(check++, checks.length - 1)];
      if (list.some(item => item.bucket !== 'pass' && item.bucket !== 'skipping')) throw Object.assign(new Error('exit 8'), {stdout:JSON.stringify(list)});
      return {stdout:JSON.stringify(list)};
    }
    if (args[0] === 'pr' && args[1] === 'merge' && mergeFails) throw new Error('protected');
    return {stdout:''};
  };
  return {exec, calls};
}

test('подготовка ревью: только открытый PR Claude в main, копия ровно на head', async () => {
  const ok = fakeExec();
  const result = await prepareReview({repo:'/repo', prNumber:621, target:'/trees/review', execImpl:ok.exec, env:{}});
  assert.deepEqual(result, {remote:REMOTE, reviewedSha:SHA, url:pr().url, branch:'claude/sample-branch'});
  assert.ok(ok.calls.some(line => line.includes(`worktree add --detach /trees/review ${SHA}`)));
  for (const [fields, code] of [[{state:'MERGED'}, 'REVIEW_PR_NOT_OPEN'], [{baseRefName:'dev'}, 'REVIEW_PR_BASE_REJECTED'],
    [{headRefName:'codex/agent-task-1'}, 'REVIEW_PR_NOT_CLAUDE'], [{url:'https://github.com/other/repo/pull/621'}, 'REVIEW_PR_INVALID']]) {
    await assert.rejects(prepareReview({repo:'/repo', prNumber:621, target:'/t', execImpl:fakeExec({views:[pr(fields)]}).exec, env:{}}), {code});
  }
  await assert.rejects(prepareReview({repo:'/repo', prNumber:621, target:'/t', execImpl:fakeExec({fetched:OTHER}).exec, env:{}}), {code:'REVIEW_HEAD_MOVED'});
});

test('зелёный CI → «КОД ПРИНЯТ» → обычный merge с привязкой к head; меток нет', async () => {
  const fake = fakeExec({views:[pr({isDraft:true}), pr({isDraft:true}), pr({state:'MERGED', mergeCommit:{oid:MERGE}})]});
  const comments = [];
  const result = await mergeReviewed({repo:'/repo', remote:REMOTE, prNumber:621, reviewedSha:SHA, comment:async text => comments.push(text), execImpl:fake.exec, env:{}});
  assert.deepEqual(result, {merged:true, accepted:true, merge_commit:MERGE, url:pr().url});
  assert.equal(comments.length, 1); assert.match(comments[0], /^КОД ПРИНЯТ — PR #621, head aaaaaaaaaaaa/);
  assert.ok(fake.calls.includes(`gh pr ready 621 --repo ${REMOTE}`));
  assert.ok(fake.calls.includes(`gh pr merge 621 --repo ${REMOTE} --merge --match-head-commit ${SHA}`));
  assert.ok(!fake.calls.some(line => /label|--admin|--squash|--rebase|deploy/.test(line)));
  // Комментарий раньше слияния.
  assert.ok(fake.calls.findIndex(line => line.includes('pr merge')) > fake.calls.findIndex(line => line.includes('pr checks')));
});

test('без зелёного CI или при сдвинутом head слияния и «КОД ПРИНЯТ» нет', async () => {
  for (const [options, expected] of [
    [{checks:[[{name:'ci',bucket:'fail'}]]}, {merged:false, reason:'CI_FAILED'}],
    [{checks:[[]]}, {merged:false, reason:'CI_MISSING'}],
    [{checks:[[{name:'ci',bucket:'pending'}]]}, {merged:false, reason:'CI_PENDING_TIMEOUT'}]]) {
    const fake = fakeExec(options), comments = [];
    let clock = 0;
    const result = await mergeReviewed({repo:'/repo', remote:REMOTE, prNumber:621, reviewedSha:SHA, comment:async text => comments.push(text),
      execImpl:fake.exec, env:{}, now:() => clock, sleep:async ms => { clock += ms; }, ciWaitMs:5 * 60000});
    assert.deepEqual(result, expected); assert.equal(comments.length, 0);
    assert.ok(!fake.calls.some(line => line.includes('pr merge')));
  }
  const moved = fakeExec({views:[pr({headRefOid:OTHER})]});
  await assert.rejects(mergeReviewed({repo:'/repo', remote:REMOTE, prNumber:621, reviewedSha:SHA, comment:async () => {}, execImpl:moved.exec, env:{}}), {code:'REVIEW_HEAD_MOVED'});
  const late = fakeExec({views:[pr(), pr({headRefOid:OTHER})]});
  const comments = [];
  await assert.rejects(mergeReviewed({repo:'/repo', remote:REMOTE, prNumber:621, reviewedSha:SHA, comment:async text => comments.push(text), execImpl:late.exec, env:{}}), {code:'REVIEW_HEAD_MOVED'});
  assert.equal(comments.length, 0);
});

test('ожидание CI: pending → pass сливает; отказ защиты ветки честно возвращается', async () => {
  const fake = fakeExec({checks:[[{name:'ci',bucket:'pending'}], [{name:'ci',bucket:'pass'},{name:'opt',bucket:'skipping'}]],
    views:[pr(), pr(), pr({state:'MERGED', mergeCommit:{oid:MERGE}})]});
  let clock = 0;
  const merged = await mergeReviewed({repo:'/repo', remote:REMOTE, prNumber:621, reviewedSha:SHA, comment:async () => {}, execImpl:fake.exec, env:{},
    now:() => clock, sleep:async ms => { clock += ms; }});
  assert.equal(merged.merged, true);
  const rejected = await mergeReviewed({repo:'/repo', remote:REMOTE, prNumber:621, reviewedSha:SHA, comment:async () => {},
    execImpl:fakeExec({mergeFails:true}).exec, env:{}});
  assert.deepEqual(rejected, {merged:false, reason:'MERGE_REJECTED', accepted:true});
});

test('состояние проверок: только pass/skipping с хотя бы одним pass считается зелёным', async () => {
  const gh = list => async () => JSON.stringify(list);
  assert.equal(await checksState(gh([{bucket:'pass'}]), REMOTE, 1), 'green');
  assert.equal(await checksState(gh([{bucket:'skipping'}]), REMOTE, 1), 'failed');
  assert.equal(await checksState(gh([{bucket:'pass'},{bucket:'cancel'}]), REMOTE, 1), 'failed');
  assert.equal(await checksState(async () => { throw new Error('x'); }, REMOTE, 1), 'unknown');
});
