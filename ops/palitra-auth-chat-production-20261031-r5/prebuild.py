"""Build immutable images before the final database preservation anchor.

This module never opens a database for writing, starts an application, changes a
running service or advances an existing anchor. Database facts belong only to
the unchanged final prepare/backup/apply/inspect guards.
"""
import time
EXISTING_MAIN='sha256:53fcc6b81e2b68a782fdb58a0fa1a66e5ad3277dfc90fc08fd02cfb70ebfea26'
EXISTING_FALLBACK='sha256:8b3b8a4819cb8d057053174bc8d09396374e3149fc01840bc353095d8c626b85'

def image_anchor(m):
    staged,_=m.package()
    raw=m.safe_read(m.AREA/'image-base.json');base=m.load(m.AREA/'image-base.json')
    ready=m.load(m.AREA/'image-prepared.json')
    m.need(set(base)=={'kind','lease','created','expires','rows','tree','databases','plan','hostStatic','static','policy','price','managed'},'EXACT_IMAGE_ANCHOR_KEYS')
    m.need(base['kind']=='CODE_IMAGE_ONLY_NOT_DATABASE_BASE_OR_APPLY_PERMIT','IMAGE_ANCHOR_KIND')
    m.need(ready=={'imageBaseSha256':m.sha(raw),'stageManifestSha256':staged['manifestSha256'],'helperSha256':staged['helperSha256']},'IMAGE_ANCHOR_PACKAGE_PIN_CHANGED')
    m.need(m.own_lease()==base['lease'],'IMAGE_OWN_LEASE_CHANGED')
    m.need(base['created']<=time.time()<base['expires'],'IMAGE_PREPARATION_EXPIRED')
    return base

def capture(m):
    staged,manifest=m.package();lease=m.own_lease()
    m.need(not any((m.AREA/n).exists()for n in('image-base.json','image-prepared.json','base.json','build-intent.json','apply-intent.json')),'FRESH_IMAGE_PREPARATION_REQUIRED')
    witness=m.history_witness();rows={n:m.inspect_container(n)for n in m.CONTAINERS}
    m.need(all(rows[n]['Image']==manifest['expectedImages'][n]and m.sha(m.enc(m.foreign(rows[n])))==witness['identities'][n]for n in m.CONTAINERS),'IMAGE_PREHISTORY_IDENTITIES_CHANGED')
    tree=m.runtime_tree(rows[m.CONTENT]);m.need(tree==m.image_tree(m.BASE_IMAGE)and m.sha(m.enc(tree))==witness['sourceTreeSha256'],'IMAGE_EXACT_PARENT_TREE_REQUIRED')
    m.need(witness['manifestSha256']==staged['manifestSha256']and witness['images']==manifest['expectedImages'],'IMAGE_PREHISTORY_PACKAGE_CHANGED')
    m.source_review_guard(rows,tree);plan=m.effective_plan(rows,manifest['expectedImages']);m.r7_plan_guard(plan)
    paths=m.database_paths(rows,manifest);hosts=m.module('host_static.py').current(m)
    m.need(hosts==witness['hostBefore'],'IMAGE_HOST_BEFORE_CHANGED')
    managed=m.managed_guard(paths);m.startup_guard(paths,rows,time.time()+m.APPLY_TTL+m.GRACE)
    now=time.time();base={'kind':'CODE_IMAGE_ONLY_NOT_DATABASE_BASE_OR_APPLY_PERMIT','lease':lease,'created':now,'expires':now+1800,'rows':rows,'tree':tree,'databases':paths,'plan':plan,'hostStatic':hosts,'static':m.full_static(),'policy':m.policy_state(),'price':m.price_pin(),'managed':managed}
    m.need(all(m.foreign(m.inspect_container(n))==m.foreign(rows[n])for n in m.CONTAINERS)and m.own_lease()==lease,'IMAGE_CONTAINER_OR_LEASE_CHANGED_DURING_CAPTURE')
    raw=m.enc(base);m.write_new(m.AREA/'image-base.json',raw);m.write_new(m.AREA/'image-prepared.json',m.enc({'imageBaseSha256':m.sha(raw),'stageManifestSha256':staged['manifestSha256'],'helperSha256':staged['helperSha256']}));m.sync_dir(m.AREA)
    print('IMAGE_ANCHOR_ONLY_NO_DATABASE_BASE_OR_INSTALL')

