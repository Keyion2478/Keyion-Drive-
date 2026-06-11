FROM node:20-alpine AS base

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npx prisma generate

EXPOSE 4000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
