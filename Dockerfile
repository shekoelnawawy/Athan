FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY public ./public
COPY server ./server
COPY data ./data
EXPOSE 3000
CMD ["npm", "start"]