def guard(m):
    staged,manifest=m.package();base=image_anchor(m)
    m.need(not(m.AREA/'base.json').exists()and not(m.AREA/'apply-intent.json').exists(),'IMAGE_BUILD_BEFORE_FINAL_BASE_ONLY')
    rows={n:m.inspect_container(n)for n in m.CONTAINERS}
    m.need(all(m.foreign(rows[n])==m.foreign(base['rows'][n])and rows[n]['Image']==manifest['expectedImages'][n]for n in m.CONTAINERS),'IMAGE_RUNNING_CONTAINERS_CHANGED')
    tree=m.runtime_tree(rows[m.CONTENT]);m.source_review_guard(rows,tree)
    m.need(tree==base['tree']==m.image_tree(m.BASE_IMAGE),'IMAGE_PARENT_RUNTIME_TREE_CHANGED')
    plan=m.effective_plan(rows,manifest['expectedImages']);m.r7_plan_guard(plan);m.need(plan==base['plan'],'IMAGE_EFFECTIVE_PLAN_CHANGED')
    m.need(m.policy_state()==base['policy']and m.full_static()==base['static']and m.price_pin()==base['price'],'IMAGE_POLICY_STATIC_PRICE_CHANGED')
    paths=m.database_paths(rows,manifest);m.need(paths==base['databases'],'IMAGE_DATABASE_PATH_IDENTITY_CHANGED')
    m.need(m.managed_guard(paths)==base['managed']and m.module('host_static.py').current(m)==base['hostStatic'],'IMAGE_MANAGED_OR_HOST_CHANGED')
    m.startup_guard(paths,rows,time.time()+m.APPLY_TTL+m.GRACE)
    m.need(all(m.foreign(m.inspect_container(n))==m.foreign(rows[n])for n in m.CONTAINERS)and m.own_lease()==base['lease'],'IMAGE_CONTAINER_OR_LEASE_CHANGED_DURING_GUARD')
    return staged,manifest,base,rows

def ready(m):
    _,manifest,base,_=guard(m)
    child=m.load(m.AREA/'child.json');m.built_image_guard(base,manifest,child)
    m.need(m.image_tree(child['image'])==m.expected_tree(base,manifest),'PREBUILT_FORWARD_FULL_TREE_CHANGED')
    m.validated_plan(base,child)
    if 'fallback_image.py' in m.REVIEWED_DATA_PINS:
        m.need(m.NAME=='palitra-auth-chat-production-20261031-r5','EXACT_FORWARD_IMAGE_PROTOCOL')
        m.module('fallback_image.py').validate(m)
        m.need(m.load(m.AREA/'reuse-images-accepted.json')==reuse_note(m),'EXACT_EXISTING_IMAGES_ACCEPTANCE_REQUIRED')
    else:
        m.need(m.NAME=='palitra-auth-chat-fallback-20261031-r5','EXACT_REVIEWED_FALLBACK_PROTOCOL')
    return binding(m)

def binding(m):
    staged,_=m.package()
    names=['image-base.json','image-prepared.json','child.json','forward-plan.json']
    if 'fallback_image.py' in m.REVIEWED_DATA_PINS:names.append('fallback-child.json')
    if(m.AREA/'reuse-images-intent.json').exists():names+=['reuse-images-intent.json','reuse-images-accepted.json']
    return {'stageCommit':staged['commit'],'helperSha256':staged['helperSha256'],'manifestSha256':staged['manifestSha256'],'files':{name:m.sha(m.safe_read(m.AREA/name))for name in names}}

def preserve_binding(m,base):
    m.need(base['prebuilt']==binding(m),'FINAL_PREBUILT_IMAGE_BINDING_CHANGED')

def release(m):
    m.need(not any((m.AREA/n).exists()for n in('base.json','prepared.json','release-intent.json','backups','backups.json','apply-intent.json','apply-permit.json')),'FRESH_FINAL_RELEASE_ONLY_INSPECT_OLD_OUTCOME')
    # prepare first checks both prebuilt images, then captures CURRENT databases.
    # No stage/build/refresh/reanchor is performed inside this final window.
    m.prepare()
    m.write_new(m.AREA/'release-intent.json',m.enc({'baseSha256':m.sha(m.safe_read(m.AREA/'base.json')),'at':time.time(),'lease':m.own_lease()}))
    m.base_guard()
    m.backup_databases(m.load(m.AREA/'base.json'))
    m.apply()

