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

# Copy the entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
RUN mkdir -p /var/lib/mysql
RUN chmod -R 0755 /var/lib/mysql 
# Use the entrypoint script to start the application
ENTRYPOINT ["/app/entrypoint.sh"]