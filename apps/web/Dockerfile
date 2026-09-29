# ---------------------------------------------------------------------------
# The storefront as static files behind nginx.
#
# The API types are generated from contract/openapi.yaml on every build, so the
# contract is passed in as a second build context (see infra/compose.yaml)
# rather than widening this context to the whole repository. It lands at the
# same relative path, ../../contract, that `npm run gen:api` expects locally.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build
WORKDIR /src/apps/web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --from=contract openapi.yaml /src/contract/openapi.yaml
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
