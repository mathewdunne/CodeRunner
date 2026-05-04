FROM eclipse-temurin:17-jdk-jammy

ARG JDT_TAR_URL=https://download.eclipse.org/jdtls/milestones/1.37.0/jdt-language-server-1.37.0-202406271335.tar.gz

RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates curl wget gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/jdtls \
    && wget -O /tmp/jdtls.tar.gz "${JDT_TAR_URL}" \
    && tar -xzf /tmp/jdtls.tar.gz -C /opt/jdtls \
    && rm /tmp/jdtls.tar.gz

WORKDIR /app/apps/lsp
COPY apps/lsp/package.json ./
RUN npm install
COPY apps/lsp/tsconfig.json ./tsconfig.json
COPY apps/lsp/src ./src

COPY containers/sim/project/ /workspace/project/
WORKDIR /workspace/project
RUN sed -i 's/\r$//' gradlew \
    && chmod +x gradlew \
    && ./gradlew --no-daemon --console=plain build \
    && ./gradlew --no-daemon --stop \
    && rm -rf build .gradle

ENV HOST=0.0.0.0
ENV PORT=30003
ENV LSP_PATH=/jdtls
ENV JDTLS_HOME=/opt/jdtls
ENV JDTLS_CONFIG=/opt/jdtls/config_linux
ENV JDTLS_LAUNCHER=/opt/jdtls/plugins/org.eclipse.equinox.launcher_1.6.900.v20240613-2009.jar
ENV JDTLS_DATA=/workspace/jdtls-data

WORKDIR /app/apps/lsp
EXPOSE 30003
CMD ["npm", "run", "dev"]
