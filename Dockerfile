# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean
COPY --from=builder /app/dist ./dist
# Durcissement : ne pas exécuter le process Node en root (cohérent avec le front).
RUN addgroup -S nodejs && adduser -S nestjs -G nodejs && chown -R nestjs:nodejs /app
USER nestjs
EXPOSE 4000
ENV PORT=4000
CMD ["node", "dist/main.js"]
