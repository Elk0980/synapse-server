"""Board 283/2294: one version submission per fixed TaiSabai reel, stop on error.

Reuses the byte-verified transport that created reel21/v3; no service deployment.
No media URLs or credentials in this script. Bodies travel privately on stdin.
"""
import base64,hashlib,importlib.util,json,re,sys,zlib
from pathlib import Path

ROOT=Path('/root/claude-rel')
TRANSPORT_SHA='3c5bd6bdd3cb408eb8fdc117878c93cb46b78ab7029c931cce97176b548d8aee'
SCOPE={22:(9,83797),23:(10,58859),24:(11,111552)}

def decode(arg,reel):
    data=zlib.decompress(base64.urlsafe_b64decode(arg))
    body=json.loads(data)
    if len(data)>4096 or not data.isascii() or set(body)!={'mediaUrl','sha256','durationMs','editId'}:
        raise ValueError('body')
    if (body['editId'],body['durationMs'])!=SCOPE[reel]:raise ValueError('scope')
    if not re.fullmatch(r'https://synapse\.synapsebusiness\.ru/content/publishing-assets/taisabai/[a-f0-9]{32}\.mp4',body['mediaUrl']) or not re.fullmatch('[a-f0-9]{64}',body['sha256']):raise ValueError('body')
    return data

def main():
    try:
        if len(sys.argv) not in (3,4) or sys.argv[1] not in ('submit','inspect'):raise ValueError('mode')
        mode,reel=sys.argv[1],int(sys.argv[2])
        if reel not in SCOPE:raise ValueError('scope')
        path=ROOT/'v32282.py'
        if hashlib.sha256(path.read_bytes()).hexdigest()!=TRANSPORT_SHA:raise ValueError('transport')
        spec=importlib.util.spec_from_file_location('v3_transport',path)
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        m.ROOT=ROOT;m.MARK=ROOT/f'reel{reel}-v2-2294.started';m.RESULT=ROOT/f'reel{reel}-v2-2294.result.json'
        m.INSPECT=m.INSPECT.replace('r.id=21','r.id='+str(reel))
        if mode=='inspect':
            sys.argv=['transport','inspect'];return m.main()
        if len(sys.argv)!=4:raise ValueError('body')
        packed=sys.argv[3];decode(packed,reel)
        for n in range(22,reel):
            receipt=json.loads((ROOT/f'reel{n}-v2-2294.result.json').read_text())
            if not 200<=receipt['http']<300 or receipt['version']!=2:raise ValueError('previous')
        if m.RESULT.exists():raise ValueError('already attempted')
        m.decode=lambda arg:decode(arg,reel)
        m.PROGRAM=m.PROGRAM.replace('/reels/21/','/reels/'+str(reel)+'/')
        sys.argv=['transport','submit',packed]
        return m.main()
    except Exception:
        print('{"http":0,"version":null}')
        return 1

if __name__=='__main__':sys.exit(main())
