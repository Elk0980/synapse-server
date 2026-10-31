"""Code-only R10 assembler; no claim that supplied fresh image metadata is live proof."""
from pathlib import Path
import importlib.util,json,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('attention_manifest',Path(__file__).with_name('install.py'));m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
def build(images,inventory):
 rows=[];hosts=[]
 for target,(before,after)in m.FILE_PINS.items():
  raw=(Path(__file__).parent/'payload'/target.removeprefix('/app/')).read_bytes();m.need(m.sha(raw)==after,'FOUR_REVIEWED_RUNTIME_PAYLOAD_REQUIRED');rows.append({'target':target,'beforeSha256':before,'afterSha256':after,'bytes':len(raw)})
 for target,(before,after)in m.STATIC_PINS.items():
  raw=(Path(__file__).parent/'static-payload'/m.STATIC_NAMES[target]).read_bytes();m.need(m.sha(raw)==after,'TWO_REVIEWED_HOST_PAYLOAD_REQUIRED');hosts.append({'target':target,'beforeSha256':before,'afterSha256':after,'bytes':len(raw)})
 return m.validate_manifest({'schema':1,'packageId':m.NAME,'status':'ROOT_REVIEWED_CODE_ONLY','helperSha256':m.sha(m.SELF.read_bytes()),'expectedImages':images,'files':rows,'staticFiles':hosts,'databaseInventory':inventory})
if __name__=='__main__':
 m.need(len(sys.argv)==4,'EXACT_THREE_ASSEMBLER_INPUTS');v=build(json.loads(Path(sys.argv[1]).read_bytes()),json.loads(Path(sys.argv[2]).read_bytes()));m.write_new(Path(sys.argv[3]),m.enc(v));print('MANIFEST_SHA256 '+m.sha(m.enc(v)))
