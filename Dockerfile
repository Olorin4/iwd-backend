# Iron Wing backend (api.iron-wing-dispatching.com) — runs behind the kelevo
# containerized edge on the shared `edge` Docker network. Node 22 + Prisma.
FROM node:22-slim

# Prisma needs OpenSSL at build (engine generation) and runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Generate the Prisma client for this platform.
COPY prisma ./prisma
RUN npx prisma generate

COPY . .

ENV NODE_ENV=production
EXPOSE 3000
# app.js loads env via dotenv-flow; in the container it comes from env_file.
CMD ["node", "src/app.js"]
