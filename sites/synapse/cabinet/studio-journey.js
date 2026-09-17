(() => {
'use strict';
const cabinet=window.SbCabinet=window.SbCabinet||{};
const labels={new:'Новая заявка',booked:'Записан',confirmed:'Подтвердил визит',visited:'Пришёл',no_show:'Не пришёл',rescheduled:'Перенос',cancelled:'Отменил запись',membership:'Купил абонемент'};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const editable=ctx=>ctx.identity?.role==='owner'||ctx.identity?.permissions?.includes('crm.edit');
const date=(value,zone)=>value?new Intl.DateTimeFormat('ru-RU',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'—';
const request=(ctx,code,path,method,body)=>ctx.crmQuery('/studio-journey'+path,{companyCode:code},method?ctx.csrfOptions(method,body):undefined);
const companyName=(ctx,code)=>ctx.identity?.companies?.find(c=>c.id===code)?.name||code;
const summaryEpochs=new WeakMap();
async function mountSummary(node,ctx,{period='today',source='',range=null}={}){
  const code=ctx.scopeParams().companyCode;
  const epoch=(summaryEpochs.get(node)||0)+1;summaryEpochs.set(node,epoch);
  node.innerHTML='<p>Загружаем путь клиента…</p>';
  try{
    const now=new Date(),from=range?.from||new Date(now.getTime()-(period==='7d'?7:period==='30d'?30:1)*86400000).toISOString(),to=range?.to||now.toISOString();
    const result=await ctx.crmQuery('/studio-journey',{companyCode:code,from,to,source});
    if(!node.isConnected||ctx.scopeParams().companyCode!==code||summaryEpochs.get(node)!==epoch)return;
    const s=result.summary;
    node.innerHTML=`<h2>Путь клиента · ${esc(companyName(ctx,code))}</h2><p class="journey-note">Заявки с ${esc(date(from,result.timezone))} по ${esc(date(to,result.timezone))} (${esc(result.timezone)}). Этапы по отметкам в карточках, независимо от фильтра старого этапа.</p>
      <div class="journey-metrics">${[['Заявки',s.leads],['Записаны',s.booked],['Подтвердили',s.confirmed],['Пришли',s.visited],['Купили абонемент',s.memberships]].map(([name,value])=>`<div><span>${name}</span><strong>${esc(value)}</strong></div>`).join('')}</div>
      <p>Неявок: <strong>${esc(s.noShows)}</strong> · Переносов: <strong>${esc(s.reschedules)}</strong> · Доля неявок: <strong>${s.noShowRate===null?'—':esc(s.noShowRate)+'%'}</strong></p>
      <details><summary>Сравнить источники и понять цифры</summary><p class="journey-note">Доля неявок = неявки / (состоявшиеся визиты + неявки). Будущие записи и отмены исключены. Каждая заявка считается один раз на этапе; повторные визиты и переносы считаются событиями. Старый статус «Продажа» не означает покупку абонемента.</p>
      <div class="journey-table"><table><thead><tr><th>Источник</th><th>Заявки</th><th>Пришли</th><th>Абонемент</th><th>Неявки</th></tr></thead><tbody>${result.sources.map(row=>`<tr><th>${esc(row.source)}</th><td>${row.leads}</td><td>${row.visited}</td><td>${row.memberships}</td><td>${row.noShows}</td></tr>`).join('')||'<tr><td colspan="5">Нет отметок за период</td></tr>'}</tbody></table></div></details>
      <p class="journey-note">Откройте имя клиента в списке ниже, чтобы назначить визит и отметить результат.</p>`;
  }catch(error){if(node.isConnected&&ctx.scopeParams().companyCode===code&&summaryEpochs.get(node)===epoch)node.textContent='Путь клиента не удалось загрузить. '+error.message;}
}
async function mountCard(node,ctx,leadId,{onChange=()=>{}}={}){
  const code=ctx.scopeParams().companyCode;let saved=null,version=0,busy=false;
  const alive=()=>node.isConnected&&ctx.scopeParams().companyCode===code;
  const status=message=>{const el=node.querySelector('[data-journey-status]');if(el)el.textContent=message;};
  const call=(path,method,body)=>request(ctx,code,'/'+encodeURIComponent(leadId)+path,method,body);
  const draw=()=>{
    const zone=saved.timezone,state=saved.state,canEdit=editable(ctx),last=saved.events.filter(e=>!e.voidedAt).at(-1);
    const options=({new:['booked'],booked:['confirmed','visited','no_show','rescheduled','cancelled'],rescheduled:['confirmed','visited','no_show','rescheduled','cancelled'],confirmed:['visited','no_show','rescheduled','cancelled'],visited:['membership','booked'],membership:['booked'],no_show:['rescheduled','booked'],cancelled:['booked']})[state.status]||[];
    node.innerHTML=`<h3>Визит и абонемент</h3><p><strong>${esc(labels[state.status])}</strong>${state.appointmentAt?' · '+esc(date(state.appointmentAt,zone)):''}</p><p class="journey-note">Часовой пояс: ${esc(zone)}. Отметки сохраняются отдельно от старого этапа заявки.</p>
      ${canEdit?`<form data-journey-form><div class="journey-fields"><label>Что произошло<select name="type">${options.map(t=>`<option value="${t}">${esc(labels[t])}</option>`).join('')}</select></label>
      <label data-appointment>Дата и время визита<input name="appointmentAt" type="datetime-local"></label><label>Когда произошло<input name="occurredAt" type="datetime-local" value="${esc(cabinet.companyTime.toLocal(new Date().toISOString(),zone))}" required></label>
      <label data-membership hidden>Название абонемента<input name="membershipName" maxlength="200"></label><label data-membership hidden>Фактически оплачено, ₽<input name="amount" type="number" min="0.01" step="0.01"></label><label data-membership hidden>Номер чека или основание оплаты<input name="evidence" maxlength="1000"></label>
      <label class="journey-wide">Комментарий / причина<textarea name="note" maxlength="2000" rows="2"></textarea></label></div><p data-membership class="journey-note" hidden>Это отметка администратора с основанием оплаты. Проверка чека и финансовый учёт выполняются отдельно.</p><button class="plain-button" type="submit">Сохранить отметку</button></form>`:''}
      <p data-journey-status role="status"></p><details><summary>История и исправление отметок (${saved.events.length})</summary><ol class="journey-history">${saved.events.map(e=>`<li${e.voidedAt?' class="journey-void"':''}><strong>${esc(labels[e.type])}</strong> · ${esc(date(e.occurredAt,e.timezone))}${e.appointmentAt?`<br>Визит: ${esc(date(e.appointmentAt,e.timezone))}`:''}${e.membershipName?`<br>${esc(e.membershipName)} · ${esc((e.amountCents/100).toLocaleString('ru-RU'))} ₽ · ${esc(e.evidence)}`:''}${e.note?'<br>'+esc(e.note):''}${e.voidedAt?'<br>Отменено: '+esc(e.voidReason):''}</li>`).join('')||'<li>Отметок пока нет</li>'}</ol>
      ${canEdit&&last?`<form data-journey-undo><label>Причина исправления<input name="reason" maxlength="2000" required></label><button class="plain-button" type="submit">Отменить последнюю отметку</button></form>`:''}</details>
      <details><summary>Черновики напоминаний</summary><p class="journey-note">Тексты не отправляются автоматически. Перед отправкой проверьте запись, контакт и согласованный канал связи.</p><label>Текст для клиента<textarea data-reminder rows="5" readonly></textarea></label><div class="journey-actions"><button type="button" class="plain-button" data-draft="confirm">Подтверждение записи</button><button type="button" class="plain-button" data-draft="remind">Напомнить о визите</button><button type="button" class="plain-button" data-draft="reschedule">Предложить перенос</button></div></details>`;
    const form=node.querySelector('[data-journey-form]');
    if(form){const toggle=()=>{const type=form.elements.type.value;node.querySelectorAll('[data-membership]').forEach(el=>el.hidden=type!=='membership');const booking=['booked','rescheduled'].includes(type);form.querySelector('[data-appointment]').hidden=!booking;form.elements.appointmentAt.required=booking;for(const name of ['membershipName','amount','evidence'])form.elements[name].required=type==='membership';form.elements.note.required=['rescheduled','no_show','cancelled'].includes(type);};form.elements.type.addEventListener('change',toggle);toggle();
      const defaultOccurred=form.elements.occurredAt.value;
      form.addEventListener('submit',async event=>{event.preventDefault();if(busy||!alive()||!form.reportValidity())return;const values=new FormData(form),type=values.get('type');
        try{const body={revision:saved.revision,requestId:window.crypto.randomUUID(),type,timezone:zone,note:values.get('note')};
          if(values.get('occurredAt')!==defaultOccurred)body.occurredAt=cabinet.companyTime.toUTC(values.get('occurredAt'),zone);
          if(['booked','rescheduled'].includes(type))body.appointmentAt=cabinet.companyTime.toUTC(values.get('appointmentAt'),zone);
          if(type==='membership')Object.assign(body,{membershipName:values.get('membershipName'),amount:Number(values.get('amount')),evidence:values.get('evidence')});
          await mutate('/events','POST',body);
        }catch(error){status(error.message);}});
    }
    node.querySelector('[data-journey-undo]')?.addEventListener('submit',async event=>{event.preventDefault();if(busy||!alive()||!event.target.reportValidity())return;await mutate('/events/'+last.id,'DELETE',{revision:saved.revision,reason:new FormData(event.target).get('reason')});});
    node.querySelectorAll('[data-draft]').forEach(button=>button.addEventListener('click',()=>{
      const time=state.appointmentAt?date(state.appointmentAt,zone):'[дата и время]',company=companyName(ctx,code),name=saved.name||'';
      node.querySelector('[data-reminder]').value=button.dataset.draft==='confirm'?`${name}, здравствуйте! Вы записаны в ${company} на ${time}. Подтвердите, пожалуйста, сможете ли прийти. Если время не подходит, подберём другое.`:button.dataset.draft==='remind'?`${name}, здравствуйте! Напоминаем о записи в ${company}: ${time}. Ждём вас. Если планы изменились, сообщите — поможем перенести визит.`:`${name}, здравствуйте! Хотите подобрать другое время визита в ${company}? Напишите, какие дни и время вам удобны.`;
    }));
  };
  async function mutate(path,method,body){busy=true;node.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=true);status('Сохраняем…');
    try{const result=await call(path,method,body);if(!alive())return;saved=result;draw();status('Отметка сохранена');onChange();}catch(error){if(alive()){status(error.message);node.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=false);}}finally{busy=false;}}
  node.innerHTML='<p>Загружаем историю визита…</p>';
  try{const token=++version,result=await call('');if(!alive()||token!==version)return;saved=result;draw();}catch(error){if(alive())node.textContent='История визита не загрузилась. '+error.message;}
}
cabinet.studioJourney={mountSummary,mountCard};
})();
