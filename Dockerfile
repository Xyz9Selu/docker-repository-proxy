FROM node:22

WORKDIR /app

COPY package.json /app
RUN npm install

COPY . /app

ENV NODE_ENV=production
ENV MODE=production
ENV PORT=3000
ENV CUSTOM_DOMAIN=api.example.com


EXPOSE 3000

CMD ["npm", "run", "start"]
