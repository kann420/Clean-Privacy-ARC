FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# The validated generated registry is committed with the web package. Railway's
# service root is /web, so the deployment image intentionally does not reach
# outside its build context to regenerate it from the repository root.
RUN npm run build:deploy

FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv

EXPOSE 3000

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
