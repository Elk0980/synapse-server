"""New read-contract checks. Synthetic observations; no Docker, network or native imports."""
from pathlib import Path
import ast, copy, importlib.util, io, json, shutil, subprocess, sys, tempfile, types, unittest, zipfile
from unittest.mock import patch
sys.dont_write_bytecode = True
HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('reader_component_candidate',HERE/'install.py')
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)
OLD_ZIP=HERE/'original-reader.zip'

def old_files():
    raw=OLD_ZIP.read_bytes();assert m.sha(raw)=='82ca78298c2b6eddda08b2d23e98e0d2d0022ef2ae851f01f2776461eeb4e3f3'
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        contract=json.loads(archive.read('reader-manifest.json'))
        return contract,{name:archive.read('reader-code/'+name) for name in contract['files']}

def synthetic_observations():
    graph={'schema':1,'files':{name:{'available':True,'size':index+1,'mode':420,'sha256':str(index)*64} for index,name in enumerate(sorted(m.WORKER_FILES))}}
    tree={'':{'uid':0,'gid':0,'mode':493,'type':'directory'}}
    for index in range(29):tree['file-'+str(index)]={'uid':0,'gid':0,'mode':420,'type':'file','nlink':1,'bytes':index+1,'sha256':'f'*64}
    return graph,tree

class ReaderBundleTests(unittest.TestCase):
    def test_original_five_code_files_byte_exact(self):
        _,files=old_files()
        for name in m.READER_CODE_PINS:self.assertEqual((HERE/'reader'/name).read_bytes(),files[name])
    def test_spec_only_known_bridge_pair_changes(self):
        _,files=old_files();original=json.loads(files['spec.json']);revised=json.loads((HERE/'reader/spec.json').read_bytes())
        m.assert_reader_rebase(original,revised)
        self.assertEqual(revised['workerGraphExpected']['client-bot-bridge.js'],[27676,'36b0bdc733ad4f4514635d0416867d5964fef4c82aeabe125f542a20969de0ee'])
    def test_any_other_spec_field_or_worker_entry_change_rejected(self):
        _,files=old_files();original=json.loads(files['spec.json']);revised=json.loads((HERE/'reader/spec.json').read_bytes())
        mutations=[lambda x:x.update(workerNodeOptionsSha256='0'*64),lambda x:x['workerHookNames'].remove('NODE_OPTIONS'),lambda x:x['workerGraphExpected'].pop('server.js'),lambda x:x['workerGraphExpected'].__setitem__('server.js',[1,'0'*64]),lambda x:x.update(unrequested=True)]
        for mutate in mutations:
            bad=copy.deepcopy(revised);mutate(bad)
            with self.assertRaises(ValueError):m.assert_reader_rebase(original,bad)
    def test_new_manifest_preserves_all_scopes_and_original_contract(self):
        original,_=old_files();current=json.loads((HERE/'reader-manifest.json').read_bytes())
        m.validate_reader_manifest(current,original)
        self.assertEqual(current['readScriptScopes'],original['readScriptScopes'])
    def test_probe_or_header_contract_widening_rejected(self):
        current=json.loads((HERE/'reader-manifest.json').read_bytes())
        for mutate in (lambda x:x['readScriptScopes'][m.READER_CODE_PINS['worker-graph.js']].update(images=True),lambda x:x['readScriptScopes'][m.READER_CODE_PINS['tree.js']]['containers'].append(m.WORKER),lambda x:x.update(readOnly=False),lambda x:x['readScriptSha256'].append('0'*64),lambda x:x.update(entry='/tmp/reader.py')):
            bad=copy.deepcopy(current);mutate(bad)
            with self.assertRaises(ValueError):m.validate_reader_manifest(bad)
    def test_reader_archive_pins_and_closure(self):
        raw=(HERE/'reader.zip').read_bytes();manifest,files=m.unpack_reader(raw)
        self.assertEqual(len(files),6);self.assertEqual(m.sha(manifest),m.READER_MANIFEST_SHA)
        with self.assertRaises(ValueError):m.unpack_reader(raw+b'changed')
    def test_staged_reader_rejects_extra_entries_and_changed_bytes(self):
        with patch.object(m,'AREA',HERE):self.assertEqual(len(m.reader_package()['files']),6)
        with tempfile.TemporaryDirectory(prefix='synthetic-reader-guard-',dir=HERE) as directory:
            area=Path(directory);shutil.copytree(HERE/'reader',area/'reader');shutil.copyfile(HERE/'reader-manifest.json',area/'reader-manifest.json')
            with patch.object(m,'AREA',area):
                m.reader_package();extra=area/'reader/extra';extra.mkdir()
                with self.assertRaisesRegex(ValueError,'READER_CLOSED_FILES'):m.reader_package()
                extra.rmdir();script=area/'reader/worker-graph.js';script.write_bytes(script.read_bytes()+b'changed')
                with self.assertRaisesRegex(ValueError,'READER_FILE_CHANGED'):m.reader_package()
    def test_real_root_proof_constants_are_exact(self):
        self.assertEqual(m.WORKER_GRAPH_SHA,'2c859e48348fc2ceeb9e403497aa81158c013c0937b14c5e9e7026c6eade999d')
        self.assertEqual(m.WORKER_TREE_SHA,'af68e20caf2e12f700b9a24d0d369dc0fc42a88303728f353243050ea0c05f54')
        self.assertEqual(m.WORKER_IMAGE,'sha256:4d5b047dc76bae1d2b82067406f98c344eea4033f83f35a54cdef7cd355ed2ae')
    def test_manifest_worker_pins_cannot_follow_another_fresh_image(self):
        import test_install
        for key,value in [('image','sha256:'+'0'*64),('treeSha256','0'*64),('graphSha256','0'*64),('readerManifestSha256','0'*64)]:
            candidate=test_install.manifest();candidate['workerCompatibility'][key]=value
            with self.assertRaisesRegex(ValueError,'EXACT_REVIEWED_WORKER'):m.validate_manifest(candidate)

