set -Eeuo pipefail
NAMES=$'@nestjs/core\n@prisma/client\neslint\nprisma\ntypescript'
miss=0
for i in $(seq 1 3000); do
  if printf '%s\n' "$NAMES" | grep -qxF eslint; then :; else miss=$((miss+1)); fi
done
echo "missed=$miss of 3000"
