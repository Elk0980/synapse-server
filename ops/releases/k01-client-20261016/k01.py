"""Compact Root entrypoint. Each operation is a separate explicit action; no retries."""
import argparse,hashlib,json,os,re,sys,types
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
CODE=ROOT/'k01-client-code-r1'
HELPER_SHA='f826fbdbe6a26c2b3fa37b062bc1a1a17777ab51dcc2bfb36c84a33ec143e25a'
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=('inspect-current','approve-current','apply','inspect'));p.add_argument('--lease-pid',required=True,type=int);p.add_argument('--decision-sha');p.add_argument('--receipt-sha');p.add_argument('--apply',action='store_true');args=p.parse_args()
 try:
  if os.name!='posix'or os.geteuid()!=0:raise ValueError('NATIVE_ROOT_K01_ENTRY_REQUIRED')
  if Path(__file__).resolve().parent!=CODE:raise ValueError('EXACT_K01_CODE_DIRECTORY_REQUIRED')
  path=CODE/'k01_release_native.py';raw=path.read_bytes()
  if sha(raw)!=HELPER_SHA:raise ValueError('FROZEN_K01_HELPER_REQUIRED')
  m=types.ModuleType('k01_frozen_release');m.__file__=str(path);exec(compile(raw,str(path),'exec'),m.__dict__)
  pairs={
   'reports-helper':ROOT/'reports-inventory-code-r1/reports_ui_release_native.py',
   'reports-payload':ROOT/'reports-inventory-code-r1',
   'reports-manifest-sha':'853da750bd6012cee38af6fd1f9695eeb2d27c7dc9f4feb06cb1116071b1e650',
   'activation-helper':ROOT/'photo-pair-code-r1/photo_activation_pair_native.py',
   'bundle':ROOT/'incremental-features1','photo-code':ROOT/'photo-ui-code-r1',
   'ui-code':ROOT/'ui-code-r1','l12-code':ROOT/'l12-code-r1','graph':ROOT/'workergraph1.py',
   'build-journal':ROOT/'.worker-images-photo-r1/verified-pair-r1.json',
   'runtime-proof':ROOT/'runtime-probe-r1-result.json',
   'push-diag-helper':ROOT/'push-diagnostic-code-r1/push_diagnostic_release_native.py',
   'push-diag-payload':ROOT/'push-diagnostic-code-r1/payload',
   'payload':CODE/'payload','manifest-sha':m.PAYLOAD_MANIFEST_SHA,'lease-pid':args.lease_pid,
  }
  pairs['build-sha']=sha(pairs['build-journal'].read_bytes());pairs['runtime-sha']=sha(pairs['runtime-proof'].read_bytes())
  if args.operation=='apply':pairs['decision-sha']=args.decision_sha or sha((ROOT/(m.NAME+'-decision.json')).read_bytes())
  if args.operation=='inspect':pairs['receipt-sha']=args.receipt_sha or sha((ROOT/(m.NAME+'-journal.json')).read_bytes())
  sys.argv=[str(path),args.operation]
  for key,value in pairs.items():sys.argv.extend(['--'+key,str(value)])
  if args.apply:sys.argv.append('--apply')
  return m.main()
 except Exception as e:
  message=str(e);code=message if type(e)is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,100}',message)else'K01_ENTRY_REFUSED'
  print(json.dumps({'status':'K01_ENTRY_REFUSED_NO_AUTOMATIC_RETRY','code':code,'messageSha256':sha(message.encode()),'automaticRetry':False},separators=(',',':')));return 2
if __name__=='__main__':sys.exit(main())
