# Iron Wing backend (api.iron-wing-dispatching.com) — runs behind the kelevo
# containerized edge on the shared `edge` Docker network. Node 22 + Prisma.
FROM node:22-slim

# Prisma needs OpenSSL at build (engine generation) and runtime.
# TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production dependencies only (no jest/babel/eslint/webpack). The Prisma CLI
# is a regular dependency because the CMD runs `prisma migrate deploy`.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Generate the Prisma client for this platform (Prisma 7 reads prisma.config.js).
COPY prisma.config.js ./
COPY prisma ./prisma
RUN npx prisma generate

COPY . .

ENV NODE_ENV=production
EXPOSE 3000
# app.js loads env via dotenv-flow; in the container it comes from env_file.
# Apply pending DB migrations (idempotent) before starting the server, so a
# `docker compose up` is a complete deploy — no host-side prisma/node needed.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node src/app.js"]
