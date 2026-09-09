# ALVI — Mobile Flow (мобильная версия)

Status: code checks passed; visual mobile QA BLOCKED because managed browser has no viewport/device controls.

Changes: remove nested card scrolling, retain mobile booking bar after intro, add bottom and focus-scroll clearance, restore muted playsinline opening video on compact screens while respecting reduced motion and autoplay refusal. Later scenes keep their matching still frames and transitions. No claim of desktop-equivalent video scrubbing.

Checks: all inline scripts parse; opening-video setup loads media normally, skips it for reduced motion and after scrolling. No service photos, prices or destinations changed.

Before publication: inspect 390px/375px portrait and tablet, long cards, cookie/banner overlap, autoplay rejection and reduced motion.
