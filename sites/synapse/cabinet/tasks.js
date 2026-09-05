(() => {
"use strict";

const SbCabinet = window.SbCabinet = window.SbCabinet || {};
let ctx, byId, escapeHTML, crmQuery, csrfOptions, scopeParams, navigate;
let initialized = false;
const api = {};
const init = (context) => {
  ctx = context;
  ({ byId, escapeHTML, crmQuery, csrfOptions, scopeParams, navigate } = context);
  if (initialized) return;
  initialized = true;

  const TASK_ROLES = Object.freeze({
    owner: "Собственник",
    admin: "Администратор",
    marketer: "Маркетолог",
    synapse: "Synapse"
  });
  const TASK_STATUSES = Object.freeze({
    inbox: "Входящие",
    planned: "Запланировано",
    in_progress: "В работе",
    done: "Сделано",
    cancelled: "Отменено"
  });
  const TASK_PRIORITIES = Object.freeze({
    low: "Низкий",
    normal: "Обычный",
    high: "Высокий",
    urgent: "Срочный"
  });
  const TASK_SOURCES = Object.freeze({ manual: "Вручную", chat: "Чат", telegram: "Telegram" });
  const taskState = { status: "", assigneeRole: "", source: "", q: "", companies: [] };
  const taskOptions = (values, selected = "") => Object.entries(values).map(([value, label]) => {
    return `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`;
  }).join("");
  const taskCompanyName = (code) => {
    if (!code) return "Synapse";
    return taskState.companies.find((company) => company.code === code)?.name || code;
  };
  const loadTaskCompanies = async () => {
    if (taskState.companies.length) return;
    const data = await crmQuery("/companies", { limit: 200, deleted: "exclude" });
    taskState.companies = data.companies || [];
  };
  const taskCompanyOptions = (selected = "") => {
    const options = taskState.companies.map((company) => {
      const value = company.code || "";
      return `<option value="${escapeHTML(value)}"${value === selected ? " selected" : ""}>` +
        `${escapeHTML(company.name || value)}</option>`;
    }).join("");
    return `<option value=""${selected ? "" : " selected"}>Synapse (все проекты)</option>${options}`;
  };
  const loadTasksSummary = async () => {
    try {
      const summary = await crmQuery("/tasks/summary", scopeParams());
      const badge = byId("tasks-badge");
      badge.textContent = summary.inbox || "";
      badge.hidden = !summary.inbox;
      return summary;
    } catch (error) {
      byId("tasks-badge").hidden = true;
      return null;
    }
  };
  const taskStatusTabs = (summary = {}) => {
    const tabs = [
      ["inbox", "Входящие", summary.inbox],
      ["planned", "Запланировано", summary.planned],
      ["in_progress", "В работе", summary.inProgress],
      ["done", "Сделано", summary.done],
      ["", "Все", Object.values(summary).filter(Number.isFinite).reduce((total, value) => total + value, 0)]
    ];
    return tabs.map(([value, label, count]) => `<button type="button" data-task-status-tab="${value}"
      aria-pressed="${String(taskState.status === value)}">${label} · ${count || 0}</button>`).join("");
  };
  const taskDueMarkup = (task) => {
    if (!task.dueDate) return '<span class="crm-muted">—</span>';
    const overdue = !["done", "cancelled"].includes(task.status) &&
      task.dueDate < new Date().toISOString().slice(0, 10);
    return `<span class="${overdue ? "tasks-overdue" : ""}">${escapeHTML(task.dueDate)}</span>`;
  };
  const taskActionsMarkup = (task) => {
    if (task.status === "inbox") {
      return `<div class="tasks-actions"><button type="button" data-task-quick="planned"
        data-task-id="${escapeHTML(task.id)}">Запланировать</button><button class="danger" type="button"
        data-task-quick="cancelled" data-task-id="${escapeHTML(task.id)}">Отклонить</button></div>`;
    }
    return `<select data-task-quick data-task-id="${escapeHTML(task.id)}" aria-label="Изменить статус">
      ${taskOptions(TASK_STATUSES, task.status)}</select>`;
  };
  const renderTaskList = async () => {
    const content = byId("tasks-content");
    content.textContent = "Загрузка…";
    try {
      await loadTaskCompanies();
      const [data, summary] = await Promise.all([
        crmQuery("/tasks", {
          ...scopeParams(),
          status: taskState.status,
          assigneeRole: taskState.assigneeRole,
          source: taskState.source,
          q: taskState.q,
          limit: 100,
          offset: 0
        }),
        loadTasksSummary()
      ]);
      const tasks = data.tasks || [];
      const rows = tasks.map((task) => {
        const source = task.source !== "manual"
          ? `<small>${escapeHTML(task.sourceAuthor || "—")} · ${TASK_SOURCES[task.source] || task.source}</small>`
          : "";
        return `<tr class="crm-row" tabindex="0" data-task-row="${escapeHTML(task.id)}">
          <td class="crm-grow"><span class="tasks-title"><strong>${escapeHTML(task.title)}</strong>${source}</span></td>
          <td class="crm-compact">${escapeHTML(taskCompanyName(task.companyCode))}</td>
          <td class="crm-compact"><span class="tasks-assignee">${TASK_ROLES[task.assigneeRole] || task.assigneeRole}
          ${task.assigneeName ? `<small>${escapeHTML(task.assigneeName)}</small>` : ""}</span></td>
          <td class="crm-compact"><span class="tasks-priority" data-priority="${escapeHTML(task.priority)}">
          ${TASK_PRIORITIES[task.priority] || task.priority}</span></td>
          <td class="crm-compact">${taskDueMarkup(task)}</td>
          <td class="crm-compact">${TASK_STATUSES[task.status] || task.status}</td>
          <td class="crm-compact">${taskActionsMarkup(task)}</td></tr>`;
      }).join("");
      content.innerHTML = `<div class="tasks-status-tabs" aria-label="Статус задачи">
        ${taskStatusTabs(summary || {})}</div><div class="crm-entity-toolbar">
        <select data-task-role-filter aria-label="Роль исполнителя"><option value="">Все исполнители</option>
        ${taskOptions(TASK_ROLES, taskState.assigneeRole)}</select>
        <select data-task-source-filter aria-label="Источник"><option value="">Все источники</option>
        ${taskOptions(TASK_SOURCES, taskState.source)}</select>
        <input type="search" data-task-search value="${escapeHTML(taskState.q)}" placeholder="Поиск"
          aria-label="Поиск задач"><button class="plain-button" type="button" data-task-add>Добавить</button>
        </div><p class="crm-list-count">Показано ${tasks.length} из ${data.pagination?.total ?? tasks.length}</p>
        <div class="crm-table-wrap"><table class="crm-table crm-entity-table"><thead><tr>
        <th class="crm-grow">Задача</th><th>Проект</th><th>Исполнитель</th><th>Приоритет</th><th>Срок</th>
        <th>Статус</th><th>Действия</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${tasks.length ? "" : '<p class="crm-empty">Задач нет</p>'}`;
      bindTaskList();
    } catch (error) {
      content.innerHTML = `<p class="crm-error" role="alert">${escapeHTML(error.message)}</p>`;
    }
  };
  const updateTaskStatus = async (id, status) => {
    await crmQuery(`/tasks/${encodeURIComponent(id)}`, {}, csrfOptions("PATCH", { status }));
    await renderTaskList();
  };
  const bindTaskList = () => {
    const content = byId("tasks-content");
    content.querySelectorAll("[data-task-status-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        taskState.status = button.dataset.taskStatusTab;
        renderTaskList();
      });
    });
    content.querySelector("[data-task-role-filter]").addEventListener("change", (event) => {
      taskState.assigneeRole = event.target.value;
      renderTaskList();
    });
    content.querySelector("[data-task-source-filter]").addEventListener("change", (event) => {
      taskState.source = event.target.value;
      renderTaskList();
    });
    let timer;
    content.querySelector("[data-task-search]").addEventListener("input", (event) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        taskState.q = event.target.value.trim();
        renderTaskList();
      }, 300);
    });
    content.querySelector("[data-task-add]").addEventListener("click", openTaskCreate);
    content.querySelectorAll("[data-task-row]").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (!event.target.closest("button, select")) navigate("tasks/" + row.dataset.taskRow);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter") navigate("tasks/" + row.dataset.taskRow);
      });
    });
    content.querySelectorAll("button[data-task-quick]").forEach((button) => {
      button.addEventListener("click", () => updateTaskStatus(button.dataset.taskId, button.dataset.taskQuick));
    });
    content.querySelectorAll("select[data-task-quick]").forEach((select) => {
      select.addEventListener("change", () => updateTaskStatus(select.dataset.taskId, select.value));
    });
  };
  const taskFormMarkup = (task) => `<form class="crm-form" data-task-form>
    <label class="wide">Название *<input name="title" required maxlength="300"
      value="${escapeHTML(task.title || "")}"></label>
    <label class="wide">Описание<textarea name="description">${escapeHTML(task.description || "")}</textarea></label>
    <label>Проект<select name="companyCode">${taskCompanyOptions(task.companyCode || "")}</select></label>
    <label>Исполнитель<select name="assigneeRole">${taskOptions(TASK_ROLES, task.assigneeRole)}</select></label>
    <label>Имя исполнителя<input name="assigneeName" maxlength="200"
      value="${escapeHTML(task.assigneeName || "")}"></label>
    <label>Приоритет<select name="priority">${taskOptions(TASK_PRIORITIES, task.priority)}</select></label>
    <label>Срок<input name="dueDate" type="date" value="${escapeHTML(task.dueDate || "")}"></label>
    <label>Статус<select name="status">${taskOptions(TASK_STATUSES, task.status)}</select></label>
    <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить</button>
      <button class="danger" type="button" data-task-delete>Удалить</button></div>
    <p class="crm-card-status wide" data-task-result role="status"></p></form>`;
  const taskPayload = (form) => ({
    title: form.elements.title.value.trim(),
    description: form.elements.description.value.trim(),
    companyCode: form.elements.companyCode.value,
    assigneeRole: form.elements.assigneeRole.value,
    assigneeName: form.elements.assigneeName.value.trim(),
    priority: form.elements.priority.value,
    dueDate: form.elements.dueDate.value,
    status: form.elements.status.value
  });
  const renderTaskCard = async (id) => {
    const content = byId("tasks-content");
    content.textContent = "Загрузка…";
    try {
      await loadTaskCompanies();
      const task = await crmQuery(`/tasks/${encodeURIComponent(id)}`);
      const source = task.source !== "manual" ? `<section class="tasks-source"><h3>Откуда</h3>
        <p>${escapeHTML(TASK_SOURCES[task.source] || task.source)} · ${escapeHTML(task.sourceAuthor || "—")}</p>
        <p>${escapeHTML(task.sourceRef || "—")}</p><p>${escapeHTML(task.createdAt || "—")}</p></section>` : "";
      content.innerHTML = `<a class="crm-card-back" href="#tasks" data-task-back>← К списку</a>
        <header class="crm-card-header"><h2>${escapeHTML(task.title)}</h2></header>${source}${taskFormMarkup(task)}`;
      content.querySelector("[data-task-back]").addEventListener("click", (event) => {
        event.preventDefault();
        navigate("tasks");
      });
      const form = content.querySelector("[data-task-form]");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const result = form.querySelector("[data-task-result]");
        try {
          await crmQuery(`/tasks/${encodeURIComponent(task.id)}`, {}, csrfOptions("PATCH", taskPayload(form)));
          result.textContent = "Сохранено";
          await loadTasksSummary();
        } catch (error) {
          result.textContent = error.message;
        }
      });
      form.querySelector("[data-task-delete]").addEventListener("click", async () => {
        if (prompt(`Введите название «${task.title}» для удаления`) !== task.title) return;
        try {
          await crmQuery(`/tasks/${encodeURIComponent(task.id)}`, {}, csrfOptions("DELETE"));
          await loadTasksSummary();
          navigate("tasks");
        } catch (error) {
          form.querySelector("[data-task-result]").textContent = error.message;
        }
      });
    } catch (error) {
      content.innerHTML = `<p class="crm-error" role="alert">${escapeHTML(error.message)}</p>`;
    }
  };
  const renderTasksRoute = () => {
    const parts = decodeURIComponent(location.hash.slice(1)).split(/[/?]/);
    if (parts[1]) renderTaskCard(parts[1]);
    else renderTaskList();
  };
  const openTaskCreate = async () => {
    const dialog = byId("task-create-dialog");
    const form = byId("task-create-form");
    await loadTaskCompanies();
    form.querySelector("[data-task-company]").innerHTML = taskCompanyOptions(
      ctx.selectedProjectId === "synapse-business" ? "" : ctx.selectedProjectId
    );
    form.querySelector("[data-task-role]").innerHTML = taskOptions(TASK_ROLES, "synapse");
    form.querySelector("[data-task-priority]").innerHTML = taskOptions(TASK_PRIORITIES, "normal");
    form.querySelector("[data-task-status]").innerHTML = taskOptions(TASK_STATUSES, "planned");
    form.elements.title.value = "";
    form.elements.description.value = "";
    form.elements.assigneeName.value = "";
    form.elements.dueDate.value = "";
    form.querySelector("[role=alert]").hidden = true;
    dialog.showModal();
  };
  byId("task-create-dialog").querySelector("[data-task-create-close]").addEventListener("click", () => {
    byId("task-create-dialog").close();
  });
  byId("task-create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector("[role=alert]");
    try {
      const created = await crmQuery("/tasks", {}, csrfOptions("POST", {
        ...taskPayload(form),
        source: "manual",
        sourceRef: "",
        sourceAuthor: ""
      }));
      byId("task-create-dialog").close();
      await loadTasksSummary();
      if (created?.id) navigate(`tasks/${created.id}`);
      else renderTaskList();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    }
  });
  Object.assign(api, { renderTasksRoute, loadTasksSummary });
};

SbCabinet.registerView("tasks", {
  title: "Задачи",
  updateSummary(context) {
    init(context);
    api.loadTasksSummary();
  },
  render(container, context) {
    init(context);
    api.renderTasksRoute();
  },
  onProjectChange(context) {
    init(context);
    api.renderTasksRoute();
  },
});
})();
