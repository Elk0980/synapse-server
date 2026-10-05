FROM node:24-bookworm-slim

WORKDIR /app
# Explicit source allowlist: no package install, tests, documentation or secrets.
COPY runtime.js bot.js socket-source.js ./
RUN mkdir -p /state && chmod 0700 /state

# Root is needed for the root-owned 0600 token and task-only Unix socket.
# The image has no database adapter; Compose does not mount any CRM data volume.
# Compose drops all capabilities and mounts the socket directory read-only.
USER 0:0
CMD ["node", "/app/runtime.js"]
