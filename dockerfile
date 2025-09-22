FROM mcr.microsoft.com/playwright:v1.47.2-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node","server/index.js"]