class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.graph,self.tree=synthetic_observations()
        self.graph_pin=m.sha(m.enc(self.graph));self.tree_pin=m.sha(m.enc(self.tree))
        for item in (patch.object(m,'WORKER_GRAPH_SHA',self.graph_pin),patch.object(m,'WORKER_TREE_SHA',self.tree_pin)):
            item.start();self.addCleanup(item.stop)
    def check(self,graph=None,tree=None,image=None,image_graph=None,image_tree=None):
        return m.validate_worker_observation(image or m.WORKER_IMAGE,self.graph if image_graph is None else image_graph,self.graph if graph is None else graph,self.tree if image_tree is None else image_tree,self.tree if tree is None else tree)
    def test_closed_synthetic_image_runtime_equality(self):self.assertEqual(self.check()['treeEntries'],30)
    def test_wrong_image_rejected_even_when_both_observations_equal(self):
        with self.assertRaisesRegex(ValueError,'EXACT_ACCEPTED_WORKER_IMAGE'):self.check(image='sha256:'+'0'*64)
    def test_missing_or_extra_graph_file_rejected(self):
        for changed in (dict(list(self.graph['files'].items())[1:]),{**self.graph['files'],'extra.js':{}}):
            bad={**self.graph,'files':changed}
            with self.assertRaises(ValueError):self.check(graph=bad)
            with self.assertRaises(ValueError):self.check(graph=bad,image_graph=bad)
    def test_graph_byte_size_mode_or_availability_drift_rejected(self):
        for key,value in [('sha256','a'*64),('size',999),('mode',511),('available',False)]:
            bad=copy.deepcopy(self.graph);bad['files']['client-bot-bridge.js'][key]=value
            with self.assertRaisesRegex(ValueError,'PINNED_WORKER_GRAPH'):self.check(graph=bad)
    def test_pinned_image_graph_cannot_follow_fresh_actual(self):
        bad=copy.deepcopy(self.graph);bad['files']['server.js']['sha256']='a'*64
        with self.assertRaisesRegex(ValueError,'PINNED_WORKER_GRAPH'):self.check(graph=bad,image_graph=bad)
    def test_complete_tree_metadata_drift_rejected(self):
        for key,value in [('uid',1000),('gid',1000),('mode',511),('bytes',555),('nlink',2),('type','symlink'),('sha256','a'*64)]:
            bad=copy.deepcopy(self.tree);bad['file-0'][key]=value
            with self.assertRaisesRegex(ValueError,'PINNED_WORKER_FULL_TREE'):self.check(tree=bad)
    def test_full_tree_cannot_accept_extra_missing_or_fresh_image_drift(self):
        bad=copy.deepcopy(self.tree);bad.pop('file-0')
        with self.assertRaises(ValueError):self.check(tree=bad)
        bad=copy.deepcopy(self.tree);bad['file-0']['uid']=1000
        with self.assertRaises(ValueError):self.check(tree=bad,image_tree=bad)

