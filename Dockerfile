FROM node:24.22.2-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY public ./public
COPY server ./server
RUN mkdir -p data
EXPOSE 3000
CMD ["npm", "start"]
