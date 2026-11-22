FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY scripts/vendor.mjs scripts/vendor.mjs
RUN npm ci --omit=dev
COPY . .
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
# Web server by default; the agent service overrides this with: node src/agent/worker.ts start
CMD ["node", "server.ts"]
