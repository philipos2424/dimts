FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
COPY vendor ./vendor
RUN npm ci
COPY app ./app
COPY src ./src
COPY assets ./assets
COPY app.json babel.config.js tsconfig.json ./
ENV EXPO_NO_TELEMETRY=1
RUN npx expo export --platform web --output-dir dist

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server ./
COPY --from=web /build/dist /app/dist
ENV NODE_ENV=production PORT=3000 DATABASE_MODE=postgres
USER node
EXPOSE 3000
CMD ["node", "production.js"]
