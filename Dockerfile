# 零第三方依赖，所以不需要 npm install，镜像里只有源码和 Node 运行时。
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# 先只拷贝清单文件，让源码变更不至于让前面的层失效
COPY package.json ./
COPY src/ ./src/
COPY test/ ./test/
COPY examples/ ./examples/
COPY docs/ ./docs/
COPY demo/ ./demo/

# 非 root 运行
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /data/state /data/generations /data/private \
    && chown -R appuser:appuser /app /data
USER appuser

# 运行期状态与私有输入都挂在这里，容器本身不留存
VOLUME ["/data"]

ENV STATE_DIR=/data/state
ENV GENERATION_LOG_DIR=/data/generations

# 默认跑一次合成样例；实际部署时按需要覆盖 command
CMD ["node", "src/cli.js", "run", "examples/input/synthetic-story.json"]
