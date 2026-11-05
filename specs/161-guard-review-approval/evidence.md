# Свидетельства (№163)
Дата: 05.11.2026, Бангкок. Основа: origin/main 91ce4b37.
- `python3 -m unittest discover -s tools/protect-prod-sites -p 'test_*.py'` — 38 тестов OK на 063b2684 (было 26),
  новые: ReviewApprovalTests (метка, ПРИНЯТ текущего head, старый head, раньше push, НЕ ПРИНЯТ, позже НЕ ПРИНЯТ,
  посторонний автор, обычные пути без API, пагинация комментариев, событие issue_comment, workflow).
- `python3 tools/spec-kit/gate.py check` — OK.
- Ревью 923 (НЕ ПРИНЯТ @063b2684): исправлены три обхода. Тесты: 41 OK, в т.ч. test_bypass_a_prefix_collision_requires_full_sha,
  test_bypass_b_quotes_and_instructions_do_not_approve, test_bypass_c_any_later_rejection_closes. PoC ревьюера, адаптированный
  к новой сигнатуре `review_approval(number, head, comments)`: зелёный только точный полный sha, все обходы A/B/C, а также
  «оба вердикта», посторонний автор и поздний отказ — красные.
- Боевая проверка (новый guard на main + реальный PR с «ПРИНЯТ») — не выполнялась: workflow `pull_request_target`
  и `issue_comment` действуют только после слияния в main. Стадия «проверено» — после этого.
- Ревью 934 (НЕ ПРИНЯТ @8bd1100b): отказ теперь ищется во всём нормализованном комментарии. Тесты 42 OK, новый
  test_bypass_d_rejection_anywhere_after_normalization (отказ под заголовком, после пустой строки, soft hyphen,
  zero-width, word joiner, BOM, латинские и fullwidth двойники, разметка, U+2028, Unicode-цифры в номере PR).
  PoC ревьюера poc559b.py на этой ветке: ни одного «НЕОЖИДАННО», зелёные только точное одобрение (3 варианта),
  отказ постороннего, отказ раньше одобрения и «Отклонено» (не вердикт по шаблону).