def isolated_original_worker():
    # Execute only this unchanged gate function on synthetic data; not the native
    # module, entrypoint, filesystem reader, old release operations or production.
    source=(HERE/'reader/reader.py').read_text(encoding='utf-8')
    module=ast.parse(source);worker=next(node for cls in module.body if isinstance(cls,ast.ClassDef) and cls.name=='Reader' for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='worker')
    namespace={'need':m.need,'env_map':lambda rows:dict(row.split('=',1) for row in rows),'sha':m.sha,'encoded':m.enc,'WORKER':m.WORKER,'foreign':lambda row:{'unchanged':True}}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[worker],type_ignores=[])),'unchanged-worker-gate','exec'),namespace)
    return namespace['worker']

class OriginalGateTests(unittest.TestCase):
    def setUp(self):
        self.spec=json.loads((HERE/'reader/spec.json').read_bytes())
        self.options='--synthetic-unit-test-profile';self.spec['workerNodeOptionsSha256']=m.sha(self.options.encode())
        self.graph={'schema':1,'files':{name:{'available':True,'size':pair[0],'sha256':pair[1]} for name,pair in self.spec['workerGraphExpected'].items()}}
        self.instance=types.SimpleNamespace(spec=self.spec,script=lambda *args:copy.deepcopy(self.graph))
        self.worker=isolated_original_worker()
        self.row={'State':{'Running':True},'RestartCount':0,'Config':{'Env':['NODE_OPTIONS='+self.options],'Cmd':['node','server.js'],'Entrypoint':['docker-entrypoint.sh'],'WorkingDir':'/app','User':''},'Mounts':[{'Destination':'/data'}]}
    def test_original_worker_gate_accepts_valid_synthetic_fixture(self):self.assertIn('graphSha256',self.worker(self.instance,self.row))
    def test_original_startup_all_fields_still_enforced(self):
        for key,value in [('Cmd',['node','other.js']),('Entrypoint',['other']),('WorkingDir','/tmp'),('User','nobody')]:
            bad=copy.deepcopy(self.row);bad['Config'][key]=value
            with self.assertRaisesRegex(ValueError,'WORKER_STARTUP'):self.worker(self.instance,bad)
    def test_original_node_options_and_every_hook_still_enforced(self):
        bad=copy.deepcopy(self.row);bad['Config']['Env']=['NODE_OPTIONS=changed']
        with self.assertRaisesRegex(ValueError,'WORKER_EXISTING_NODE_PROFILE'):self.worker(self.instance,bad)
        for hook in self.spec['workerHookNames']:
            if hook=='NODE_OPTIONS':continue
            bad=copy.deepcopy(self.row);bad['Config']['Env'].append(hook+'=unapproved')
            with self.assertRaisesRegex(ValueError,'WORKER_EXISTING_NODE_PROFILE'):self.worker(self.instance,bad)
    def test_original_forbidden_mount_overlaps_still_enforced(self):
        for destination in ('/','/app','/app/file','/usr/local/bin','/usr/bin/node'):
            bad=copy.deepcopy(self.row);bad['Mounts']=[{'Destination':destination}]
            with self.assertRaisesRegex(ValueError,'NO_WORKER_APP_MOUNT_OVERLAP'):self.worker(self.instance,bad)
    def test_original_running_restart_and_graph_gates_still_enforced(self):
        for field,value in [('RestartCount',1),('State',{'Running':False})]:
            bad=copy.deepcopy(self.row);bad[field]=value
            with self.assertRaisesRegex(ValueError,'EXISTING_UNRESTARTED_WORKER'):self.worker(self.instance,bad)
        self.graph['files']['client-bot-bridge.js']['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'ACTUAL_WORKER_GRAPH_FILE'):self.worker(self.instance,self.row)

class RootProbeShapeTests(unittest.TestCase):
    setUp=ObservationTests.setUp
    def test_hardcoded_root_probe_has_no_network_mount_env_or_generic_target(self):
        row={'Name':'/'+m.WORKER,'Id':'1'*64,'Image':m.WORKER_IMAGE,'State':{'Running':True}}
        foreign={'fixed':'original-snapshot'};snapshot={'invariants':{'foreignContainers':{m.WORKER:foreign}}}
        old={'inspect':lambda name:copy.deepcopy(row),'image_info':lambda image:{'Id':m.WORKER_IMAGE,'Os':'linux','Architecture':'amd64','Config':{'Env':[],'WorkingDir':'/app','Cmd':['node','server.js'],'Entrypoint':['docker-entrypoint.sh']}}}
        reader=types.SimpleNamespace(foreign=lambda row:foreign,env_map=lambda rows:dict(item.split('=',1) for item in rows),parse=json.loads)
        calls=[]
        def run(argv,**kwargs):
            calls.append(argv);script=argv[-1]
            body=self.graph if script==(HERE/'reader/worker-graph.js').read_text(encoding='utf-8') else self.tree
            return types.SimpleNamespace(returncode=0,stdout=m.enc(body),stderr=b'')
        with patch.object(m,'AREA',HERE),patch.object(m.subprocess,'run',side_effect=run):proof=m.pinned_worker_probe(old,reader,snapshot)
        self.assertEqual(proof['containerId'],row['Id']);self.assertEqual(len(calls),4)
        for argv in calls:
            if argv[1]=='run':
                self.assertEqual(argv[:10],['docker','run','--rm','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint=node',m.WORKER_IMAGE,'-e'])
            else:self.assertEqual(argv[:5],['docker','exec',row['Id'],'node','-e'])
    def test_identity_change_during_probe_rejected(self):
        row={'Name':'/'+m.WORKER,'Id':'1'*64,'Image':m.WORKER_IMAGE};states=iter([row,{**row,'Id':'2'*64}]);foreign={'fixed':True}
        old={'inspect':lambda name:next(states),'image_info':lambda image:{'Id':m.WORKER_IMAGE,'Os':'linux','Architecture':'amd64','Config':{'Env':[],'WorkingDir':'/app','Cmd':['node','server.js'],'Entrypoint':['docker-entrypoint.sh'],'User':''}}}
        reader=types.SimpleNamespace(foreign=lambda row:foreign,env_map=lambda rows:{},parse=json.loads)
        def run(argv,**kwargs):return types.SimpleNamespace(returncode=0,stdout=m.enc(self.graph if argv[-1]==(HERE/'reader/worker-graph.js').read_text(encoding='utf-8') else self.tree),stderr=b'')
        with patch.object(m,'AREA',HERE),patch.object(m.subprocess,'run',side_effect=run):
            with self.assertRaisesRegex(ValueError,'WORKER_IDENTITY_CHANGED_DURING_PROBE'):m.pinned_worker_probe(old,reader,{'invariants':{'foreignContainers':{m.WORKER:foreign}}})

if __name__=='__main__':unittest.main(verbosity=2)
