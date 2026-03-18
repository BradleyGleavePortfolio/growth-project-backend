#!/bin/sh
set -e
echo "=== The Growth Project Backend Starting ==="
echo "Running database migrations..."
npx prisma migrate deploy
echo "Migrations complete."
echo "Starting NestJS app on port $PORT..."
node dist/main
