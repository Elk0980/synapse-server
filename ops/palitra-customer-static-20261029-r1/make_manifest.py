"""Local code-only manifest assembly. No network or production access.
Usage: make_manifest.py FRESH_BEFORE_SHELL FRESH_BEFORE_COMPOSER FRESH_FIVE_IMAGES_JSON OUTPUT
Fresh files and image IDs must come from the new Root-owned native inspection.
The helper independently verifies actual live SHA/image IDs under its fresh lease.
SHOP is deliberately excluded: no unverified host-target argument is accepted.
"""
from pathlib import Path
import importlib.util,json,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('customer_static_release',Path(__file__).with_name('install.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
PINS=(
('4dc36614a11fccdd18320611933d6ba9d715616e5d6733c01e3347ed650743e9','b40b738cab687e863fffc7e18486b068d5e2b21ed43bf5abfd230ae9d3244588'),
('ae3d3117b41aa534f05da6463f9fb5efc06123375a962576b89e92f59312b470','424bd6cba01ffffc614ce038cc2259662c19b4cdb5d5bf7b66cfc669d3e2bdcc'))
def build(before_paths,images):
    m.need(len(before_paths)==2,'EXACT_TWO_FRESH_BEFORE_FILES_REQUIRED')
    rows=[]
    for target,before_path,pins in zip(m.SCOPE,before_paths,PINS):
        before_path=Path(before_path)
        after_path=Path(__file__).parent/'payload'/target
        for path in (before_path,after_path):
            m.need(not path.is_symlink() and path.resolve().is_file(),'CANONICAL_REVIEWED_FILES_REQUIRED')
        m.need(m.sha(before_path.read_bytes())==pins[0],'FRESH_INSTALLED_TARGET_SHA_REQUIRED')
        m.need(m.sha(after_path.read_bytes())==pins[1],'REVIEWED_AFTER_SHA_REQUIRED')
        rows.append({'target':target,'beforeSha256':pins[0],'afterSha256':pins[1]})
    return m.validate_manifest({'schema':1,'status':'ROOT_REVIEWED_CODE_ONLY','packageId':m.NAME,'helperSha256':m.sha(m.SELF.read_bytes()),'expectedImages':images,'targets':rows})
if __name__=='__main__':
    m.need(len(sys.argv)==5,'EXACT_FOUR_ARGUMENTS_REQUIRED_SHOP_NOT_SUPPORTED')
    value=build(sys.argv[1:3],json.loads(Path(sys.argv[3]).read_bytes()))
    out=Path(sys.argv[4]);m.write_new(out,m.enc(value));print('MANIFEST_SHA256 '+m.sha(out.read_bytes()))
