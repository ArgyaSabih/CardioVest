FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY main.js ./
COPY lib ./lib
COPY routes ./routes
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "main.js"]
