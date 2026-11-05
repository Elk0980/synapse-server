#!/usr/bin/env python3
"""Stage/validate/apply three approved Palitra routes; retain a guarded rollback."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

def sha(data): return hashlib.sha256(data).hexdigest()
LIVE = Path('/opt/synapse/caddy/Caddyfile')
STATE = Path('/opt/palitra-main-caddy-20261013')
STAGED = LIVE.with_name('Caddyfile.palitra-main-candidate')

def transform(data):
    text = data.decode('utf-8')
    replacements = [
        (r'(?m)^palitra-love[.]ru \{\n(?P<i>[ \t]+)import palitra_site\n\}',
         lambda m: 'palitra-love.ru {\n'+m['i']+'reverse_proxy content:8080\n}'),
        (r'(?m)^palitra-bot-preview[.]synapsebusiness[.]ru \{\n(?P<i>[ \t]+)reverse_proxy 127[.]0[.]0[.]1:8796\n\}',
         lambda m: 'palitra-bot-preview.synapsebusiness.ru {\n'+m['i']+'redir https://palitra-love.ru/catalog 302\n}'),
        (r'(?m)^(?P<i>[ \t]+)@content path /content/\*$',
         lambda m: m['i']+'@content path /content/* /palitra-review /palitra-review/*'),
        (r'(?m)^(?P<i>[ \t]+)@palitra_test_pair \{\n[ \t]+host palitra-love-draft-1[.]synapsebusiness[.]ru\n[ \t]+path /_palitra_test/\*\n[ \t]+\}\n[ \t]+handle @palitra_test_pair \{\n[ \t]+reverse_proxy 127[.]0[.]0[.]1:8796\n[ \t]+\}\n',
         lambda m: ''),
    ]
    undo = []
    for pattern, replacement in replacements:
        matches = list(re.finditer(pattern, text))
        if len(matches) != 1: raise SystemExit('STOP: route anchor changed')
        m = matches[0]; old = m[0]; new = replacement(m)
        undo.append((m.start(), old, new))
        text = text[:m.start()] + new + text[m.end():]
    reverse = text
    for start, old, new in reversed(undo):
        if reverse[start:start+len(new)] != new: raise SystemExit('STOP: reverse anchor')
        reverse = reverse[:start]+old+reverse[start+len(new):]
    if reverse.encode('utf-8') != data: raise SystemExit('STOP: reverse mismatch')
    return text.encode('utf-8')

def write_live(data):
    with LIVE.open('r+b') as f:
        f.write(data); f.truncate(); f.flush(); os.fsync(f.fileno())
    if LIVE.read_bytes() != data: raise SystemExit('STOP: live readback')

p=argparse.ArgumentParser()
p.add_argument('action',choices=['stage','apply','revert'])
p.add_argument('--expected',required=True)
a=p.parse_args()
if not re.fullmatch('[a-f0-9]{64}',a.expected): p.error('digest')
actual=LIVE.read_bytes()
if sha(actual)!=a.expected: raise SystemExit('STOP: live Caddy changed')
if a.action=='stage':
    candidate=transform(actual)
    STATE.mkdir(mode=0o700)
    for name,data in [('BASE',actual),('CANDIDATE',candidate)]:
        target=STATE/name; target.write_bytes(data); os.chmod(target,0o600)
    with STAGED.open('xb') as f: f.write(candidate)
    os.chmod(STAGED,0o600)
    subprocess.run(['docker','exec','caddy','caddy','validate','--config','/etc/caddy/'+STAGED.name,'--adapter','caddyfile'],check=True)
    meta={'base':sha(actual),'candidate':sha(candidate),'validated':True}
    (STATE/'meta.json').write_text(json.dumps(meta),'utf-8')
    print(json.dumps(meta)); raise SystemExit(0)
meta=json.loads((STATE/'meta.json').read_text('utf-8'))
base=(STATE/'BASE').read_bytes(); candidate=(STATE/'CANDIDATE').read_bytes()
if sha(base)!=meta['base'] or sha(candidate)!=meta['candidate'] or transform(base)!=candidate or not meta['validated']:
    raise SystemExit('STOP: stored stage changed')
expected=meta['base'] if a.action=='apply' else meta['candidate']
if sha(actual)!=expected: raise SystemExit('STOP: new Caddy version')
chosen=candidate if a.action=='apply' else base
write_live(chosen)
try:
    subprocess.run(['docker','exec','caddy','caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],check=True)
except Exception:
    if LIVE.read_bytes()==chosen:
        write_live(actual)
        subprocess.run(['docker','exec','caddy','caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],check=True)
    raise
print(json.dumps({'action':a.action,'sha256':sha(chosen)}))
