FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install
COPY prisma ./prisma/
RUN npx prisma generate
COPY . .
COPY .env.example .env

EXPOSE 4000

CMD ["npm", "start"]