import copy,importlib.util,sqlite3,sys,types,unittest,contextlib
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
sys.dont_write_bytecode=True
def module(path,name):
    s=importlib.util.spec_from_file_location(name,path)
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=module(ROOT/'ops/palitra-auth-chat-production-20261031-r7/install.py','frozen_guard')
d=module(ROOT/'ops/palitra-auth-chat-static-current-20261031-r1/drift.py','frozen_classifier')
a=types.SimpleNamespace(classify=d.observed_appends,SESSION_CREATED=d.SESSION_CREATED,SESSION_EXPIRES=d.SESSION_EXPIRES,REMINDER_CREATED=d.REMINDER_CREATED,REMINDER_COMPLETED=d.REMINDER_COMPLETED)

class ObservedAppends(unittest.TestCase):
    def setUp(self):
        self.old=sqlite3.connect(':memory:',isolation_level=None)
        self.live=sqlite3.connect(':memory:',isolation_level=None)
        self.addCleanup(self.old.close);self.addCleanup(self.live.close)
        self.old.executescript('''
        CREATE TABLE project_chat_rooms(company_code TEXT PRIMARY KEY,telegram_chat_id TEXT);
        INSERT INTO project_chat_rooms VALUES('palitra-love','synthetic-room');
        CREATE TABLE chat_web_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,token_hash TEXT,csrf_hash TEXT,site TEXT,company_code TEXT,origin TEXT,scope TEXT,account_kind TEXT,account_user_id TEXT,created_at TEXT,expires_at TEXT,revoked_at TEXT);
        CREATE TABLE content_review_reminder_runs(company_code TEXT,run_date TEXT,phase TEXT,target_date TEXT,chat_id TEXT,status TEXT,attempts INTEGER,last_error TEXT,created_at TEXT,completed_at TEXT,PRIMARY KEY(company_code,run_date,phase));
        INSERT INTO content_review_reminder_runs VALUES('palitra-love','2026-10-30','evening','2026-10-31','synthetic-room','empty',1,NULL,'2026-10-30T15:00:00.000Z','2026-10-30T15:00:01.000Z');
        CREATE TABLE ai_balance_snapshots(provider TEXT PRIMARY KEY,revision INTEGER,status TEXT,data TEXT,error TEXT,checked_at INTEGER,attempt_at INTEGER);
        CREATE TABLE client_bot_bridge_state(bot_key TEXT PRIMARY KEY,checked_at TEXT,payload TEXT);
        INSERT INTO client_bot_bridge_state VALUES('fixture','2026-10-31T13:00:00.000Z','unchanged synthetic payload');
        CREATE TABLE hugh_owner_alerts(id INTEGER PRIMARY KEY AUTOINCREMENT);
        INSERT INTO hugh_owner_alerts DEFAULT VALUES;
        CREATE TABLE customer_records(id INTEGER PRIMARY KEY,body TEXT);
        INSERT INTO customer_records VALUES(1,'synthetic existing history');
        CREATE TABLE chat_web_account_bindings(session_id INTEGER PRIMARY KEY,account_user_id TEXT);
        ''')
        self.old.execute('INSERT INTO chat_web_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            (23,'a'*64,'b'*64,'palitra','palitra-love','https://palitra-love.ru','customer_chat','guest',None,'2026-10-30T10:00:00.000Z','2026-11-29T10:00:00.000Z',None))
        self.begin=d.stamp('2026-10-31T12:00:00.000Z');self.end=d.stamp('2026-11-01T08:00:00.000Z')
        at=int(d.stamp('2026-10-31T13:00:00.000Z')*1000)
        self.old.execute('INSERT INTO ai_balance_snapshots VALUES(?,?,?,?,?,?,?)',('deepseek',1,'ok','synthetic fixed payload','',at,at))
        self.old.backup(self.live)
        self.live.execute('INSERT INTO chat_web_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            (24,'c'*64,'d'*64,'palitra','palitra-love','https://palitra-love.ru','customer_chat','guest',None,a.SESSION_CREATED,a.SESSION_EXPIRES,None))
        self.live.execute('INSERT INTO content_review_reminder_runs VALUES(?,?,?,?,?,?,?,?,?,?)',
            ('palitra-love','2026-10-31','evening','2026-11-01','synthetic-room','empty',1,None,a.REMINDER_CREATED,a.REMINDER_COMPLETED))
    def validate(self):
        # Read via fresh query-only connections, like production; fixture setup
        # and injected mutations never share the guarded reader connection.
        with contextlib.closing(sqlite3.connect(':memory:',isolation_level=None)) as old,contextlib.closing(sqlite3.connect(':memory:',isolation_level=None)) as live:
            old.deserialize(self.old.serialize());live.deserialize(self.live.serialize())
            old.execute('PRAGMA query_only=ON');live.execute('PRAGMA query_only=ON')
            before=m.db_facts(old);after=m.db_facts(live)
            normalized,proof=a.classify(m,d,before,after,old,live,self.begin,self.end)
            bridge=m.sha(m.enc([m.cell('fixture')]))
            seq=next(k for k,r in d.records(m,old,'sqlite_sequence').items()if r['name']=='hugh_owner_alerts')
            diag={'bridge':{'key':bridge,'payload':'synthetic fixed payload','checkedAt':'2026-10-31T13:00:00.000Z'},'sequence':{'key':seq,'name':'hugh_owner_alerts','value':1}}
            with patch.object(m,'diagnostic_policy',return_value=types.SimpleNamespace(stamp=d.stamp)):
                d.content(m,before,normalized,diag,copy.deepcopy(diag),d.records(m,old,'ai_balance_snapshots'),d.records(m,live,'ai_balance_snapshots'),self.begin,self.end)
            return proof
    def test_exact_two_appends_preserve_all_original_rows(self):
        self.assertEqual(self.validate()['kind'],'EXACT_GUEST24_AND_EMPTY_EVENING_REMINDER_20261031')
    def test_original_no_append_path_still_valid(self):
        self.live.close();self.live=sqlite3.connect(':memory:',isolation_level=None);self.old.backup(self.live)
        self.addCleanup(self.live.close)
        self.assertEqual(self.validate()['kind'],'NO_OBSERVED_APPENDS')
    def test_session_semantic_negatives(self):
        cases=[('site','foreign'),('company_code','foreign'),('origin','https://invalid.example'),('scope','admin'),('account_kind','user'),('account_user_id','synthetic-user'),('created_at','2026-10-31T16:04:10.018Z'),('expires_at','2026-12-30T16:03:10.018Z'),('revoked_at',a.SESSION_CREATED),('token_hash','x'*64),('csrf_hash','f'*63)]
        for column,value in cases:
            with self.subTest(column=column):
                self.live.execute('SAVEPOINT negative')
                self.live.execute('UPDATE chat_web_sessions SET '+column+'=? WHERE id=24',(value,))
                with self.assertRaises(ValueError):self.validate()
                self.live.execute('ROLLBACK TO negative');self.live.execute('RELEASE negative')
    def test_reminder_semantic_negatives(self):
        for column,value in [('target_date','2026-11-02'),('status','queued'),('attempts',2),('last_error','synthetic error'),('chat_id','another-room'),('created_at','2026-10-31T15:01:00.000Z'),('completed_at','2026-10-31T15:01:01.000Z')]:
            with self.subTest(column=column):
                self.live.execute('SAVEPOINT negative')
                self.live.execute('UPDATE content_review_reminder_runs SET '+column+'=? WHERE run_date=?',(value,'2026-10-31'))
                with self.assertRaises(ValueError):self.validate()
                self.live.execute('ROLLBACK TO negative');self.live.execute('RELEASE negative')
    def test_extra_session_and_unknown_grant_not_hidden(self):
        for sql in ["INSERT INTO chat_web_sessions(id) VALUES(25)","INSERT INTO chat_web_account_bindings VALUES(24,'synthetic-new-binding')"]:
            with self.subTest(sql=sql):
                self.live.execute('SAVEPOINT negative');self.live.execute(sql)
                with self.assertRaises(ValueError):self.validate()
                self.live.execute('ROLLBACK TO negative');self.live.execute('RELEASE negative')
    def test_old_message_update_or_delete_not_hidden(self):
        for sql in ["UPDATE customer_records SET body='changed' WHERE id=1",'DELETE FROM customer_records WHERE id=1']:
            with self.subTest(sql=sql):
                self.live.execute('SAVEPOINT negative');self.live.execute(sql)
                with self.assertRaises(ValueError):self.validate()
                self.live.execute('ROLLBACK TO negative');self.live.execute('RELEASE negative')
    def test_old_session_update_not_hidden(self):
        self.live.execute("UPDATE chat_web_sessions SET revoked_at='synthetic' WHERE id=23")
        with self.assertRaises(ValueError):self.validate()
    def test_sequence_extra_step_not_accepted(self):
        self.live.execute("UPDATE sqlite_sequence SET seq=25 WHERE name='chat_web_sessions'")
        with self.assertRaises(ValueError):self.validate()
    def test_schema_change_not_accepted(self):
        self.live.execute('CREATE TABLE unexpected(id INTEGER)')
        with self.assertRaises(ValueError):self.validate()
    def test_time_window_not_reanchored(self):
        self.begin=d.stamp('2026-10-31T17:00:00.000Z')
        with self.assertRaises(ValueError):self.validate()

if __name__=='__main__':unittest.main()
