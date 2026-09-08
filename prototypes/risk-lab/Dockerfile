FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prototypes/risk-lab/package.json prototypes/risk-lab/package.json
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @zfy/risk-lab build

ENV NODE_ENV=production
EXPOSE 4173
CMD ["pnpm", "--filter", "@zfy/risk-lab", "start"]
