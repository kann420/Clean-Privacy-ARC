FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite inlines import.meta.env at build time, so the backend mode has to be
# present during the build rather than in the runtime environment. A Railway
# service variable only reaches a Dockerfile build through a declared ARG;
# without these two lines the build silently produces a demo-mode bundle no
# matter what the service variables say.
ARG VITE_BACKEND_MODE
ARG VITE_API_BASE_URL
ENV VITE_BACKEND_MODE=$VITE_BACKEND_MODE
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

# The validated generated registry is committed with the web package. Railway's
# service root is /web, so the deployment image intentionally does not reach
# outside its build context to regenerate it from the repository root.
RUN npm run build:deploy

FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv

EXPOSE 3000

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
