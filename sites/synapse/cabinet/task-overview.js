(() => {
  'use strict';
  const STAGES = ['code','connected','verified','accepted'];
  const STAGE_LABELS = {code:'код',connected:'подключение',verified:'проверка',accepted:'приёмка Владом'};
  const normalized = value => String(value || '').trim().replace(/ё/g,'е').replace(/Ё/g,'Е').toLocaleLowerCase('ru-RU');
  const waitPrefix = /^(?:ждет\s+влада|вопрос\s*→\s*влад)(?![\p{L}\p{N}_])/u;
  const waitingField = value => waitPrefix.test(normalized(value));
  const stripWaitingPrefix = value => String(value || '').replace(/^\s*(?:жд[её]т\s+влада|вопрос\s*→\s*влад)(?![\p{L}\p{N}_])(?:[^\S\r\n]*[:—–-])?[^\S\r\n]*/iu,'');
  const isWaiting = task => waitingField(task.coordination?.blocker) || waitingField(task.coordination?.nextAction) || normalized(task.assignee_name) === 'влад';
  const waitingNeed = task => {
    const coord = task.coordination || {};
    const value = waitingField(coord.blocker) ? coord.blocker : waitingField(coord.nextAction) ? coord.nextAction : coord.nextAction || title(task);
    return String(value || '').trim().replace(/^(?:жд[её]т\s+влада|вопрос\s*→\s*влад)\s*[:—–-]?\s*/i,'').trim() || title(task);
  };
  const progress = task => task.status === 'done' ? 100 : STAGES.filter(stage => task.coordination?.milestones?.[stage]?.state === 'confirmed').length * 25;
  const stageText = task => {
    if (task.status === 'done') return 'готово';
    const next = STAGES.find(stage => task.coordination?.milestones?.[stage]?.state !== 'confirmed');
    return next ? STAGE_LABELS[next] : 'принято Владом';
  };
  const descriptionField = (task,label) => {
    const match = String(task.description || '').match(new RegExp(`(?:^|\\n)[^\\S\\r\\n]*${label}[^\\S\\r\\n]*:[^\\S\\r\\n]*([^\\r\\n]*)`,'i'));
    return match?.[1]?.trim() || '';
  };
  const referencedIds = task => [...descriptionField(task,'Состав').matchAll(/№\s*(\d+)/g)].map(match => Number(match[1]));
  const moduleIds = task => [...String(task.description || '').matchAll(/^[^\S\r\n]*Модуль[^\S\r\n]+№[^\S\r\n]*(\d+)[^\S\r\n]*$/gim)].map(match => Number(match[1]));
  const title = task => String(task.title || '').replace(/^\s*(?:Цель|Модуль|Направление)\s*·\s*/i,'').trim();
  const mean = members => members.length ? Math.round(members.reduce((sum,task) => sum+progress(task),0)/members.length) : 0;
  const taskOrder = (a,b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.id-b.id;
  function build(records) {
    // Скрытые записи остаются в графе: активный потомок отменённого родителя
    // сохраняет принадлежность модулю, но сам родитель не входит в проценты.
    const rawTasks = records.filter(task => Number.isSafeInteger(task.id) && task.id > 0 && !task.product_placeholder && !task.is_deleted);
    const tasks = rawTasks.filter(task => task.status !== 'cancelled');
    const byId = new Map(rawTasks.map(task => [task.id,task]));
    const rawGoals = rawTasks.filter(task => /^\s*Цель\s*·\s*/i.test(task.title || ''));
    const goals = rawGoals.filter(task => task.status !== 'cancelled').sort(taskOrder);
    const goalIds = new Set(rawGoals.map(task => task.id));
    const children = task => rawTasks.filter(item => item.parent_task_id === task.id && item.company_code === task.company_code);
    const rawModules = rawTasks.filter(task => {
      if (/^\s*(?:Модуль|Направление)\s*·\s*/i.test(task.title || '')) return true;
      const parent = byId.get(task.parent_task_id);
      return parent && goalIds.has(parent.id) && parent.company_code === task.company_code &&
        /(?:^|\n)\s*(?:ЦКП|Состав)\s*:/i.test(task.description || '');
    }).sort(taskOrder);
    const structural = new Set([...goalIds,...rawModules.map(task => task.id)]);
    const moduleMembers = new Map();
    for (const item of rawTasks) for (const moduleId of moduleIds(item)) {
      if (!moduleMembers.has(moduleId)) moduleMembers.set(moduleId,[]);
      moduleMembers.get(moduleId).push(item);
    }
    const descendants = (seeds,company) => {
      const result = new Map(), visited = new Set();
      const visit = task => {
        if (!task || task.company_code !== company || visited.has(task.id) || structural.has(task.id)) return;
        visited.add(task.id);if (task.status !== 'cancelled') result.set(task.id,task);
        children(task).forEach(visit);
      };
      seeds.forEach(visit); return [...result.values()].sort(taskOrder);
    };
    const modules = rawModules.filter(task => task.status !== 'cancelled').map(task => {
      const seeds = [...children(task),...referencedIds(task).map(id => byId.get(id)),...(moduleMembers.get(task.id) || [])];
      const members = [...new Map(seeds.filter(item => item && item.status !== 'cancelled' && item.company_code === task.company_code && !structural.has(item.id)).map(item => [item.id,item])).values()].sort(taskOrder);
      const allMembers = descendants(seeds,task.company_code);
      return {task,title:title(task),why:descriptionField(task,'ЦКП'),members,allMembers,progress:mean(members),
        started:task.status === 'in_progress' || allMembers.some(item => item.status === 'in_progress' || progress(item)>0),
        current:allMembers.filter(item => item.status === 'in_progress').sort(taskOrder)};
    });
    const goalModels = goals.map(task => {
      const branches = modules.filter(module => module.task.parent_task_id === task.id && module.task.company_code === task.company_code);
      const members = new Map();
      for (const branch of branches) for (const member of branch.members) members.set(member.id,member);
      return {task,title:title(task),modules:branches,directions:branches,members:[...members.values()],progress:branches.length ? Math.round(branches.reduce((sum,module) => sum+module.progress,0)/branches.length) : 0,
        current:branches.filter(direction => direction.started && direction.progress<100),next:branches.filter(direction => !direction.started)};
    });
    const now = tasks.filter(task => !structural.has(task.id) && task.status === 'in_progress').sort(taskOrder).map(task => {
      const membership = modules.filter(module => module.allMembers.some(member => member.id === task.id));
      return {task,modules:membership,directions:membership,progress:progress(task),stage:stageText(task)};
    });
    return {goals:goalModels,modules,directions:modules,structuralIds:[...structural],now,waiting:tasks.filter(isWaiting).sort((a,b) => String(a.waiting_since || '9999').localeCompare(String(b.waiting_since || '9999')) || a.id-b.id)};
  }
  window.SbTaskOverview = Object.freeze({build,isWaiting,waitingNeed,hasWaitingBlocker:task=>waitingField(task.coordination?.blocker),hasWaitingNextStep:task=>waitingField(task.coordination?.nextAction),stripWaitingPrefix,progress,stageText,title,descriptionField});
})();