def reuse_note(m):
    staged,_=m.package()
    child=m.load(m.AREA/'child.json');fallback=m.load(m.AREA/'fallback-child.json')
    m.need(child['image']==EXISTING_MAIN and child['parent']==m.BASE_IMAGE and fallback['image']==EXISTING_FALLBACK and fallback['parent']==EXISTING_MAIN,'EXACT_REUSED_IMAGE_IDS_REQUIRED')
    return {'kind':'EXACT_EXISTING_IMAGES_VALIDATED_NOT_APPLIED','main':EXISTING_MAIN,'fallback':EXISTING_FALLBACK,'stageCommit':staged['commit'],'helperSha256':staged['helperSha256'],'manifestSha256':staged['manifestSha256'],'imageAnchorSha256':m.sha(m.safe_read(m.AREA/'image-base.json')),'mainReceiptSha256':m.sha(m.safe_read(m.AREA/'child.json')),'fallbackReceiptSha256':m.sha(m.safe_read(m.AREA/'fallback-child.json')),'intentSha256':m.sha(m.safe_read(m.AREA/'reuse-images-intent.json'))}

def attest_existing(m,image,parent,base,manifest,folder):
    # These are fixed content-addressed code images, not an application restart.
    before=m.image_info(parent);after=m.image_info(image)
    m.need(image!=parent and after['Config']==before['Config']and after['RootFS']['Layers'][:-1]==before['RootFS']['Layers']and len(after['RootFS']['Layers'])==len(before['RootFS']['Layers'])+1,'REUSED_IMAGE_PARENT_LAYER_CONFIG_CHANGED')
    m.need(m.image_tree(image)==m.expected_tree(base,manifest),'REUSED_IMAGE_COMPLETE_TREE_CHANGED')
    folder.mkdir(mode=0o700)
    m.run(['docker','image','save','--output',str(folder/'child-image.tar'),image],180)
    # The original strict validator requires EVERY effective file, rejects extras,
    # whiteouts, aliases, nonregular entries and changed ownership/content.
    m.audit_saved_layer(folder/'child-image.tar',base,manifest,after)
    return {'image':image,'parent':parent,'imageConfigSha256':m.sha(m.enc(after['Config'])),'lastDiffId':after['RootFS']['Layers'][-1]}

def reuse_images(m):
    m.need(m.NAME=='palitra-auth-chat-production-20261031-r5','EXACT_REUSE_PROTOCOL_ONLY')
    m.need(not any((m.AREA/n).exists()for n in('reuse-images-intent.json','reuse-images-accepted.json','build','fallback-build','child.json','fallback-child.json','build-intent.json','fallback-build-intent.json','base.json','apply-intent.json')),'FRESH_IMAGE_REUSE_ONLY_INSPECT_OLD_OUTCOME')
    _,manifest,base,_=guard(m)
    m.write_new(m.AREA/'reuse-images-intent.json',m.enc({'main':EXISTING_MAIN,'fallback':EXISTING_FALLBACK,'lease':m.own_lease(),'at':time.time(),'imageAnchorSha256':m.sha(m.safe_read(m.AREA/'image-base.json'))}))
    child=attest_existing(m,EXISTING_MAIN,m.BASE_IMAGE,base,manifest,m.AREA/'build')
    m.write_new(m.AREA/'child.json',m.enc(child));m.make_plan(base,child)
    f=m.module('fallback_image.py');fallback_base,forward=f.parent(m);doc=f.manifest(m)
    m.need(forward['image']==EXISTING_MAIN and [r['target']for r in doc['files']]==['/app/site-orders.js'],'EXACT_ONE_EFFECTIVE_FALLBACK_FILE')
    fallback=attest_existing(m,EXISTING_FALLBACK,EXISTING_MAIN,fallback_base,doc,m.AREA/'fallback-build')
    fallback['manifestSha256']=m.sha(m.enc(doc));m.write_new(m.AREA/'fallback-child.json',m.enc(fallback))
    m.built_image_guard(base,manifest,child);f.validate(m);guard(m)
    m.write_new(m.AREA/'reuse-images-accepted.json',m.enc(reuse_note(m)));m.sync_dir(m.AREA)
    print('EXACT_EXISTING_IMAGES_VALIDATED_NOT_APPLIED')
