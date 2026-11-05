# План (№163)
Владелец: claude-guard161. Разрешённые файлы: `tools/protect-prod-sites/guard.py`, `test_guard.py`,
`.github/workflows/protect-prod-sites.yml`, `docs/production-sites/PLAN.md`, `MAIN_PROTECTION.md`, эта папка.
- guard.py: `comment_verdict()`, `review_approval()`, `fetch_review()` (только комментарии, без даты коммита), `evaluate(..., load_review=)` — комментарии читаются
  лениво, только если меток не хватает; `main()` принимает событие `issue_comment` и берёт head из API.
- workflow: `issue_comment`, `issues: read`, checkout `base.sha || github.sha` (main), фильтр «ПРИНЯТ».
- Проверки: unittest guard, `python tools/spec-kit/gate.py check`, CI PR.
