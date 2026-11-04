# Garuda backend (API + risk worker). The web app deploys to Vercel separately.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production PORT=3000
CMD ["sh", "scripts/ops/railway-start.sh"]
