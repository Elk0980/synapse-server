(() => {
  'use strict';
  const STAGES = ['code','connected','verified','accepted'];
  const STAGE_LABELS = {code:'код',connected:'подключение',verified:'проверка',accepted:'приёмка Владом'};
  const normalized = value => String(value || '').trim().replace(/ё/g,'е').replace(/Ё/g,'Е').toLocaleLowerCase('ru-RU');
  const waitPrefix = /^(?:ждет\s+влада|вопрос\s*→\s*влад)(?![\p{L}\p{N}_])/u;
  const waitingField = value => waitPrefix.test(normalized(value));
  const isWaiting = task => waitingField(task.coordination?.blocker) || waitingField(task.coordination?.nextAction) || normalized(task.assignee_name) === 'влад';
  const waitingNeed = task => {
    const coord = task.coordination || {};
    const value = waitingField(coord.blocker) ? coord.blocker : waitingField(coord.nextAction) ? coord.nextAction : coord.nextAction || task.title;
    return String(value || '').trim().replace(/^(?:жд[её]т\s+влада|вопрос\s*→\s*влад)\s*[:—–-]?\s*/i,'').trim() || task.title;
  };
  const progress = task => STAGES.filter(stage => task.coordination?.milestones?.[stage]?.state === 'confirmed').length * 25;
  const stageText = task => {
    const next = STAGES.find(stage => task.coordination?.milestones?.[stage]?.state !== 'confirmed');
    return next ? STAGE_LABELS[next] : 'принято Владом';
  };
  const descriptionField = (task,label) => {
    const match = String(task.description || '').match(new RegExp(`(?:^|\\n)\\s*${label}\\s*:\\s*([^\\n]*)`,'i'));
    return match?.[1]?.trim() || '';
  };
  const referencedIds = task => [...descriptionField(task,'Состав').matchAll(/№\s*(\d+)/g)].map(match => Number(match[1]));
  const title = task => String(task.title || '').replace(/^\s*(?:Цель|Направление)\s*·\s*/i,'').trim();
  const mean = members => members.length ? Math.round(members.reduce((sum,task) => sum+progress(task),0)/members.length) : 0;
  const taskOrder = (a,b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.id-b.id;
  function build(records) {
    const tasks = records.filter(task => Number.isSafeInteger(task.id) && task.id > 0 && !task.product_placeholder && !task.is_deleted);
    const byId = new Map(tasks.map(task => [task.id,task]));
    const goals = tasks.filter(task => /^\s*Цель\s*·\s*/i.test(task.title || '')).sort(taskOrder);
    const goalIds = new Set(goals.map(task => task.id));
    const children = task => tasks.filter(item => item.parent_task_id === task.id && item.company_code === task.company_code);
    const directions = tasks.filter(task => {
      const parent = byId.get(task.parent_task_id);
      return parent && goalIds.has(parent.id) && parent.company_code === task.company_code &&
        /(?:^|\n)\s*(?:ЦКП|Состав)\s*:/i.test(task.description || '');
    }).sort(taskOrder);
    const structural = new Set([...goalIds,...directions.map(task => task.id)]);
    const descendants = (seeds,company) => {
      const result = new Map(), visited = new Set();
      const visit = task => {
        if (!task || task.company_code !== company || visited.has(task.id) || structural.has(task.id)) return;
        visited.add(task.id);result.set(task.id,task);
        children(task).forEach(visit);
      };
      seeds.forEach(visit); return [...result.values()].sort(taskOrder);
    };
    const plannedDirections = directions.map(task => {
      const seeds = [...children(task),...referencedIds(task).map(id => byId.get(id))];
      const members = [...new Map(seeds.filter(item => item && item.company_code === task.company_code && !structural.has(item.id)).map(item => [item.id,item])).values()].sort(taskOrder);
      const allMembers = descendants(members,task.company_code);
      return {task,title:title(task),why:descriptionField(task,'ЦКП'),members,allMembers,progress:mean(members),
        started:task.status === 'in_progress' || allMembers.some(item => item.status === 'in_progress' || progress(item)>0),
        current:allMembers.filter(item => item.status === 'in_progress').sort(taskOrder)};
    });
    const goalModels = goals.map(task => {
      const branches = plannedDirections.filter(direction => direction.task.parent_task_id === task.id);
      const members = new Map();
      for (const branch of branches) for (const member of branch.members) members.set(member.id,member);
      return {task,title:title(task),directions:branches,members:[...members.values()],progress:mean([...members.values()]),
        current:branches.filter(direction => direction.started && direction.progress<100),next:branches.filter(direction => !direction.started)};
    });
    const now = tasks.filter(task => !structural.has(task.id) && task.status === 'in_progress').sort(taskOrder).map(task => ({task,
      directions:plannedDirections.filter(direction => direction.allMembers.some(member => member.id === task.id)),progress:progress(task),stage:stageText(task)}));
    return {goals:goalModels,directions:plannedDirections,now,waiting:tasks.filter(isWaiting).sort((a,b) => String(a.waiting_since || '9999').localeCompare(String(b.waiting_since || '9999')) || a.id-b.id)};
  }
  window.SbTaskOverview = Object.freeze({build,isWaiting,waitingNeed,hasWaitingBlocker:task=>waitingField(task.coordination?.blocker),progress,stageText,title,descriptionField});
})();
