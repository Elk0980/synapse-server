"""Generate an overlay from the handed, exact installed runtime. Never installs.

The host checkout is known to be stale: using its server.js would revert Palitra.
The overlay intentionally leaves native chat, queue, push, prices and accounts alone.
"""
from pathlib import Path
import argparse, hashlib, json, shutil, difflib

parser=argparse.ArgumentParser()
parser.add_argument('--handoff',type=Path,required=True)
parser.add_argument('--out',type=Path,required=True)
args=parser.parse_args()
ready=json.loads((args.handoff/'READY.json').read_text(encoding='utf-8-sig'))
if ready['installed_release'] != 36:
    raise ValueError('Expected the reviewed installed36 handoff')
pins={e['output_name']:e for e in ready['files']}
def read(name):
    payload=(args.handoff/name).read_bytes()
    if hashlib.sha256(payload).hexdigest()!=pins[name]['runtime_sha256'] or len(payload)!=pins[name]['bytes']:
        raise ValueError('Runtime handoff checksum mismatch: '+name)
    return payload.decode('utf-8')
def replace_once(text,old,new):
    if '\r\n' in text:
        old=old.replace('\n','\r\n');new=new.replace('\n','\r\n')
    if text.count(old)!=1: raise ValueError('Native anchor mismatch: '+old[:100])
    return text.replace(old,new)
args.out.mkdir(parents=True,exist_ok=True)
root=Path(__file__).resolve().parent
server=read('server.js')
server=replace_once(server,"const { DatabaseSync } = require('node:sqlite');", "const { DatabaseSync } = require('node:sqlite');\nconst {create: createSalonCompanyApp} = require('./company-app/runtime.cjs');")
server=replace_once(server,'const db = new DatabaseSync(DATABASE_PATH);',"const db = new DatabaseSync(DATABASE_PATH);\n// Private source snapshots live outside the existing chat/order/account database.\nconst salonCompanyApp = createSalonCompanyApp({databasePath:path.join(path.dirname(DATABASE_PATH),'salon-reports.sqlite')});")
server=replace_once(server,"    if (!SITES.has(parts[1])) fail(404, 'Неизвестный сайт');", "    if (await salonCompanyApp.handle({request,url,reply,requireSession,requireCsrf,readJson,origin:PALITRA_APP_ORIGIN,orders:projectChat.siteOrders,dialogs:clientDialogs})) return;\n    if (!SITES.has(parts[1])) fail(404, 'Неизвестный сайт');")
server=replace_once(server,'    await contentPlanStopped;\n    db.close();','    await contentPlanStopped;\n    salonCompanyApp.close();\n    db.close();')
base=read('server.js')
(args.out/'server.js').write_text(server,encoding='utf-8',newline='\n')
(args.out/'BASE36-server.patch').write_text(''.join(difflib.unified_diff(base.replace('\r\n','\n').splitlines(True),server.replace('\r\n','\n').splitlines(True),fromfile='BASE36/server.js',tofile='candidate/server.js')),encoding='utf-8',newline='\n')
# Only private orders are registered; no public Origins, bot names, tokens,
# recipients, transport changes or public intake are introduced.
extra=json.loads((args.handoff/'ADDITIONAL_READY.json').read_text(encoding='utf-8-sig'))
entry=next(e for e in extra['files'] if e['output_name']=='client-bot-config.js')
payload=(args.handoff/'client-bot-config.js').read_bytes()
if hashlib.sha256(payload).hexdigest()!=entry['runtime_sha256']:raise ValueError('Client config checksum mismatch')
config=payload.decode('utf-8')
config=replace_once(config,"      alvi: { companyCode: companies.alvi, title: 'ALVI', origins: [] },", "      alvi: { companyCode: companies.alvi, title: 'ALVI', origins: [] },\n      avokado: { companyCode: companies.avokado, title: 'Авокадо', origins: [] },")
(args.out/'client-bot-config.js').write_text(config,encoding='utf-8',newline='\n')
(args.out/'BASE36-client-bot-config.patch').write_text(''.join(difflib.unified_diff(payload.decode('utf-8').replace('\r\n','\n').splitlines(True),config.replace('\r\n','\n').splitlines(True),fromfile='BASE36/client-bot-config.js',tofile='candidate/client-bot-config.js')),encoding='utf-8',newline='\n')
dest=args.out/'company-app';dest.mkdir(exist_ok=True)
names=['runtime.cjs','company-app-http.cjs','company-context.js','customer-reports-http.cjs','customer-reports.cjs','customer-report-import-http.cjs','customer-report-cache.cjs','customer-report-aggregates.cjs']
for name in names:shutil.copyfile(root/name,dest/name)
inventory=[]
for p in sorted(args.out.rglob('*')):
    if p.is_file() and p.suffix in ['.js','.cjs']:
        data=p.read_bytes();inventory.append({'path':str(p.relative_to(args.out)).replace('\\','/'),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
(args.out/'NATIVE_CANDIDATE.json').write_text(json.dumps({'installed':False,'base_release':36,'image':ready['native_image_sha256'],'files':inventory,'native_chat_modules_changed':False,'queue_or_permissions_changed':False,'source_provider_mounted':True,'traffic_provider_mounted':False,'studio_send_or_push_enabled':False},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'files':len(inventory),'installed':False,'out':str(args.out)}))
