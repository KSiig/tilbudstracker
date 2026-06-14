FROM node:22-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm build

FROM node:22-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist/ dist/
RUN mkdir -p data
CMD ["node", "dist/cli.js", "scrape"]
