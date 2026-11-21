#!/usr/bin/env python3
"""№281: readonly summary or zero-fuzz trial on private copies; never builds/activates."""
import difflib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path('/root/claude-rel')
REPO = 'https://raw.githubusercontent.com/Elk0980/synapse-server/'
RELEASES = {
    '642': ('5b2904a6a8df5fb7333aadb06905a02e09fa2aab', '5c27970376c1434e6deec8f13d11121426fef239', [
        'ops/crm/reel-problems.js', 'ops/crm/reel-requests.js', 'ops/crm/reel-materials-http.js',
        'ops/content/server.js', 'ops/content/reel-materials-chat.js']),
    '644': ('5c27970376c1434e6deec8f13d11121426fef239', '4db110e6c31f971cfba4b52684c2c5389d6da3d1', [
        'ops/content/server.js', 'ops/content/montage-watcher-bundle.js']),
}


def sha(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def gitfile(rev, path, missing=False):
    try:
        with urllib.request.urlopen(REPO + rev + '/' + path, timeout=30) as response:
            data = response.read(2_000_001)
    except urllib.error.HTTPError as error:
        if missing and error.code == 404:
            return None
        raise
    if len(data) > 2_000_000:
        raise RuntimeError('file too large')
    return data


def livefile(path):
    _, service, name = path.split('/')
    container = 'synapse-' + service + '-1'
    exists = subprocess.run(['docker', 'exec', container, 'test', '-e', '/app/' + name], capture_output=True, timeout=30)
    if exists.returncode == 1:
        return None
    exists.check_returncode()
    return subprocess.check_output(['docker', 'exec', container, 'cat', '/app/' + name], timeout=30)


def difference(base, live):
    lines = list(difflib.unified_diff(base.decode().splitlines(True), live.decode().splitlines(True), n=3))
    return {'added': sum(s.startswith('+') and not s.startswith('+++') for s in lines),
            'removed': sum(s.startswith('-') and not s.startswith('---') for s in lines),
            'hunks': [s.strip() for s in lines if s.startswith('@@')]}


def inspect():
    path = 'ops/content/server.js'
    base = gitfile(RELEASES['642'][0], path)
    if sha(base) != '73e7d396c2431d58eac3a2e887b82b210614c4693329837ea69d1bebf01c00dc':
        raise RuntimeError('base hash mismatch')
    live = livefile(path)
    print('BASE', sha(base));print('LIVE', sha(live))
    d = difference(base, live)
    print('DIFF added=%d removed=%d total=%d hunks=%d' % (d['added'], d['removed'], d['added'] + d['removed'], len(d['hunks'])))
    for start in range(0, len(d['hunks']), 3):
        print(' | '.join(d['hunks'][start:start + 3]))
    labels = json.loads(subprocess.check_output(['docker', 'inspect', '--format', '{{json .Config.Labels}}', 'synapse-content-1'], timeout=30))
    work = labels.get('com.docker.compose.project.working_dir')
    candidates = {Path('/opt/synapse/ops/content/server.js')}
    if work and Path(work).is_absolute():
        candidates.add(Path(work) / 'ops/content/server.js')
    for candidate in sorted(candidates):
        data = candidate.read_bytes() if candidate.is_file() else None
        print('HOST', str(candidate), sha(data), 'equal_live=' + str(data == live))
    prep = (ROOT / 'prpatch.sh').read_text()
    go = (ROOT / 'prgo.sh').read_text()
    print('RECIPE live_parent=' + str('docker inspect' in prep and 'FROM ' in prep), 'prgo_no_build=' + str('--no-build' in go))


def private_file(path, data):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(data)


def prepare(number):
    base, head, paths = RELEASES[number]
    directory = ROOT / ('pre' + number)
    directory.mkdir(mode=0o700)  # Existing snapshots are never overwritten.
    manifest = {'base': base, 'head': head, 'files': {}, 'ok': False}
    for path in paths:
        before = gitfile(base, path, missing=True)
        after = gitfile(head, path)
        live = livefile(path)
        name = path.replace('/', '_')
        row = {'base': sha(before), 'head': sha(after), 'live': sha(live)}
        manifest['files'][path] = row
        if live is not None:
            private_file(directory / (name + '.live'), live)
        target = directory / name
        if before is None:
            if live is not None:
                raise RuntimeError('new file exists: ' + path)
            private_file(target, after)
            row['candidate'] = sha(after)
            print('NEW', path, row['candidate'])
            continue
        if live is None:
            raise RuntimeError('live file absent: ' + path)
        private_file(target, live)
        diff = ''.join(difflib.unified_diff(before.decode().splitlines(True), after.decode().splitlines(True), fromfile='file', tofile='file')).encode()
        patch = directory / (name + '.diff')
        private_file(patch, diff)
        args = ['patch', '--batch', '--forward', '--fuzz=0', str(target), str(patch)]
        trial = subprocess.run([*args[:1], '--dry-run', *args[1:]], capture_output=True, timeout=30)
        if trial.returncode:
            print('DRYFAIL', path, 'live=' + row['live'])
            for line in (trial.stdout + trial.stderr).decode(errors='replace').splitlines():
                if line.startswith('Hunk #') or 'FAILED' in line:
                    print(line)
            private_file(directory / 'manifest.failed.json', json.dumps(manifest, indent=2).encode())
            return 1
        applied = subprocess.run(args, capture_output=True, timeout=30)
        if applied.returncode:
            raise RuntimeError('copy patch failed: ' + path)
        row['candidate'] = sha(target.read_bytes())
        print('DRY_OK', path, 'candidate=' + row['candidate'])
    # A concurrent source modification must stop the release before build.
    for path, row in manifest['files'].items():
        if sha(livefile(path)) != row['live']:
            raise RuntimeError('live changed during trial: ' + path)
    manifest['ok'] = True
    private_file(directory / 'manifest.json', json.dumps(manifest, indent=2).encode())
    print('ALL_DRY_OK', number, 'files=' + str(len(paths)), str(directory))
    return 0


def verify(number):
    manifest = json.loads((ROOT / ('pre' + number) / 'manifest.json').read_text())
    if manifest.get('ok') is not True:
        raise RuntimeError('trial not ready')
    for path, row in manifest['files'].items():
        _, service, name = path.split('/')
        staged = ROOT / ('w' + number) / ('b-' + service) / name
        if sha(staged.read_bytes()) != row['candidate'] or sha(livefile(path)) != row['candidate']:
            print('VERIFY_FAIL', path)
            raise RuntimeError('candidate mismatch')
        print('VERIFY_OK', path)


def approved644():
    """№285/2026: four exact insertions on a private copy; no build/up."""
    live = livefile('ops/content/server.js')
    if sha(live) != '2f263385139afac0e383f11299ca7f60eebf2f97a965fd24bd531bcff3f38379':
        raise RuntimeError('approved live SHA changed')
    lines = live.decode().splitlines(True)
    worker = [line for line in lines if line.startswith("const taskDispatchWorker = require('./task-dispatch-worker').createTaskDispatchWorker(")]
    if len(worker) != 1:
        raise RuntimeError('worker anchor count')
    additions = [
        (worker[0], "// №285: отдельная очередь монтажа; используются действующие providers/budget, без нового процесса модели.\n"
         "const montageWatcher = require('./montage-watcher-bundle').createContentWatcher({db,fallback:projectChat.fallback,crmUrl:CRM_URL,crmApiKey:CRM_API_KEY,\n"
         "  log:({code,count})=>console.log('montage-watcher',code,count)});\n"),
        ('  taskDispatchWorker.start();\n', '  montageWatcher.start();\n'),
        ('  taskDispatchWorker.stop();\n', '  const montageStopped=montageWatcher.stop();\n'),
        ('    await contentPlanStopped;\n', '    await montageStopped;\n'),
    ]
    result = live.decode()
    for anchor, insert in additions:
        if lines.count(anchor) != 1 or insert in result:
            raise RuntimeError('anchor not unique or already inserted')
        result = result.replace(anchor, anchor + insert, 1)
    trial = result.encode()
    d = difference(live, trial)
    undo = result
    for anchor, insert in reversed(additions):
        undo = undo.replace(anchor + insert, anchor, 1)
    if (d['added'], d['removed']) != (6, 0) or undo.encode() != live:
        raise RuntimeError('unexpected source difference')
    if result.count('montageWatcher') != 3 or result.count('montageStopped') != 2:
        raise RuntimeError('watcher occurrence count')
    if result.count('salonCompanyApp.close()') != live.decode().count('salonCompanyApp.close()'):
        raise RuntimeError('existing shutdown changed')
    directory = ROOT / 'pre644-approved'
    directory.mkdir(mode=0o700)
    private_file(directory / 'server.live.js', live)
    private_file(directory / 'server.js', trial)
    patch = ''.join(difflib.unified_diff(lines, result.splitlines(True), fromfile='server.js', tofile='server.js')).encode()
    private_file(directory / 'server.diff', patch)
    private_file(directory / 'patch-trial.js', live)
    tested = subprocess.run(['patch', '--dry-run', '--batch', '--forward', '--fuzz=0', str(directory / 'patch-trial.js'), str(directory / 'server.diff')], capture_output=True, timeout=30)
    tested.check_returncode()
    syntax = subprocess.run(['docker', 'exec', '-i', 'synapse-content-1', 'node', '--check'], input=trial, capture_output=True, timeout=30)
    syntax.check_returncode()
    bundle = gitfile(RELEASES['644'][1], 'ops/content/montage-watcher-bundle.js')
    if sha(bundle) != '4b90e6b0e17cc3ac1bdd23527e99b29792f7ee4d576fb3565e9f8a82722aac4a':
        raise RuntimeError('bundle SHA mismatch')
    if livefile('ops/content/montage-watcher-bundle.js') is not None or livefile('ops/content/server.js') != live:
        raise RuntimeError('live changed during trial')
    private_file(directory / 'montage-watcher-bundle.js', bundle)
    manifest = {'approvedComment': 2026, 'live': sha(live), 'server': sha(trial), 'bundle': sha(bundle), 'added': 6, 'removed': 0, 'anchors': [1,1,1,1], 'syntax': True}
    private_file(directory / 'manifest.json', json.dumps(manifest, indent=2).encode())
    print('APPROVED644_COPY_OK', json.dumps(manifest, separators=(',', ':')))
    return 0


def stage644():
    """Use the existing prepared overlay recipe; never starts a service."""
    approved = ROOT / 'pre644-approved'
    manifest = json.loads((approved / 'manifest.json').read_text())
    server = (approved / 'server.js').read_bytes()
    bundle = (approved / 'montage-watcher-bundle.js').read_bytes()
    if manifest.get('approvedComment') != 2026 or (manifest.get('added'), manifest.get('removed')) != (6, 0):
        raise RuntimeError('approval receipt missing')
    if sha(server) != manifest['server'] or sha(bundle) != manifest['bundle']:
        raise RuntimeError('approved files changed')
    if sha(livefile('ops/content/server.js')) != manifest['live'] or livefile('ops/content/montage-watcher-bundle.js') is not None:
        raise RuntimeError('live changed')
    work = ROOT / 'w644'
    build = work / 'b-content'
    dockerfile = build / 'Dockerfile'
    recipe = dockerfile.read_text().splitlines()
    if len(recipe) != 2 or not recipe[0].startswith('FROM ') or recipe[1] != 'COPY montage-watcher-bundle.js /app/montage-watcher-bundle.js':
        raise RuntimeError('unexpected existing overlay recipe')
    current = subprocess.check_output(['docker', 'inspect', '--format', '{{.Image}}', 'synapse-content-1'], timeout=30).decode().strip()
    parent = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', recipe[0][5:]], timeout=30).decode().strip()
    rollback = json.loads((work / 'rb-content.json').read_text())
    candidate = json.loads((work / 'cand-content.json').read_text())
    if parent != current or rollback != {'services': {'content': {'image': current}}}:
        raise RuntimeError('parent/rollback mismatch')
    if set(candidate) != {'services'} or set(candidate['services']) != {'content'} or set(candidate['services']['content']) != {'image'}:
        raise RuntimeError('unexpected candidate structure')
    if (build / 'montage-watcher-bundle.js').read_bytes() != bundle:
        raise RuntimeError('prepared bundle mismatch')
    private_file(build / 'server.js', server)
    dockerfile.write_text('\n'.join(recipe + ['COPY server.js /app/server.js']) + '\n')
    # Exactly the build/check commands from the existing prpatch.sh, same tag/directory.
    image_id = subprocess.check_output(['docker', 'build', '-q', '-t', 'synapse-content:pr644-claude', str(build)], timeout=300).decode().strip().splitlines()[-1]
    if not image_id.startswith('sha256:') or len(image_id) != 71:
        raise RuntimeError('invalid built image ID')
    for name in ['server.js', 'montage-watcher-bundle.js']:
        subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', image_id, '--check', '/app/' + name], capture_output=True, timeout=30, check=True)
    if sha(livefile('ops/content/server.js')) != manifest['live']:
        raise RuntimeError('live changed during build')
    candidate['services']['content']['image'] = image_id
    for path, data in [(work / 'img-content.new', (image_id + '\n').encode()),
                       (work / 'cand-content.json', json.dumps(candidate).encode()),
                       (work / 'files-content.txt', b'montage-watcher-bundle.js\nserver.js\n')]:
        temporary = path.with_name(path.name + '.approved')
        private_file(temporary, data)
        os.replace(temporary, path)
    private_file(work / 'approved644.json', json.dumps({**manifest, 'image': image_id, 'rollbackImage': current}, indent=2).encode())
    print('APPROVED644_PREP_OK', 'services=content files=2 static=0 checks=2 image=' + image_id)
    return 0


def queues():
    # The existing service credential stays inside the content container.
    # Only HTTP codes and aggregate counts leave that process.
    program = r'''
(async()=>{
 const url=new URL(process.env.CRM_URL||'http://crm:8080');
 if(url.protocol!=='http:'||!['crm','localhost','127.0.0.1'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw Error();
 const key=process.env.CRM_API_KEY;if(!key)throw Error();
 const now=Date.now(),out={executorConfigured:!!process.env.MONTAGE_EXECUTOR_URL},data={};
 for(const [name,field] of [['requests','requests'],['queue','edits']]){
  const r=await fetch(url.href.replace(/\/$/,'')+'/internal/reel-materials/'+name,{headers:{'x-api-key':key},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error();const body=await r.json(),rows=body[field];if(!Array.isArray(rows))throw Error();data[name]=rows;
  const old=rows.filter(x=>now-Date.parse(x.createdAt)>=600000);
  out[name]={http:r.status,total:rows.length,older10m:old.length,invalidDates:rows.filter(x=>!Number.isFinite(Date.parse(x.createdAt))).length,
   statuses:Object.fromEntries([...new Set(rows.map(x=>x.status))].map(s=>[s,rows.filter(x=>x.status===s).length]))};
 }
 out.effectiveOld=data.requests.filter(x=>x.editId==null&&x.status==='accepted'&&now-Date.parse(x.createdAt)>=600000).length+data.queue.filter(x=>x.status==='pending'&&now-Date.parse(x.createdAt)>=600000).length;
 const port=Number(process.env.PORT||8080);if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error();
 const h=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(10000)});out.contentHealth=h.status;if(!h.ok)throw Error();
 console.log(JSON.stringify(out));
})().catch(()=>{console.error('QUEUE_PREFLIGHT_ERROR');process.exitCode=1});
'''
    result = subprocess.run(['docker', 'exec', 'synapse-content-1', 'node', '-e', program], capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError('queue request failed')
    data = json.loads(result.stdout)
    print('QUEUE_COUNTS', json.dumps(data, separators=(',', ':')))


def main():
    if sys.argv[1:] == ['stage644']:
        return stage644()
    if sys.argv[1:] == ['approved644']:
        return approved644()
    if sys.argv[1:] == ['inspect']:
        inspect()
        return 0
    if len(sys.argv) == 3 and sys.argv[1] == 'prepare' and sys.argv[2] in RELEASES:
        return prepare(sys.argv[2])
    if sys.argv[1:] == ['after642']:
        verify('642')
        queues()
        return 0
    if sys.argv[1:] == ['after644']:
        verify('644')
        queues()
        return 0
    print('usage: inspect | prepare 642|644', file=sys.stderr)
    return 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        # Never print downloaded/live source, environment or HTTP headers.
        print('PREFLIGHT_ERROR', type(error).__name__, file=sys.stderr)
        sys.exit(1)
