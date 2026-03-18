FROM node:20-slim

RUN apt-get update -qq && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and prisma schema
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies
RUN npm ci

# Copy source BEFORE generating prisma (so generate uses final node_modules path)
COPY . .

# Generate Prisma client AFTER all files are in place
RUN npx prisma generate

# Build NestJS
RUN npm run build

# Expose port
EXPOSE 3000

# Start production server
CMD ["node", "dist/main"]
