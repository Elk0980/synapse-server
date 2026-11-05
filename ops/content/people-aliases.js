'use strict';
// Имена, по которым доска может назначить задачу человеку («Лена», «Влад»).
// Засчитываются только однозначные в выбранной компании: тёзки не видят задачи друг друга.
// Имя владельца (и «Влад», как владелец назван в task-principal CRM) — только владельцу.
const norm=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim();
function candidates(user) {
  const names=new Set(),add=value=>{const n=norm(value);if(n.length>=2&&!/^#\d+$/.test(n)&&!n.startsWith('person:'))names.add(n);};
  add(user.displayName);add(user.login);
  const words=norm(user.displayName).split(' ');
  if(words.length>1)add(words[0]);
  if(user.role==='owner')add('Влад');
  return names;
}
function personAliases(users,user,companyCode) {
  if(!Array.isArray(users)||!user)return [];
  const inCompany=users.filter(u=>u&&Number.isSafeInteger(u.id)&&(u.role==='owner'||Array.isArray(u.companyCodes)&&u.companyCodes.includes(companyCode)));
  if(!inCompany.some(u=>u.id===user.id))return [];
  const owner=user.role==='owner',ownerNames=new Set(),count=new Map();
  for(const u of inCompany) {
    const own=candidates(u);
    if(u.role==='owner')own.forEach(n=>ownerNames.add(n));
    if((u.role==='owner')===owner)own.forEach(n=>count.set(n,(count.get(n)||0)+1));
  }
  return [...candidates(user)].filter(n=>count.get(n)===1&&(owner||!ownerNames.has(n))).slice(0,6).map(n=>n.slice(0,120));
}
module.exports={personAliases,norm};
