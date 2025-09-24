FROM mcr.microsoft.com/playwright:v1.55.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npx --yes playwright install chromium
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node","server/index.js"]