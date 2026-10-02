FROM node:24-bookworm-slim

WORKDIR /app
# Explicit source allowlist: no package install, tests, documentation or secrets.
COPY runtime.js bot.js task-source.js ./
RUN mkdir -p /state && chmod 0700 /state

# Root is needed to read the root-owned 0600 token and existing CRM file.
# Compose drops all capabilities and grants no write access to either source.
USER 0:0
CMD ["node", "/app/runtime.js"]
