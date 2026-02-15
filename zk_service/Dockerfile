FROM oven/bun:1

WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl ca-certificates git jq nodejs npm \
	&& rm -rf /var/lib/apt/lists/*

ARG BB_VERSION=3.0.0-nightly.20260102
ARG NOIR_VERSION=1.0.0-beta.18

RUN curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/next/barretenberg/bbup/install | bash \
	&& /root/.bb/bbup --version ${BB_VERSION} \
	&& ln -sf /root/.bb/bb /usr/local/bin/bb \
	&& bb --version

RUN curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash \
	&& /root/.nargo/bin/noirup -v ${NOIR_VERSION} \
	&& ln -sf /root/.nargo/bin/nargo /usr/local/bin/nargo \
	&& nargo --version

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY . .

ENV NODE_ENV=production
ENV PORT=3011

EXPOSE 3011

CMD ["bun", "run", "zk_service/index.ts"]
