"""Read-only diagnostic of the frozen K01 inspect-current path. No raw exceptions or locals."""
import contextlib,hashlib,io,json,os,sys,types
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
CODE=ROOT/'k01-client-code-r1'
WRAPPER_SHA='8e4085f2088f383c46ae488be1dcb94d68f9e79dc9e1be05bc7c4aaadf058d99'
KNOWN={'k01.py','k01_release_native.py','photo_activation_pair_native.py','photo_ui_release_native.py','reports_ui_release_native.py','push_diagnostic_release_native.py','ui_release_native.py','l12_release_native.py','incremental_native.py','workergraph1.py'}
TYPES={FileNotFoundError:'FILE_NOT_FOUND',KeyError:'KEY_ERROR',AttributeError:'ATTRIBUTE_ERROR',TypeError:'TYPE_ERROR',ValueError:'VALUE_ERROR',RuntimeError:'RUNTIME_ERROR',PermissionError:'PERMISSION_ERROR',OSError:'OS_ERROR',AssertionError:'ASSERTION_ERROR'}
RESOURCES={}
for name in ('shell.js','design-data.js'):
 for path in ('palitra-orders-public/'+name,str(ROOT/'app/palitra-orders-public'/name),'/opt/synapse/sites/synapse/cabinet/palitra-orders/'+name):RESOURCES[path]=name
for name in ('app.js','form-builder.js','index.html'):RESOURCES['/opt/synapse/sites/synapse/cabinet/project-forms/'+name]='editor/'+name
for path in (CODE/'k01_release_native.py',ROOT/'push-diagnostic-code-r1/push_diagnostic_release_native.py',ROOT/'reports-inventory-code-r1/reports_ui_release_native.py',ROOT/'photo-pair-code-r1/photo_activation_pair_native.py',ROOT/'push-diagnostic-ui-r1-journal.json'):
 RESOURCES[str(path)]=path.name

def main():
 events=[]
 def trace(frame,event,arg):
  if event!='exception':return trace
  path=Path(frame.f_code.co_filename)
  if not path.is_relative_to(ROOT)or path.name not in KNOWN:return trace
  kind,error,_=arg
  if kind not in TYPES:return trace
  row={'type':kind.__name__,'code':TYPES[kind],'filename':path.name,'line':frame.f_lineno}
  resource=getattr(error,'filename',None)
  if resource is None and kind is KeyError and len(error.args)==1 and type(error.args[0])is str:resource=error.args[0]
  if type(resource)is str and resource in RESOURCES:row['resource']=RESOURCES[resource]
  if not events or events[-1]!=row:events.append(row)
  if len(events)>24:events.pop(0)
  return trace
 try:
  if os.name!='posix'or os.geteuid()!=0:raise ValueError('NATIVE_ROOT_REQUIRED')
  raw=(CODE/'k01.py').read_bytes()
  if hashlib.sha256(raw).hexdigest()!=WRAPPER_SHA:raise ValueError('FROZEN_WRAPPER_REQUIRED')
  m=types.ModuleType('k01_readonly_diagnostic');m.__file__=str(CODE/'k01.py');exec(compile(raw,m.__file__,'exec'),m.__dict__)
  sys.argv=[m.__file__,'inspect-current','--lease-pid','2864256']
  sys.settrace(trace)
  try:
   with contextlib.redirect_stdout(io.StringIO()):result=m.main()
  finally:sys.settrace(None)
  print(json.dumps({'status':'K01_INSPECT_CURRENT_DIAGNOSTIC_ONLY','operation':'inspect-current','exitCode':result,'events':events,'runtimeWrites':0,'directDbWrites':0,'automaticRetry':False},separators=(',',':')));return result
 except Exception:
  sys.settrace(None);print(json.dumps({'status':'K01_DIAGNOSTIC_REFUSED','code':'DIAGNOSTIC_PREREQUISITE_REFUSED','events':events,'runtimeWrites':0,'directDbWrites':0,'automaticRetry':False},separators=(',',':')));return 2
if __name__=='__main__':sys.exit(main())
