FROM node:20-alpine

RUN apk add --no-cache openssl

EXPOSE 3000
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force
# Remove CLI packages since we don't need them in production by default.
# Remove this line if you want to run CLI commands in your container.
RUN npm remove @shopify/cli

COPY . .

# Regenerate the Prisma Client against the production (Postgres) schema at
# build time too — not just at container boot via docker-start's
# setup:production. Belt and suspenders: if a host ever serves a cached
# image/layer without re-running CMD's generate step, the client baked into
# this image is still current with schema.production.prisma's models.
RUN npx prisma generate --schema=./prisma/schema.production.prisma

RUN npm run build

CMD ["npm", "run", "docker-start"]
