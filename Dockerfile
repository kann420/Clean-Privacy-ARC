FROM node:22-alpine

WORKDIR /app

# This builds the backend, and it lives at the repository root on purpose. The
# backend imports scripts/lib/*.mjs and reads config/chains.json through
# ROOT_URL, so its build context has to be the repository root. It cannot move
# to /backend and be selected through a root railway.json either, because a
# root config file applies to every service in the repository and would force
# the web service to build this image against its own /web context.
# The web service keeps its own web/Dockerfile, which each service finds by
# auto-detection inside its configured root directory.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY config ./config
COPY scripts/lib ./scripts/lib
COPY backend ./backend

# Private networking only: no public domain is attached, so the port is fixed
# and the bind host must be IPv6 for Railway's internal DNS to reach it.
ENV NODE_ENV=production
ENV BACKEND_PORT=8787
EXPOSE 8787

CMD ["node", "backend/src/server.mjs"]
