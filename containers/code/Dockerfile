# V2 merged code container
# Combines openvscode-server + JDK 17 + Gradle/WPILib cache + redhat.java + vscode-wpilib
# Base: gitpod/openvscode-server (spike-proven in Decision 011)

FROM gitpod/openvscode-server:1.105.1

USER root

# ── System dependencies ────────────────────────────────────────────────
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends \
        tini procps ca-certificates curl wget \
    && rm -rf /var/lib/apt/lists/*

# ── JDK 17 (Adoptium Temurin, Linux x64) ──────────────────────────────
ARG JDK_VERSION=17.0.15+6
ARG JDK_URL=https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.15%2B6/OpenJDK17U-jdk_x64_linux_hotspot_17.0.15_6.tar.gz

RUN mkdir -p /usr/lib/jvm \
    && wget -q "${JDK_URL}" -O /tmp/jdk.tar.gz \
    && tar xzf /tmp/jdk.tar.gz -C /usr/lib/jvm \
    && rm /tmp/jdk.tar.gz \
    && ln -s /usr/lib/jvm/jdk-* /usr/lib/jvm/jdk-17

ENV JAVA_HOME=/usr/lib/jvm/jdk-17
ENV PATH="${JAVA_HOME}/bin:${PATH}"

RUN java -version

# ── frc user (configurable UID/GID for bind-mount compat) ──────────────
ARG FRC_UID=1000
ARG FRC_GID=1000

# The base image ships an `openvscode-server` user. Remove any existing
# user/group at the target UID/GID to avoid conflicts, then create `frc`.
RUN set -e; \
    existing_user=$(getent passwd "${FRC_UID}" | cut -d: -f1 || true); \
    if [ -n "$existing_user" ]; then userdel "$existing_user"; fi; \
    existing_group=$(getent group "${FRC_GID}" | cut -d: -f1 || true); \
    if [ -n "$existing_group" ]; then groupdel "$existing_group" 2>/dev/null || true; fi; \
    groupadd --gid "${FRC_GID}" frc; \
    useradd --uid "${FRC_UID}" --gid "${FRC_GID}" \
       --home-dir /home/frc --create-home --shell /bin/bash frc

ENV HOME=/home/frc
ENV GRADLE_USER_HOME=/home/frc/.gradle

# ── Scripts ────────────────────────────────────────────────────────────
COPY containers/code/entrypoint.sh containers/code/start-sim.sh containers/code/stop-sim.sh /usr/local/bin/

RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh /usr/local/bin/start-sim.sh /usr/local/bin/stop-sim.sh \
    && chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/start-sim.sh /usr/local/bin/stop-sim.sh

# ── Download and install VS Code extensions ────────────────────────────
ARG REDHAT_JAVA_VERSION=1.38.0
ARG WPILIB_EXT_VERSION=2026.1.1
ARG JAVA_DEBUG_VERSION=0.59.0
ARG JAVA_TEST_VERSION=0.45.0
ARG MAVEN_VERSION=0.45.3
ARG GRADLE_VERSION=3.17.3
ARG JAVA_DEPS_VERSION=0.27.2
ARG JAVA_PACK_VERSION=0.30.5

ENV OPENVSCODE_SERVER_ROOT=/home/.openvscode-server
ENV OPENVSCODE=${OPENVSCODE_SERVER_ROOT}/bin/openvscode-server

# Download extensions from Open VSX and GitHub Releases.
# Spotless Gradle is only on the MS marketplace; use the gallery asset API.
RUN mkdir -p /tmp/exts \
    && wget -q "https://open-vsx.org/api/redhat/java/${REDHAT_JAVA_VERSION}/file/redhat.java-${REDHAT_JAVA_VERSION}.vsix" \
       -O /tmp/exts/redhat.java.vsix \
    && wget -q "https://github.com/wpilibsuite/vscode-wpilib/releases/download/v${WPILIB_EXT_VERSION}/vscode-wpilib-${WPILIB_EXT_VERSION}.vsix" \
       -O /tmp/exts/vscode-wpilib.vsix \
    && wget -q "https://open-vsx.org/api/vscjava/vscode-java-debug/${JAVA_DEBUG_VERSION}/file/vscjava.vscode-java-debug-${JAVA_DEBUG_VERSION}.vsix" \
       -O /tmp/exts/vscode-java-debug.vsix \
    && wget -q "https://open-vsx.org/api/vscjava/vscode-java-test/${JAVA_TEST_VERSION}/file/vscjava.vscode-java-test-${JAVA_TEST_VERSION}.vsix" \
       -O /tmp/exts/vscode-java-test.vsix \
    && wget -q "https://open-vsx.org/api/vscjava/vscode-maven/${MAVEN_VERSION}/file/vscjava.vscode-maven-${MAVEN_VERSION}.vsix" \
       -O /tmp/exts/vscode-maven.vsix \
    && wget -q "https://open-vsx.org/api/vscjava/vscode-gradle/${GRADLE_VERSION}/file/vscjava.vscode-gradle-${GRADLE_VERSION}.vsix" \
       -O /tmp/exts/vscode-gradle.vsix \
    && wget -q "https://open-vsx.org/api/vscjava/vscode-java-dependency/${JAVA_DEPS_VERSION}/file/vscjava.vscode-java-dependency-${JAVA_DEPS_VERSION}.vsix" \
       -O /tmp/exts/vscode-java-dependency.vsix \
    && wget -q "https://open-vsx.org/api/vscjava/vscode-java-pack/${JAVA_PACK_VERSION}/file/vscjava.vscode-java-pack-${JAVA_PACK_VERSION}.vsix" \
       -O /tmp/exts/vscode-java-pack.vsix \
    && wget -q "https://richardwillis.gallery.vsassets.io/_apis/public/gallery/publisher/richardwillis/extension/vscode-spotless-gradle/latest/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage" \
       -O /tmp/exts/vscode-spotless-gradle.vsix

# Install to a baked cache directory; the entrypoint seeds per-workspace homes.
RUN mkdir -p /opt/frc-extensions-cache \
    && chown -R "${FRC_UID}:${FRC_GID}" /opt/frc-extensions-cache

USER ${FRC_UID}:${FRC_GID}
RUN ${OPENVSCODE} --install-extension /tmp/exts/redhat.java.vsix \
                  --install-extension /tmp/exts/vscode-wpilib.vsix \
                  --install-extension /tmp/exts/vscode-java-debug.vsix \
                  --install-extension /tmp/exts/vscode-java-test.vsix \
                  --install-extension /tmp/exts/vscode-maven.vsix \
                  --install-extension /tmp/exts/vscode-gradle.vsix \
                  --install-extension /tmp/exts/vscode-java-dependency.vsix \
                  --install-extension /tmp/exts/vscode-java-pack.vsix \
                  --install-extension /tmp/exts/vscode-spotless-gradle.vsix \
                  --extensions-dir /opt/frc-extensions-cache

USER root
RUN rm -rf /tmp/exts

# Make openvscode-server readable by any UID (in case FRC_UID != 1000).
RUN chmod -R a+rX ${OPENVSCODE_SERVER_ROOT}

# ── Gradle / WPILib cache priming ─────────────────────────────────────
WORKDIR /workspace
COPY templates/wpilib-java-command/ /workspace/template/

RUN chown -R "${FRC_UID}:${FRC_GID}" /workspace /home/frc

USER ${FRC_UID}:${FRC_GID}
WORKDIR /workspace/template

RUN sed -i 's/\r$//' gradlew && chmod +x gradlew
RUN ./gradlew --no-daemon --console=plain build
RUN ./gradlew --no-daemon --stop; \
    rm -rf /workspace/template/build /workspace/template/.gradle

USER root
RUN mkdir -p /opt/frc-gradle-cache \
    && cp -a /home/frc/.gradle/. /opt/frc-gradle-cache/ \
    && chown -R "${FRC_UID}:${FRC_GID}" /opt/frc-gradle-cache

# ── Runtime defaults ──────────────────────────────────────────────────
USER ${FRC_UID}:${FRC_GID}
WORKDIR /workspace/project

EXPOSE 3000 5810
ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
