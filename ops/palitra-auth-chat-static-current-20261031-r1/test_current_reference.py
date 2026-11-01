import ast,copy,hashlib,importlib.util,json,unittest,types
from datetime import datetime
from pathlib import Path
HERE=Path(__file__).resolve().parent
def module(path,name):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
v=module(HERE/'drift.py','actual_reference')
class Pure:
    @staticmethod
    def need(ok,reason):
        if not ok:raise ValueError(reason)
    @staticmethod
    def enc(value):return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
    @staticmethod
    def sha(value):return hashlib.sha256(value).hexdigest()
    @staticmethod
    def diagnostic_policy():return types.SimpleNamespace(stamp=lambda value:datetime.fromisoformat(value.replace('Z','+00:00')).timestamp())
m=Pure()
def facts():return {'schema':[['table','synthetic','synthetic','fixed schema']], 'tables':{
    'orders':{'columns':['id','body'],'rows':{'kept':'old-order-hash'}},
    'sessions':{'columns':['id','opaque'],'rows':{'kept':'old-session-hash'}},
    'client_bot_bridge_state':{'columns':['key','opaque'],'rows':{'bridge':'old-diag-hash'}},
    'sqlite_sequence':{'columns':['name','seq'],'rows':{'diag':'old-counter-hash'}}}}
def diag():return {'bridge':{'key':'bridge','payload':'fixed','checkedAt':'2026-10-31T13:00:00.000Z'},'sequence':{'key':'diag','name':'hugh_owner_alerts','value':1}}
class CurrentReference(unittest.TestCase):
    def test_current_orders_and_sessions_are_preserved_in_new_reference_not_restored(self):
        before=facts();current=copy.deepcopy(before)
        current['tables']['orders']['rows']['new']='synthetic-new-real-order'
        current['tables']['sessions']['rows']['new']='synthetic-new-session'
        original=copy.deepcopy(current)
        proof=v.current_reference(m,before,current)
        self.assertEqual(current,original)
        self.assertEqual(proof['factsSha256'],m.sha(m.enc(current)))
        self.assertFalse(proof['oldBusinessRowsAssertedUnchangedSinceYesterday'])
    def test_second_capture_detects_new_or_updated_or_deleted_business_rows(self):
        before=facts();first=v.current_reference(m,before,before)
        for change in ('new','update','delete'):
            with self.subTest(change=change):
                current=facts()
                if change=='new':current['tables']['orders']['rows']['new']='hash'
                elif change=='update':current['tables']['orders']['rows']['kept']='different'
                else:del current['tables']['orders']['rows']['kept']
                self.assertNotEqual(first,v.current_reference(m,before,current))
    def test_schema_table_and_column_changes_are_rejected(self):
        for change in ('schema','table','column'):
            with self.subTest(change=change):
                before=facts();current=copy.deepcopy(before)
                if change=='schema':current['schema'].append(['trigger','unknown','orders','unknown'])
                elif change=='table':current['tables']['unexpected']={'columns':[],'rows':{}}
                else:current['tables']['orders']['columns'].append('unknown')
                with self.assertRaises(ValueError):v.current_reference(m,before,current)
    def test_only_original_diagnostic_two_cells_may_move_between_reference_captures(self):
        before=facts();current=copy.deepcopy(before);a=diag();b=copy.deepcopy(a);b['sequence']['value']=2
        current['tables']['client_bot_bridge_state']['rows']['bridge']='new-diag-hash'
        current['tables']['sqlite_sequence']['rows']['diag']='new-counter-hash'
        self.assertEqual(v.current_reference(m,before,before,a,a),v.current_reference(m,before,current,a,b))
        current['tables']['orders']['rows']['kept']='changed'
        self.assertNotEqual(v.current_reference(m,before,before,a,a),v.current_reference(m,before,current,a,b))
    def test_unknown_diagnostic_key_payload_or_regression_is_rejected(self):
        for change in ('key','payload','sequence','name','regression','time-regression'):
            with self.subTest(change=change):
                a=diag();b=copy.deepcopy(a)
                if change=='key':b['bridge']['key']='foreign'
                elif change=='payload':b['bridge']['payload']='changed'
                elif change=='sequence':b['sequence']['key']='foreign'
                elif change=='name':b['sequence']['name']='foreign'
                elif change=='regression':b['sequence']['value']=0
                else:b['bridge']['checkedAt']='2026-10-31T12:00:00.000Z'
                with self.assertRaises(ValueError):v.current_reference(m,facts(),facts(),a,b)
    def test_no_sql_network_or_application_mutation_capability(self):
        tree=next(n for n in ast.parse((HERE/'drift.py').read_bytes()).body if isinstance(n,ast.FunctionDef)and n.name=='current_reference')
        calls={n.func.attr for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)}
        self.assertFalse(calls & {'execute','connect','executescript','run','write_new','replace','backup','release','apply','build','restore'})
if __name__=='__main__':unittest.main()
