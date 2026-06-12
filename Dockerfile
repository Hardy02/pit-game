# Minimal image for the zero-dependency PIT server.
FROM node:20-alpine
WORKDIR /app

# No dependencies to install — just copy the app in.
COPY package.json ./
COPY server.js index.html pit.html ./

# Fly routes public traffic to this internal port; the server reads PORT.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
