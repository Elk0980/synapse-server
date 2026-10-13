# Palitra: Main editor compatibility

This package preserves the existing Main runtime and changes only the shared photo
model and four listed static files. The photo model accepts two exact complete
budget-link triples. It preserves the original links, labels and all unrelated
bytes during image changes. No price data, roles, sessions, orders or CRM flags
are changed.

`install.py --check` validates all static BASE and candidate hashes. `--apply
--group static` saves original bytes and installs only the listed files. The
content Dockerfile overlays one model onto the accepted Main image. Root verifies
the running BASE hash before activation and retains the existing checkout flags.

`bot-menu.cjs inspect` reads the existing Palitra bot identity and default menu.
`apply` changes only its menu text and URL, guarded by the exact previous values,
then reads the result. Run inside the existing chat container; the token stays in
process memory and is never printed. It does not alter polling, webhooks,
operator bindings or permissions, and sends no chat messages. An unknown write
outcome requires a read before any retry.
