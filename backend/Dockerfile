FROM node:22-alpine

WORKDIR /app

# The backend imports scripts/lib/*.mjs and reads config/chains.json through
# ROOT_URL, so this image is built from the repository root rather than from
# /backend. Railway must set the service root directory to the repository root
# and the Dockerfile path to backend/Dockerfile.
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
