FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js documents.js tools.js seed.js ./
RUN chmod 0755 /app && chmod 0644 /app/*.js /app/package*.json
USER node
EXPOSE 8080
CMD ["node", "server.js"]
