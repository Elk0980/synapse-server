'use strict';

// Доверенная стадия родительского worker: только ветка запуска и draft PR.
// Тексты задания не попадают в commit/PR; произвольные команды не принимаются.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILES = 100, MAX_BYTES = 4 * 1024 * 1024, MAX_FILE = 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), {code}); };
const within = (base,target) => { const rel = path.relative(base,target); return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

function githubRepo(value) {
  let match = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  if (!match) match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  if (!match) match = /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  if (!match || ['.','..'].includes(match[1]) || ['.','..'].includes(match[2])) fail('PUBLISH_REMOTE_REJECTED');
  return `${match[1]}/${match[2]}`;
}

function safePath(name) {
  if (!name || name.length > 500 || /[\x00-\x1f\x7f\\]/.test(name) || path.posix.isAbsolute(name) ||
      name.split('/').some(part => !part || part === '.' || part === '..') || /^[-"]/.test(name)) fail('PUBLISH_PATH_REJECTED');
  const lower = name.toLowerCase(), parts = lower.split('/');
  // Эти материалы исключены корневым .gitignore и запрещены даже после add -f
  // или удаления позднейшим commit. Клиентские данные могут не иметь token.
  const privateRoots = ['docs/handoff','docs/seed','.claude/projects','.agents/sessions'];
  if (privateRoots.some(root => lower === root || lower.startsWith(root + '/')) ||
      ['.claude/settings.local.json','.qwen/settings.json'].includes(lower)) fail('PUBLISH_SECRET_PATH');
  if (parts.some(part => /^\.env/.test(part) || part === '.git' || part === '.codex' || part === '.gitmodules' ||
      part === '.gitattributes' || /(?:^|[._-])(?:auth|tokens?|credentials?|secrets?|sessions?|private[-_]?key)(?:[._-]|$)/.test(part) ||
      /\.(?:pem|p12|pfx|key|sqlite|sqlite3|db|log|jsonl)$/.test(part)) ||
      /(?:^|\/)id_(?:rsa|ed25519|ecdsa|dsa)(?:\.|$)/.test(name)) fail('PUBLISH_SECRET_PATH');
  return name;
}

function scanSecrets(text) {
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text) ||
      /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(text) ||
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(text) ||
      /\/mcp\/[A-Za-z0-9_-]{32,256}\b/.test(text) ||
      /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/.test(text) ||
      /(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*["'][A-Za-z0-9_./+=-]{20,}["']/i.test(text)) fail('PUBLISH_SECRET_DETECTED');
}

function publisherEnvironment(env) {
  const keys = new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','HOME','USERPROFILE','APPDATA','LOCALAPPDATA',
    'TEMP','TMP','LANG','LC_ALL','SSH_AUTH_SOCK','GH_TOKEN','GITHUB_TOKEN']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => keys.has(key.toUpperCase())));
}

function statusPaths(output) {
  const fields = output.split('\0'), result = new Set();
  for (let index = 0; index < fields.length; index++) {
    const item = fields[index];
    if (!item) continue;
    const state = item.slice(0,2);
    if (item[2] !== ' ' || /U/.test(state) || /^(?:AA|DD)$/.test(state) || !/^[ MADRC?!]{2}$/.test(state)) fail('PUBLISH_STATUS_REJECTED');
    result.add(safePath(item.slice(3)));
    if (/[RC]/.test(state)) result.add(safePath(fields[++index] || ''));
  }
  if (result.size > MAX_FILES) fail('PUBLISH_LIMIT');
  return [...result];
}

async function publishRun({repo,worktree,branch,runId,taskId}, {execImpl = execute, env = process.env, signal} = {}) {
  if (!path.isAbsolute(repo || '') || !path.isAbsolute(worktree || '') || !UUID.test(runId || '') ||
      !Number.isSafeInteger(taskId) || taskId < 1 || branch !== `codex/agent-task-${taskId}-${runId.slice(0,8)}`) fail('PUBLISH_ARGUMENTS_REJECTED');
  let temp;
  try {
    const repoRoot = await fs.realpath(repo), treeRoot = await fs.realpath(worktree);
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synapse-agent-publish-'));
    const hooks = path.join(temp, 'hooks');
    await fs.mkdir(hooks);
    const options = {windowsHide:true, shell:false, timeout:60000, maxBuffer:MAX_BYTES + 1024,
      env:publisherEnvironment(env), encoding:'utf8', ...(signal ? {signal} : {})};
    const git = async (cwd,args) => {
      const result = await execImpl('git', ['-c',`core.hooksPath=${hooks}`,'-c','core.fsmonitor=false','-C',cwd,...args],options);
      const out = result.stdout || '';
      if (Buffer.byteLength(out) > MAX_BYTES) fail('PUBLISH_LIMIT');
      return out;
    };
    const gh = async args => (await execImpl('gh',args,options)).stdout || '';
    const current = (await git(treeRoot,['branch','--show-current'])).trim();
    if (current !== branch || (await fs.realpath((await git(treeRoot,['rev-parse','--show-toplevel'])).trim())) !== treeRoot) fail('PUBLISH_BRANCH_REJECTED');
    const common = async cwd => fs.realpath(path.resolve(cwd,(await git(cwd,['rev-parse','--git-common-dir'])).trim()));
    if (await common(repoRoot) !== await common(treeRoot)) fail('PUBLISH_WORKTREE_REJECTED');
    const remote = githubRepo((await git(repoRoot,['remote','get-url','origin'])).trim());
    const verifyRemotes = async () => {
      for (const cwd of [repoRoot,treeRoot]) for (const args of [['remote','get-url','--all','origin'],['remote','get-url','--push','--all','origin']]) {
        const urls = (await git(cwd,args)).trim().split(/\r?\n/);
        if (!urls.length || urls.some(url => githubRepo(url).toLowerCase() !== remote.toLowerCase())) fail('PUBLISH_REMOTE_REJECTED');
      }
    };
    await verifyRemotes();
    await git(treeRoot,['rev-parse','--verify','origin/main']);
    const changed = statusPaths(await git(treeRoot,['status','--porcelain=v1','-z','--untracked-files=all']));
    const historyNames = (await git(treeRoot,['-c','core.quotePath=false','log','--format=','--name-only','--no-renames','origin/main..HEAD'])).split(/\r?\n/).filter(Boolean);
    if (new Set([...changed,...historyNames]).size > MAX_FILES) fail('PUBLISH_LIMIT');
    historyNames.forEach(safePath);
    // --patch не раскрывает содержимое binary blob. Проверяем каждый commit,
    // включая файлы, удалённые следующим commit и отсутствующие в текущем дереве.
    const historyStats = await git(treeRoot,['-c','core.quotePath=false','log','--format=','--numstat','--no-renames','origin/main..HEAD','--']);
    for (const line of historyStats.split(/\r?\n/).filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!match) fail('PUBLISH_HISTORY_REJECTED');
      safePath(match[3]);
      if (match[1] === '-' || match[2] === '-') fail('PUBLISH_BINARY_REJECTED');
    }
    let total = 0;
    for (const name of changed) {
      const target = path.resolve(treeRoot,...name.split('/'));
      if (!within(treeRoot,target)) fail('PUBLISH_PATH_REJECTED');
      let info;
      try { info = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || !within(treeRoot,await fs.realpath(target))) fail('PUBLISH_FILE_REJECTED');
      for (let parent = path.dirname(target); parent !== treeRoot; parent = path.dirname(parent)) {
        if ((await fs.lstat(parent)).isSymbolicLink()) fail('PUBLISH_FILE_REJECTED');
      }
      total += info.size;
      if (info.size > MAX_FILE || total > MAX_BYTES) fail('PUBLISH_LIMIT');
      const bytes = await fs.readFile(target);
      if (bytes.includes(0)) fail('PUBLISH_BINARY_REJECTED');
      let contents;
      try { contents = new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { fail('PUBLISH_BINARY_REJECTED'); }
      scanSecrets(contents);
    }
    if (changed.length) {
      const attributes = (await git(treeRoot,['check-attr','-z','filter','--',...changed])).split('\0');
      for (let index=2; index<attributes.length; index+=3) if (attributes[index] && !['unspecified','unset'].includes(attributes[index])) fail('PUBLISH_FILTER_REJECTED');
      const index = await git(treeRoot,['ls-files','--stage','-z','--',...changed]);
      if (index.split('\0').some(item => /^(?:120000|160000) /.test(item))) fail('PUBLISH_FILE_REJECTED');
    }
    scanSecrets(await git(treeRoot,['diff','--no-ext-diff','--no-textconv','HEAD','--']));
    scanSecrets(await git(treeRoot,['log','--format=','--patch','--no-ext-diff','--no-textconv','origin/main..HEAD','--']));
    // Только после полного preflight начинаются изменения index и commit.
    if (changed.length) {
      await git(treeRoot,['add','-A','--',...changed]);
      await git(treeRoot,['-c','commit.gpgsign=false','commit','--no-verify','-m',`Задача #${taskId}: локальные изменения агента`]);
    }
    const commit = (await git(treeRoot,['rev-parse','HEAD'])).trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) fail('PUBLISH_COMMIT_INVALID');
    const count = Number((await git(treeRoot,['rev-list','--count','origin/main..HEAD'])).trim());
    if (!Number.isSafeInteger(count) || count < 1 || count > 50) fail('PUBLISH_NO_COMMITS');
    await verifyRemotes();
    await git(treeRoot,['push','--set-upstream','origin',`HEAD:refs/heads/${branch}`]);
    const listed = JSON.parse(await gh(['pr','list','--repo',remote,'--head',branch,'--state','open','--json','url']));
    let url;
    if (Array.isArray(listed) && listed.length) url=listed[0]?.url;
    else {
      const bodyFile = path.join(temp,'body.md');
      await fs.writeFile(bodyFile,`Локальный результат задачи #${taskId}.\n\nЗапуск: ${runId}.\n\nРезультат требует проверки. Автоматическое слияние и развёртывание не выполняются.\n`,{mode:0o600});
      url=(await gh(['pr','create','--repo',remote,'--draft','--base','main','--head',branch,
        '--title',`Задача #${taskId}: результат локального агента`,'--body-file',bodyFile])).trim();
    }
    const expected = new RegExp(`^https://github\\.com/${remote.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/pull/[1-9][0-9]*$`,'i');
    if (typeof url !== 'string' || !expected.test(url)) fail('PUBLISH_PR_INVALID');
    return {pr_url:url,commit};
  } catch (error) {
    if (/^PUBLISH_[A-Z_]+$/.test(error.code || '')) throw error;
    fail('PUBLISH_FAILED');
  } finally {
    if (temp) {
      const absolute=path.resolve(temp), base=path.resolve(os.tmpdir());
      if (path.dirname(absolute) === base && path.basename(absolute).startsWith('synapse-agent-publish-')) await fs.rm(absolute,{recursive:true,force:true});
    }
  }
}

module.exports={publishRun,githubRepo,safePath,scanSecrets,statusPaths,publisherEnvironment};
