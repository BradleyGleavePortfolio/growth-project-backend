FROM node:20-slim

RUN apt-get update -qq && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

RUN npx prisma generate

RUN npm run build

COPY start.sh ./
RUN chmod +x start.sh

EXPOSE 3000

CMD ["sh", "start.sh"]
