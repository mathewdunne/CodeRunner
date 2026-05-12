# V2 merged code container
# Layers JDK 17 + Gradle/WPILib cache + FRC extensions on linuxserver/openvscode-server
# Base already provides: openvscode-server, s6-overlay, abc user, PUID/PGID support
# See docs/decisions/017-linuxserver-base-migration.md

FROM linuxserver/openvscode-server:1.109.5

# ── System dependencies ────────────────────────────────────────────────
# Ubuntu 24.04 ships GLIBCXX_3.4.32+ natively — no PPA needed.
# procps is needed for sim scripts (pkill/pgrep).
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends \
        procps wget \
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

# ── Scripts ────────────────────────────────────────────────────────────
COPY containers/code/start-sim.sh containers/code/stop-sim.sh /usr/local/bin/
COPY containers/code/sim-headless.init.gradle /usr/local/share/frc/sim-headless.init.gradle

RUN sed -i 's/\r$//' /usr/local/bin/start-sim.sh /usr/local/bin/stop-sim.sh \
    && chmod +x /usr/local/bin/start-sim.sh /usr/local/bin/stop-sim.sh

# ── s6-overlay service definitions (additive to upstream) ─────────────
# Adds init-frc-setup oneshot and overrides svc-openvscode-server run script.
COPY containers/code/root/ /

# ── Download and install VS Code extensions ────────────────────────────
ARG REDHAT_JAVA_VERSION=1.38.0
ARG WPILIB_EXT_VERSION=2026.1.1
ARG JAVA_DEBUG_VERSION=0.59.0
ARG JAVA_TEST_VERSION=0.45.0
ARG MAVEN_VERSION=0.45.3
ARG GRADLE_VERSION=3.17.3
ARG JAVA_DEPS_VERSION=0.27.2
ARG JAVA_PACK_VERSION=0.30.5
ARG SPOTLESS_GRADLE_VERSION=1.2.1

# Download extensions from pinned Open VSX, GitHub Release, and Marketplace artifacts.
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
    && wget -q "https://richardwillis.gallery.vsassets.io/_apis/public/gallery/publisher/richardwillis/extension/vscode-spotless-gradle/${SPOTLESS_GRADLE_VERSION}/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage" \
       -O /tmp/exts/vscode-spotless-gradle.vsix

# Install to a baked cache directory; the init script seeds per-workspace configs.
RUN mkdir -p /opt/frc-extensions-cache \
    && /app/openvscode-server/bin/openvscode-server \
                     --install-extension /tmp/exts/redhat.java.vsix \
                     --install-extension /tmp/exts/vscode-wpilib.vsix \
                     --install-extension /tmp/exts/vscode-java-debug.vsix \
                     --install-extension /tmp/exts/vscode-java-test.vsix \
                     --install-extension /tmp/exts/vscode-maven.vsix \
                     --install-extension /tmp/exts/vscode-gradle.vsix \
                     --install-extension /tmp/exts/vscode-java-dependency.vsix \
                     --install-extension /tmp/exts/vscode-java-pack.vsix \
                     --install-extension /tmp/exts/vscode-spotless-gradle.vsix \
                     --extensions-dir /opt/frc-extensions-cache \
    && rm -rf /tmp/exts

# ── Gradle / WPILib cache priming ─────────────────────────────────────
WORKDIR /workspace
COPY templates/wpilib-java-command/ /workspace/template/

RUN mkdir -p /config/.gradle \
    && chown -R abc:abc /workspace /config/.gradle

USER abc
ENV GRADLE_USER_HOME=/config/.gradle
WORKDIR /workspace/template

RUN sed -i 's/\r$//' gradlew && chmod +x gradlew
RUN ./gradlew --no-daemon --console=plain build
RUN ./gradlew --no-daemon --stop; \
    rm -rf /workspace/template/build /workspace/template/.gradle

USER root
RUN mkdir -p /opt/frc-gradle-cache \
    && cp -a /config/.gradle/. /opt/frc-gradle-cache/ \
    && rm -rf /config/.gradle

# ── Runtime defaults ──────────────────────────────────────────────────
RUN mkdir -p /workspace/project \
    && chown -R abc:abc /workspace

WORKDIR /workspace/project

EXPOSE 3000 3300 5810
