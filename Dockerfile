FROM node:20-alpine

RUN apk add --no-cache openssl

EXPOSE 3000
WORKDIR /app

ENV NODE_ENV=production

# postinstall runs `node scripts/prisma-env.mjs generate`, so the schema
# files and the selector script must be in the image BEFORE npm ci.
COPY package.json package-lock.json* ./
COPY prisma ./prisma
COPY scripts ./scripts

# Docker image builds usually cannot see DATABASE_URL, so the schema selector
# defaults to SQLite here. That is fine: `docker-start` re-runs the selector
# at CONTAINER start (npm run setup), when the real DATABASE_URL is present,
# and regenerates the client for Postgres before the server boots. To bake
# the Postgres client into the image instead, build with:
#   docker build --build-arg PRISMA_SCHEMA=prisma/schema.postgres.prisma .
ARG PRISMA_SCHEMA=""
ENV PRISMA_SCHEMA=${PRISMA_SCHEMA}

RUN npm ci --omit=dev && npm cache clean --force
# Remove CLI packages since we don't need them in production by default.
# Remove this line if you want to run CLI commands in your container.
RUN npm remove @shopify/cli

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
