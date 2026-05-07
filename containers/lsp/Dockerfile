FROM eclipse-temurin:17-jdk-jammy

ARG FRC_UID=1000
ARG FRC_GID=1000
ARG JDT_TAR_URL=https://download.eclipse.org/jdtls/milestones/1.37.0/jdt-language-server-1.37.0-202406271335.tar.gz
ARG BUN_VERSION=1.3.13

RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates curl unzip wget tini \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "${FRC_GID}" frc \
    && useradd --uid "${FRC_UID}" --gid "${FRC_GID}" --home-dir /home/frc --create-home --shell /bin/bash frc

ENV HOME=/home/frc
ENV GRADLE_USER_HOME=/home/frc/.gradle

# Install Bun for the WebSocket bridge.
ENV BUN_INSTALL=/usr/local/bun
ENV PATH=${BUN_INSTALL}/bin:${PATH}
RUN curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}" \
    && chmod -R a+rX "${BUN_INSTALL}"

RUN mkdir -p /opt/jdtls \
    && wget -O /tmp/jdtls.tar.gz "${JDT_TAR_URL}" \
    && tar -xzf /tmp/jdtls.tar.gz -C /opt/jdtls \
    && rm /tmp/jdtls.tar.gz

WORKDIR /opt/bridge
COPY containers/lsp/bridge/bridge.ts ./bridge.ts

# Prime the Gradle cache so JDT LS can resolve WPILib dependencies on first project load.
WORKDIR /workspace
COPY templates/wpilib-java-command/ /workspace/template/
RUN chown -R "${FRC_UID}:${FRC_GID}" /workspace /home/frc /opt/jdtls /opt/bridge

USER ${FRC_UID}:${FRC_GID}
WORKDIR /workspace/template
RUN sed -i 's/\r$//' gradlew && chmod +x gradlew
RUN ./gradlew --no-daemon --console=plain build
RUN ./gradlew --no-daemon --stop; rm -rf /workspace/template/build /workspace/template/.gradle

USER root
RUN mkdir -p /opt/frc-gradle-cache \
    && cp -a /home/frc/.gradle/. /opt/frc-gradle-cache/ \
    && chown -R "${FRC_UID}:${FRC_GID}" /opt/frc-gradle-cache

COPY containers/lsp/entrypoint.sh /usr/local/bin/lsp-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/lsp-entrypoint.sh \
    && chmod +x /usr/local/bin/lsp-entrypoint.sh

USER ${FRC_UID}:${FRC_GID}
WORKDIR /workspace/project

ENV HOST=0.0.0.0
ENV PORT=30003
ENV LSP_PATH=/jdtls
ENV JDTLS_HOME=/opt/jdtls
ENV JDTLS_CONFIG=/opt/jdtls/config_linux
ENV JDTLS_DATA=/workspace/jdtls-data
ENV JDTLS_HEAP_MAX=1G

EXPOSE 30003
ENTRYPOINT ["tini", "--", "/usr/local/bin/lsp-entrypoint.sh"]
