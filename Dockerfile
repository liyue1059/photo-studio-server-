# 微信云托管（CloudBase Run）镜像
# 云托管会注入 PORT（默认 80），app.js 已用 process.env.PORT，无需改代码。
FROM node:18-alpine

WORKDIR /app

# 先装依赖，利用层缓存
COPY package*.json ./
RUN npm install --production

# 复制源码
COPY . .

EXPOSE 80
CMD ["node", "app.js"]
