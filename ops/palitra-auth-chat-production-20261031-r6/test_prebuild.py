"""Isolated lifecycle regressions: no Docker/server/network calls or real data."""
import ast,copy,hashlib,importlib.util,json,sqlite3,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);sys.modules[name]=m;spec.loader.exec_module(m);return m
m=load('protocol_r2_install',HERE/'install.py');p=load('protocol_r2_prebuild',HERE/'prebuild.py')
r1=HERE.parent/'palitra-auth-chat-production-20261031-r1'

class Lifecycle(unittest.TestCase):
    def fake_release(self,area,changed=False):
        calls=[];db=sqlite3.connect(area/'fake-crm.sqlite');db.executescript('CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT);INSERT INTO events(kind)VALUES("before-build");')
        # Ordinary new state during image preparation must be captured afresh.
        db.execute('INSERT INTO events(kind)VALUES(?)',('during-build',));db.commit()
        facts={};x=types.SimpleNamespace(AREA=area,need=m.need,sha=m.sha,enc=m.enc,safe_read=lambda q:q.read_bytes(),load=lambda q:json.loads(q.read_bytes()),own_lease=lambda:{'pid':123,'startTicks':'fixed'})
        def write(q,raw):
            with q.open('xb')as f:f.write(raw)
        def readonly_facts():
            reader=sqlite3.connect((area/'fake-crm.sqlite').as_uri()+'?mode=ro',uri=True)
            try:
                reader.execute('PRAGMA query_only=ON');return m.db_facts(reader)
            finally:reader.close()
        x.write_new=write
        def prepare():
            calls.append('prepare');facts.update(readonly_facts());write(area/'base.json',m.enc({'databaseFacts':facts}))
            if changed:db.execute('INSERT INTO events(kind)VALUES(?)',('after-final-anchor',));db.commit()
        def guard():
            calls.append('wholeDB');reader=sqlite3.connect((area/'fake-crm.sqlite').as_uri()+'?mode=ro',uri=True)
            try:reader.execute('PRAGMA query_only=ON');m.assert_database(reader,facts)
            finally:reader.close()
        def backup(base):guard();calls.append('backup');guard()
        def apply():guard();calls.append('apply')
        x.prepare=prepare;x.base_guard=guard;x.backup_databases=backup;x.apply=apply
        return x,calls,db,facts

    def test_new_crm_state_before_final_anchor_preserved(self):
        with tempfile.TemporaryDirectory()as directory:
            x,calls,db,facts=self.fake_release(Path(directory));p.release(x)
            self.assertEqual(calls,['prepare','wholeDB','wholeDB','backup','wholeDB','wholeDB','apply'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM events').fetchone()[0],2);x.base_guard();db.close()

    def test_crm_append_after_final_anchor_stops_before_backup_and_apply(self):
        with tempfile.TemporaryDirectory()as directory:
            area=Path(directory);x,calls,db,facts=self.fake_release(area,True)
            with self.assertRaisesRegex(ValueError,'DATABASE_SCHEMA_OR_ROWS_CHANGED_INSPECT_ONLY'):p.release(x)
            prior=(area/'base.json').read_bytes();self.assertEqual(calls,['prepare','wholeDB']);self.assertFalse((area/'backups').exists());self.assertFalse((area/'apply-intent.json').exists())
            self.assertEqual(db.execute('SELECT COUNT(*) FROM events').fetchone()[0],3)
            with self.assertRaisesRegex(ValueError,'FRESH_FINAL_RELEASE_ONLY'):p.release(x)
            self.assertEqual((area/'base.json').read_bytes(),prior);db.close()

    def test_changed_old_crm_row_and_schema_still_refused(self):
        for mutation in('UPDATE events SET kind="changed" WHERE id=1','ALTER TABLE events ADD COLUMN foreign_value TEXT'):
            with tempfile.TemporaryDirectory()as directory:
                x,calls,db,facts=self.fake_release(Path(directory));x.prepare();db.execute(mutation);db.commit()
                with self.assertRaisesRegex(ValueError,'DATABASE_SCHEMA_OR_ROWS_CHANGED_INSPECT_ONLY'):x.base_guard()
                self.assertNotIn('apply',calls);db.close()

    def test_prepare_requires_prebuilt_guard_before_any_database_snapshot(self):
        source=ast.parse((HERE/'install.py').read_text());f=next(n for n in source.body if isinstance(n,ast.FunctionDef)and n.name=='prepare');body=ast.unparse(f)
        self.assertLess(body.index("module('prebuild.py').ready"),body.index('snapshot_databases('))
        with patch.object(m,'package',return_value=({},{})),patch.object(m,'AREA',Path(tempfile.gettempdir())/'never-existing-protocol-r2-test'),patch.object(m,'module',return_value=types.SimpleNamespace(ready=lambda _:(_ for _ in()).throw(ValueError('MISSING_PREBUILT_FALLBACK')))),patch.object(m,'snapshot_databases')as snapshot:
            with self.assertRaisesRegex(ValueError,'MISSING_PREBUILT_FALLBACK'):m.prepare()
            snapshot.assert_not_called()

    def test_build_and_fallback_use_image_guard_and_never_snapshot_or_backup(self):
        f=next(n for n in ast.parse((HERE/'install.py').read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='build')
        body=ast.unparse(f);self.assertNotIn('base_guard(',body);self.assertNotIn('backup_databases(',body);self.assertNotIn('snapshot_databases(',body)
        self.assertLess(body.index("module('prebuild.py').guard"),body.index("'build-intent.json', enc"))
        self.assertIn("'--network=none'",body);self.assertNotIn("'up'",body)
        source=(HERE/'fallback_image.py').read_text();self.assertNotIn('m.base_guard()',source);self.assertNotIn('backup_guard()',source);self.assertIn("module('prebuild.py').image_anchor(m)",source)

    def test_all_preservation_and_apply_guards_ast_exact_r1(self):
        def funcs(path):return {f.name:ast.dump(f,include_attributes=False)for f in ast.parse(path.read_text()).body if isinstance(f,ast.FunctionDef)}
        before=funcs(r1/'install.py');after=funcs(HERE/'install.py')
        for name in('db_facts','assert_database','assert_preserved_path','snapshot_databases','backup_databases','backup_guard','apply','inspect_result','static_guard','startup_guard','economy_guard','own_lease','foreign','built_image_guard','validated_plan','expected_tree','tar_members','make_plan'):
            self.assertEqual(before[name],after[name],name)
        old=next(f for f in ast.parse((r1/'install.py').read_text()).body if isinstance(f,ast.FunctionDef)and f.name=='base_guard');new=next(f for f in ast.parse((HERE/'install.py').read_text()).body if isinstance(f,ast.FunctionDef)and f.name=='base_guard')
        extra=[n for n in new.body if isinstance(n,ast.Expr)and 'preserve_binding' in ast.unparse(n)]
        self.assertEqual(len(extra),1);new.body.remove(extra[0]);self.assertEqual(ast.dump(old,include_attributes=False),ast.dump(new,include_attributes=False))
        for name in('migration_guard.py','migration-schema.json','host_static.py','managed_history.py','managed_verify.py','diagnostic_preservation.py','economy_projection.py','image_archive_audit.py','vault_probe.cjs'):
            self.assertEqual((HERE/name).read_bytes(),(r1/name).read_bytes(),name)

    def test_all_product_sources_byte_exact_r1(self):
        for folder in('payload','static-payload','source-proof'):
            for old in(r1/folder).rglob('*'):
                if old.is_file():self.assertEqual(old.read_bytes(),(HERE/old.relative_to(r1)).read_bytes())

    def test_ready_refuses_missing_or_foreign_forward_fallback(self):
        manifest={'files':[]};base={'tree':{}};child={'image':'forward'}
        for bad in('forward','fallback','parent','tree','config'):
            events=[]
            x=types.SimpleNamespace(NAME='palitra-auth-chat-production-20261031-r6',AREA=Path('/fake'),REVIEWED_DATA_PINS={'fallback_image.py':'pin'},need=m.need,load=lambda _:child,expected_tree=lambda *_:{},image_tree=lambda _:{} if bad!='tree'else{'foreign':{}},validated_plan=lambda *_:events.append('plan'))
            def built(*_):
                events.append('forward')
                if bad in('forward','parent','config'):raise ValueError('FORWARD_'+bad)
            def fallback(_):events.append('fallback');raise ValueError('FALLBACK_CHANGED')
            x.built_image_guard=built;x.module=lambda _:types.SimpleNamespace(validate=fallback)
            with patch.object(p,'guard',return_value=({},manifest,base,{})):
                with self.assertRaises(ValueError):p.ready(x)
            self.assertNotIn('apply',events)

    def test_unknown_package_cannot_skip_fallback(self):
        x=types.SimpleNamespace(NAME='foreign',AREA=Path('/fake'),REVIEWED_DATA_PINS={},need=m.need,load=lambda _:{'image':'forward'},built_image_guard=lambda *_:None,image_tree=lambda _:{},expected_tree=lambda *_:{},validated_plan=lambda *_:None)
        with patch.object(p,'guard',return_value=({}, {}, {'tree':{}}, {})):
            with self.assertRaisesRegex(ValueError,'EXACT_REVIEWED_FALLBACK_PROTOCOL'):p.ready(x)

    def test_final_binding_detects_each_receipt_or_stage_change(self):
        with tempfile.TemporaryDirectory()as directory:
            area=Path(directory);names=['image-base.json','image-prepared.json','child.json','forward-plan.json','fallback-child.json']
            for name in names:(area/name).write_bytes(name.encode())
            stage={'commit':'commit','helperSha256':'helper','manifestSha256':'manifest'}
            x=types.SimpleNamespace(AREA=area,REVIEWED_DATA_PINS={'fallback_image.py':'pin'},package=lambda:(stage,{}),need=m.need,sha=m.sha,safe_read=lambda q:q.read_bytes())
            base={'prebuilt':p.binding(x)};p.preserve_binding(x,base)
            for name in names:
                raw=(area/name).read_bytes();(area/name).write_bytes(raw+b'changed')
                with self.assertRaisesRegex(ValueError,'FINAL_PREBUILT_IMAGE_BINDING_CHANGED'):p.preserve_binding(x,base)
                (area/name).write_bytes(raw)
            stage['commit']='another'
            with self.assertRaisesRegex(ValueError,'FINAL_PREBUILT_IMAGE_BINDING_CHANGED'):p.preserve_binding(x,base)

    def test_actual_forward_image_guard_rejects_parent_config_layer_and_receipt(self):
        image='sha256:'+'a'*64;config={'Entrypoint':['original']};parent={'Config':config,'RootFS':{'Layers':['old']}}
        child_info={'Config':copy.deepcopy(config),'RootFS':{'Layers':['old','new']}}
        receipt={'image':image,'parent':m.BASE_IMAGE,'imageConfigSha256':m.sha(m.enc(config)),'lastDiffId':'new'}
        for mutation in(None,'parent','config','layer','receipt'):
            doc=copy.deepcopy(receipt);observed=copy.deepcopy(child_info)
            if mutation=='parent':doc['parent']='sha256:'+'b'*64
            if mutation=='config':observed['Config']['Entrypoint']=['foreign']
            if mutation=='layer':observed['RootFS']['Layers']=['foreign','new']
            if mutation=='receipt':doc['lastDiffId']='foreign'
            with patch.object(m,'image_info',side_effect=lambda key:parent if key==m.BASE_IMAGE else observed),patch.object(m,'audit_saved_layer')as archive:
                if mutation:
                    with self.assertRaises(ValueError):m.built_image_guard({'tree':{}},{'files':[]},doc)
                    archive.assert_not_called()
                else:m.built_image_guard({'tree':{}},{'files':[]},doc);archive.assert_called_once()

    def test_actual_fallback_validator_binds_forward_parent_and_complete_tree(self):
        f=load('protocol_r2_fallback',HERE/'fallback_image.py');base={'tree':{'file':{'sha256':'forward'}}};forward={'image':'sha256:'+'a'*64};doc={'files':[]};config={'Entrypoint':['original']}
        receipt={'image':'sha256:'+'b'*64,'parent':forward['image'],'imageConfigSha256':m.sha(m.enc(config)),'lastDiffId':'fallback','manifestSha256':m.sha(m.enc(doc))}
        for mutation in(None,'parent','tree','config','layer'):
            note=copy.deepcopy(receipt);after={'Config':copy.deepcopy(config),'RootFS':{'Layers':['base','forward','fallback']}};tree=copy.deepcopy(base['tree'])
            if mutation=='parent':note['parent']='sha256:'+'c'*64
            if mutation=='tree':tree['file']['sha256']='foreign'
            if mutation=='config':after['Config']['Entrypoint']=['foreign']
            if mutation=='layer':after['RootFS']['Layers']=['base','foreign','fallback']
            x=types.SimpleNamespace(AREA=Path('/fake'),need=m.need,IMAGE=m.IMAGE,enc=m.enc,sha=m.sha,load=lambda _:note,image_info=lambda key:{'Config':config,'RootFS':{'Layers':['base','forward']}} if key==forward['image']else after,image_tree=lambda _:tree,expected_tree=lambda *_:base['tree'],audit_saved_layer=lambda *_:None)
            with patch.object(f,'parent',return_value=(base,forward)),patch.object(f,'manifest',return_value=doc):
                if mutation:
                    with self.assertRaises(ValueError):f.validate(x)
                else:self.assertEqual(f.validate(x),receipt)

    def test_cli_cannot_prepare_or_apply_outside_single_release(self):
        source=(HERE/'install.py').read_text();self.assertNotIn("elif mode=='prepare':",source);self.assertNotIn("elif mode=='apply':",source)
        self.assertIn("elif mode=='release':module('prebuild.py').release",source)

    def test_image_anchor_is_closed_without_database_facts_and_bound_to_lease(self):
        with tempfile.TemporaryDirectory()as directory:
            area=Path(directory);base={'kind':'CODE_IMAGE_ONLY_NOT_DATABASE_BASE_OR_APPLY_PERMIT','lease':{'pid':1},'created':0,'expires':10**12,'rows':{},'tree':{},'databases':{},'plan':{},'hostStatic':{},'static':{},'policy':{},'price':{},'managed':{}}
            def save():
                raw=m.enc(base);(area/'image-base.json').write_bytes(raw);(area/'image-prepared.json').write_bytes(m.enc({'imageBaseSha256':m.sha(raw),'stageManifestSha256':'manifest','helperSha256':'helper'}))
            x=types.SimpleNamespace(AREA=area,package=lambda:({'manifestSha256':'manifest','helperSha256':'helper'},{}),safe_read=lambda q:q.read_bytes(),load=lambda q:json.loads(q.read_bytes()),need=m.need,sha=m.sha,own_lease=lambda:{'pid':1})
            save();self.assertEqual(p.image_anchor(x),base)
            x.own_lease=lambda:{'pid':2}
            with self.assertRaisesRegex(ValueError,'IMAGE_OWN_LEASE_CHANGED'):p.image_anchor(x)
            x.own_lease=lambda:{'pid':1};base['databaseFacts']={'crm':'stale'};save()
            with self.assertRaisesRegex(ValueError,'EXACT_IMAGE_ANCHOR_KEYS'):p.image_anchor(x)

if __name__=='__main__':unittest.main()
