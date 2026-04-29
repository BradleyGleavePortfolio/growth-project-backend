FROM node:20-slim

RUN apt-get update -qq && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
COPY scripts ./scripts/

RUN npm ci

COPY . .

RUN npx prisma generate

RUN npm run build

EXPOSE 3000

CMD ["node", "dist/main.js"]
