"""Comparison-only normalization of four reviewed, initially empty additive tables."""
import copy,json
CONTENT='/data/content.sqlite'
ACCOUNT='/data/projects/palitra-love/sites/site-44bbe13f1bad5e005b2a/private/draft-accounts.sqlite'
NAMES={CONTENT:('chat_web_account_bindings','chat_web_preliminary_profiles','chat_web_preliminary_requests'),ACCOUNT:('account_auth_outcomes',)}
enc=lambda v:json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def need(ok,reason):
 if not ok:raise ValueError(reason)
def normalize(facts,path,schema,before=None):
 need(path in NAMES and set(schema)==set(NAMES),'EXACT_ADDITIVE_DATABASE_SCOPE')
 expected=schema[path];names=set(NAMES[path]);need(set(expected)==names,'EXACT_ADDITIVE_TABLE_SCOPE')
 value=copy.deepcopy(facts)
 for name in names:
  need(name in value['tables'],'ADDITIVE_TABLE_NOT_CREATED')
  table=value['tables'][name];wanted=expected[name]
  need(set(wanted)=={'columns','objects'}and table['columns']==wanted['columns'],'ADDITIVE_EXACT_COLUMNS')
  objects=[r for r in value['schema']if r[2]==name]
  need(enc(objects)==enc(wanted['objects']),'ADDITIVE_EXACT_SCHEMA_OBJECTS')
  if before is not None and name in before['tables']:continue
  need(table['rows']=={},'ADDITIVE_TABLE_NONEMPTY_INSPECT_ONLY')
  del value['tables'][name]
 removed={name for name in names if name not in value['tables']}
 value['schema']=[r for r in value['schema']if r[2]not in removed]
 return value
