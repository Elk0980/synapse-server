"""Local assembler only. Needs frozen scoped-R2 pins and reviewed full inventory.
Usage: make_manifest.py FRESH_FIVE_IMAGES_JSON SOURCE_REVIEWED_DB_INVENTORY_JSON OUTPUT
It does not acquire a lease or claim that file-based inputs prove live freshness.
"""
from pathlib import Path
import importlib.util,json,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('content_durable',Path(__file__).with_name('install.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def build(images,inventory):
    m.need(all(after is not None for before,after in m.FILE_PINS.values()),'SCOPED_R2_PINS_NOT_FROZEN')
    m.need(m.INVENTORY_REVIEW_SHA is not None,'PERSISTENT_DB_INVENTORY_NOT_FROZEN')
    rows=[]
    for target,(before,after)in m.FILE_PINS.items():
        path=Path(__file__).parent/'payload'/target.removeprefix('/app/');raw=path.read_bytes();m.need(not path.is_symlink()and m.sha(raw)==after,'REVIEWED_SCOPED_PAYLOAD_REQUIRED')
        rows.append({'target':target,'beforeSha256':before,'afterSha256':after,'bytes':len(raw)})
    return m.validate_manifest({'schema':1,'packageId':m.NAME,'status':'ROOT_REVIEWED_CODE_ONLY','helperSha256':m.sha(m.SELF.read_bytes()),'expectedImages':images,'files':rows,'databaseInventory':inventory})
if __name__=='__main__':
    m.need(len(sys.argv)==4,'EXACT_THREE_INPUTS_REQUIRED');value=build(json.loads(Path(sys.argv[1]).read_bytes()),json.loads(Path(sys.argv[2]).read_bytes()));out=Path(sys.argv[3]);m.write_new(out,m.enc(value));print('MANIFEST_SHA256 '+m.sha(out.read_bytes()))
