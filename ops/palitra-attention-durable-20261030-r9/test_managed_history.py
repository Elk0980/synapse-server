"""Real SQLite + historical filesystem preservation; no application/service execution."""
from pathlib import Path
import copy,hashlib,importlib.util,json,os,sqlite3,tempfile,unittest
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('history_tested',HERE/'managed_history.py');h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
spec2=importlib.util.spec_from_file_location('facts_unchanged',HERE.parent/'DURABLE_CONTENT_RELEASE_R7/install.py');m=importlib.util.module_from_spec(spec2);spec2.loader.exec_module(m)
class History(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=HERE);self.addCleanup(self.tmp.cleanup);self.data=Path(self.tmp.name).resolve();self.db=self.data/'content.sqlite';self.rev='a'*64;self.old='b'*64;self.folder=self.data/'projects'/h.COMPANY/'sites'/h.SITE/'versions';self.folder.mkdir(parents=True)
  self.p=patch.object(h,'HISTORY_COUNT',2);self.p.start();self.addCleanup(self.p.stop)
  if os.name=='nt':
   def safe(p):
    before=h.meta(p);raw=p.read_bytes();self.assertEqual(before,h.meta(p));self.assertLessEqual(len(raw),h.LIMIT);return raw
   reader=patch.object(h,'safe',side_effect=safe);reader.start();self.addCleanup(reader.stop)
  c=sqlite3.connect(self.db);c.executescript('CREATE TABLE managed_sites(id TEXT PRIMARY KEY,company_code TEXT,is_active INTEGER,deleted_at TEXT);CREATE TABLE site_workspaces(site_id TEXT PRIMARY KEY,hostname TEXT,runtime TEXT,current_revision TEXT);CREATE TABLE site_workspace_revisions(site_id TEXT,revision TEXT PRIMARY KEY,version INTEGER,manifest_json TEXT);')
  c.execute('INSERT INTO managed_sites VALUES(?,?,1,NULL)',(h.SITE,h.COMPANY));c.execute('INSERT INTO managed_sites VALUES(?,?,1,NULL)',('foreign-site','synthetic-foreign'));c.execute('INSERT INTO site_workspaces VALUES(?,?,?,?)',(h.SITE,'palitra-love-draft-1.synapsebusiness.ru','palitra-draft',self.rev))
  files={}
  forms=HERE.parent/'OPTIONAL_DEMOGRAPHICS_UI_R2';files['assets/storefront.js']=(forms/'storefront.js').read_bytes();files['account/register/index.html']=(forms/'register.html').read_bytes()
  for i in range(139):files['other/'+str(i)+'.txt']=('kept '+str(i)).encode()
  doc={}
  for name,raw in files.items():p=self.folder/self.rev/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw);doc[name]={'sha256':h.sha(raw),'bytes':len(raw)}
  oldfile=self.folder/self.old/'legacy.txt';oldfile.parent.mkdir();oldfile.write_bytes(b'known historical actual bytes');old_doc={'legacy.txt':{'sha256':h.sha(b'known old manifest mismatch'),'bytes':3}}
  c.execute('INSERT INTO site_workspace_revisions VALUES(?,?,?,?)',(h.SITE,self.old,257,json.dumps(old_doc)));c.execute('INSERT INTO site_workspace_revisions VALUES(?,?,?,?)',(h.SITE,self.rev,334,json.dumps(doc)));c.commit();c.close()
 def scan(self,full=True,expected=None):
  with m.db_open(self.db)as c:return h.scan(c,self.data,m.db_facts(c),self.rev,full,expected)
 def write(self,sql,args=()):
  c=sqlite3.connect(self.db);c.execute(sql,args);c.commit();c.close()
 def test_full_witness_and_fast_stat_preserve_known_historical_mismatch_without_repair(self):
  witness=self.scan();self.assertEqual(self.scan(False,witness),witness);self.assertEqual(self.scan(True,witness),witness);self.assertEqual((self.folder/self.old/'legacy.txt').read_bytes(),b'known historical actual bytes');self.assertEqual(witness['version'],334);self.assertEqual(len(witness['history']),2)
 def test_fast_stat_and_independent_sha_reject_old_actual_mutation(self):
  witness=self.scan();(self.folder/self.old/'legacy.txt').write_bytes(b'new historical bytes')
  for full in(False,True):
   with self.assertRaises(ValueError):self.scan(full,witness)
 def test_all_managed_rows_include_foreign_row_even_when_fixed_current_unchanged(self):
  witness=self.scan();self.write("UPDATE managed_sites SET is_active=0 WHERE id='foreign-site'")
  with self.assertRaisesRegex(ValueError,'ROWS_OR_CONTENT'):self.scan(False,witness)
 def test_extra_version_file_missing_file_and_new_db_revision_refuse(self):
  witness=self.scan()
  extra=self.folder/self.old/'unexpected.txt';extra.write_bytes(b'no')
  with self.assertRaises(ValueError):self.scan(False,witness)
  extra.unlink();self.write('INSERT INTO site_workspace_revisions VALUES(?,?,?,?)',(h.SITE,'c'*64,335,'{}'))
  with self.assertRaisesRegex(ValueError,'REVISION_COUNT'):self.scan(False,witness)
 def test_current_forms_revision_and_manifest_changes_refuse(self):
  witness=self.scan();self.write('UPDATE site_workspaces SET current_revision=?',(self.old,))
  with self.assertRaisesRegex(ValueError,'SITE334'):self.scan(False,witness)
 def test_witness_does_not_accept_repaired_old_manifest(self):
  witness=self.scan();raw=(self.folder/self.old/'legacy.txt').read_bytes();fixed={'legacy.txt':{'sha256':h.sha(raw),'bytes':len(raw)}};self.write('UPDATE site_workspace_revisions SET manifest_json=? WHERE revision=?',(json.dumps(fixed),self.old))
  with self.assertRaisesRegex(ValueError,'ROWS_OR_CONTENT'):self.scan(True,witness)
 def test_duplicate_manifest_json_is_refused_before_a_witness_can_be_created(self):
  self.write('UPDATE site_workspace_revisions SET manifest_json=? WHERE revision=?',('{"legacy.txt":{},"legacy.txt":{}}',self.old))
  with self.assertRaisesRegex(ValueError,'DUPLICATE_JSON'):self.scan()
if __name__=='__main__':unittest.main()
