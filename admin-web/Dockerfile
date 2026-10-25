FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:stable-alpine
ENV NGINX_ENVSUBST_FILTER=^API_UPSTREAM$
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["sh", "-c", "if [ -z \"$API_UPSTREAM\" ]; then echo >&2 'API_UPSTREAM must be set to the backend origin'; exit 1; fi; exec nginx -g 'daemon off;'"]
