'use strict';

const { isAbsolute } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// due_date is a calendar day in the CRM, not an instant. Keep that distinction.
function calendarDay(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'invalid';
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : 'invalid';
}

function coordinationText(field) {
  // Project only the two approved fields, never the complete coordination document.
  return `CASE WHEN json_valid(c.data) THEN
    CASE WHEN json_type(c.data, '$.${field}') = 'text'
      THEN json_extract(c.data, '$.${field}') ELSE '' END ELSE '' END`;
}

/**
 * Privileged, owner-only CRM reader. Its caller must authorize every interaction.
 * No schema creation, migrations, task copies or writes are performed here.
 * waitingForOwner is true for an explicit signal, false for a closed task, or
 * null when no explicit owner-waiting signal exists; a blocker is not such a signal.
 */
function createTaskSource({ dbPath } = {}) {
  if (typeof dbPath !== 'string' || !isAbsolute(dbPath)) {
    throw new TypeError('An absolute CRM database path is required');
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let closed = false;
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
    const hasTable = name => Boolean(db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?"
    ).get(name));
    if (!hasTable('tasks') || !hasTable('companies')) {
      throw new Error('CRM task schema is unavailable');
    }
    const hasCoordination = hasTable('task_coordination');
    const hasDispatch = hasTable('task_dispatch');
    const query = db.prepare(`SELECT t.id, t.title, t.company_code, p.name AS company_name,
      t.status, t.due_date, t.assignee_role,
      ${hasCoordination ? coordinationText('nextAction') : "''"} AS next_action,
      ${hasCoordination ? coordinationText('blocker') : "''"} AS blocker,
      ${hasDispatch ? 'd.state' : 'NULL'} AS dispatch_state
      FROM tasks t
      LEFT JOIN companies p ON p.code = t.company_code COLLATE NOCASE AND p.is_deleted = 0
      ${hasCoordination ? 'LEFT JOIN task_coordination c ON c.task_id = t.id' : ''}
      ${hasDispatch ? `LEFT JOIN task_dispatch d ON d.task_id = t.id
        AND d.company_code = t.company_code COLLATE NOCASE` : ''}
      WHERE t.is_deleted = 0 ORDER BY t.id`);
    return {
      listTasks() {
        if (closed) throw new Error('Task source is closed');
        return query.all().map(row => ({
          id: row.id,
          title: row.title,
          companyCode: row.company_code,
          companyName: row.company_name || row.company_code || 'Без проекта',
          status: row.status,
          dueAt: calendarDay(row.due_date),
          nextAction: row.next_action.trim(),
          blocker: row.blocker.trim(),
          waitingForOwner: ['done', 'cancelled'].includes(row.status) ? false
            : row.assignee_role === 'owner' || ['needs_input', 'review'].includes(row.dispatch_state) ? true : null,
        }));
      },
      close() {
        if (!closed) { db.close(); closed = true; }
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

module.exports = { createTaskSource };
