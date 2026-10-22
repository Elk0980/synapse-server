"""Check dates of the explicitly deleted test orders in their sealed backup; never restore."""
import datetime,hashlib,json,pathlib,re,sqlite3
root=pathlib.Path('/opt/synapse/releases/palitra-app-20261015')
receipt=root/'palitra-order-cleanup-used-def5f94f93e8eeb807186173e45dfd81.json.receipt.json'
sha=lambda b:hashlib.sha256(b).hexdigest()
raw=receipt.read_bytes()
assert sha(raw)=='94301d3154b612fea52a9a18b8b9ca75969b54fd832f4b457edb79adca4d4f7b'
r=json.loads(raw)
namespace=r['namespace']
assert namespace=='palitra-order-cleanup-20261021-r11-def5f94f93e8eeb807186173e45dfd81'
raw=(root/(namespace+'-admission.json')).read_bytes()
assert sha(raw)==r['admissionSha256']
admission=json.loads(raw)
ref=admission['artifacts']['backupProof']
raw=pathlib.Path(ref['path']).read_bytes()
assert sha(raw)==ref['sha256']
proof=json.loads(raw)
backup=pathlib.Path(proof['backupPath'])
assert backup.is_absolute() and not backup.is_symlink()
assert sha(backup.read_bytes())==proof['backupSha256']
db=sqlite3.connect(backup.as_uri()+'?mode=ro',uri=True)
try:
    db.execute('PRAGMA query_only=ON')
    assert db.execute('PRAGMA query_only').fetchone()==(1,)
    rows=db.execute("SELECT id,created_at,kind FROM site_orders WHERE site='palitra' AND company_code='palitra-love' AND id BETWEEN 18 AND 28 ORDER BY id").fetchall()
    assert [x[0] for x in rows]==list(range(18,29))
    days={}
    for order_id,created,kind in rows:
        local=datetime.datetime.fromisoformat(created.replace('Z','+00:00')).astimezone(datetime.timezone(datetime.timedelta(hours=7)))
        day=local.date().isoformat();days[day]=days.get(day,0)+1
        print(json.dumps({'deletedTestOrderId':order_id,'createdBangkok':local.isoformat(),'kind':kind}))
    print(json.dumps({'sealedBackupVerified':True,'countsByBangkokDate':days,'restored':False,'businessRowsWritten':0}))
finally:db.close()
