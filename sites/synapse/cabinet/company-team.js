(() => {
  'use strict';
  const sb=window.SbCabinet=window.SbCabinet||{};
  const names={administrator:'Администратор',master:'Мастер'};
  let sequence=0;
  async function render(container,ctx) {
    const turn=++sequence,code=ctx.selectedProjectId,esc=ctx.escapeHTML;
    if(!code || !(ctx.identity?.role==='owner'||ctx.identity?.permissions?.includes('team.manage'))) {
      container.textContent='Выберите доступную компанию. Добавление сотрудников доступно её руководителю.';return;
    }
    container.innerHTML=`<h1>Моя команда</h1><div class="card"><h2>Добавить сотрудника</h2>
      <p>Доступ будет только к выбранной компании. Сотрудник не сможет создавать аккаунты или менять права.</p>
      <form data-team-form><label class="field-stack">Имя<input name="displayName" required maxlength="120" autocomplete="off"></label>
      <label class="field-stack">Роль<select name="staffRole"><option value="master">Мастер</option><option value="administrator">Администратор</option></select></label>
      <p>Мастер: своя анкета и просмотр контента. Администратор: также работа с заявками и материалами компании.</p>
      <label class="field-stack">Логин<input name="login" required pattern="[a-z0-9_-]{1,64}" autocomplete="off"></label>
      <label class="field-stack">Пароль<input name="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password"></label>
      <label class="field-stack">Повторите пароль<input name="confirmation" type="password" required minlength="12" autocomplete="new-password"></label>
      <button type="submit">Добавить сотрудника</button><p role="status" data-team-status></p></form></div>
      <div class="card"><h2>Сотрудники</h2><div data-team-list>Загрузка…</div></div>`;
    const form=container.querySelector('[data-team-form]'),status=container.querySelector('[data-team-status]'),list=container.querySelector('[data-team-list]');
    async function refresh() {
      try {
        const result=await ctx.apiJson('/content/admin/team?companyCode='+encodeURIComponent(code));
        if(turn!==sequence)return;
        list.innerHTML=result.members.length?result.members.map(m=>`<p><strong>${esc(m.displayName)}</strong> · ${esc(names[m.staffRole]||m.staffRole)} · ${esc(m.login)}</p>`).join(''):'Пока нет добавленных сотрудников.';
      }catch(error){if(turn===sequence)list.textContent='Не удалось загрузить: '+error.message;}
    }
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if(turn!==sequence||code!==ctx.selectedProjectId)return;
      if(form.elements.password.value!==form.elements.confirmation.value){status.textContent='Пароли не совпадают';return;}
      const button=form.querySelector('button');if(button.disabled)return;button.disabled=true;
      try {
        await ctx.apiJson('/content/admin/team',{method:'POST',headers:{'X-CSRF-Token':ctx.identity.csrfToken},body:JSON.stringify({companyCode:code,staffRole:form.elements.staffRole.value,displayName:form.elements.displayName.value,login:form.elements.login.value,password:form.elements.password.value})});
        if(turn!==sequence)return;
        form.reset();status.textContent='Сотрудник добавлен. Передайте ему логин и пароль лично.';await refresh();
      }catch(error){if(turn===sequence)status.textContent=error.message;}
      finally{form.elements.password.value='';form.elements.confirmation.value='';button.disabled=false;}
    });
    await refresh();
  }
  sb.registerView('company-team',{title:'Моя команда',render,onProjectChange(ctx){const c=ctx.byId('company-team-view');if(c&&!c.hidden)void render(c,ctx);}});
})();
