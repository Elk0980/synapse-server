#!/bin/bash
# Привязка роликов «Монтажа» Авокадо к идеям плана (reel_materials.idea_id), разрешение Влада 07.11.
# Только UPDATE пустого idea_id у четырёх строк своей компании; перед этим онлайн-бэкап БД CRM.
set -u
docker exec -i synapse-crm-1 node - <<'JS'
const {DatabaseSync, backup} = require('node:sqlite');
(async () => {
  const db = new DatabaseSync('/data/crm.sqlite');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await backup(db, `/data/bk-idealink-${stamp}.sqlite`);
  console.log('BACKUP /data/bk-idealink-' + stamp + '.sqlite');
  const c = db.prepare("SELECT id FROM companies WHERE lower(code)='avokado'").get();
  if (!c) { console.log('STOP no company'); return; }
  const base = 'import-2a058bbdfcc41317505dc4cb5eff62ce-';
  const links = [[6, base + '1'], [14, base + '2'], [8, base + '3'], [9, base + '4']];
  const upd = db.prepare('UPDATE reel_materials SET idea_id=? WHERE id=? AND company_id=? AND idea_id IS NULL');
  for (const [reel, idea] of links) {
    const r = upd.run(idea, reel, c.id);
    const row = db.prepare('SELECT id, idea_id, post_id, title FROM reel_materials WHERE id=?').get(reel);
    console.log('reel', reel, 'changes', r.changes, 'idea', row && row.idea_id, 'post', row && row.post_id);
  }
})().catch(e => console.log('ERR', e.message));
JS
