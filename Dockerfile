FROM node:24-slim

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install
COPY prisma ./prisma/
RUN npx prisma generate
COPY . .
COPY .env.example .env

EXPOSE 4000

CMD ["npm", "start"]