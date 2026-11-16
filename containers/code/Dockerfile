ARG SPOTLESS_GRADLE_VERSION=1.2.1
ARG SPOTLESS_GRADLE_COMMIT=c11a273a11454bfc06fc9cbb19290d5c330e884c

# The publisher does not attach VSIX files to GitHub releases and the extension
# is absent from Open VSX. Build the pinned MIT-licensed source instead of
# downloading the Marketplace artifact (which is not licensed for VSCodium).
FROM node:24-slim AS spotless-builder

ARG SPOTLESS_GRADLE_VERSION
ARG SPOTLESS_GRADLE_COMMIT

RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/* \
    && wget -q "https://github.com/badsyntax/vscode-spotless-gradle/archive/${SPOTLESS_GRADLE_COMMIT}.tar.gz" \
       -O /tmp/vscode-spotless-gradle.tar.gz \
    && mkdir -p /src \
    && tar xzf /tmp/vscode-spotless-gradle.tar.gz --strip-components=1 -C /src \
    && cd /src \
    && npm ci --ignore-scripts \
    && npm version "${SPOTLESS_GRADLE_VERSION}" --no-git-tag-version --allow-same-version \
    && npx vsce package --no-dependencies --out /tmp/vscode-spotless-gradle.vsix

# CodeRunner's own editor extension: attaches the Java debugger to Debug runs.
# See docs/decisions/045-sim-debugging.md.
FROM node:24-slim AS coderunner-debug-builder

COPY containers/code/coderunner-debug/ /src/
WORKDIR /src
RUN npx --yes esbuild@0.24.2 src/extension.ts --bundle --platform=node --format=cjs \
       --external:vscode --tsconfig-raw={} --outfile=dist/extension.js \
    && npx --yes @vscode/vsce@3.2.1 package --no-dependencies --skip-license \
       --allow-missing-repository --out /tmp/coderunner-debug.vsix

# V2 merged code container
# Layers JDK 17/21 + Gradle/WPILib cache + FRC extensions on linuxserver/vscodium-web
# Base already provides: codium-server (VSCodium reh-web), s6-overlay, abc user,
# PUID/PGID support. See docs/decisions/017-linuxserver-base-migration.md and
# docs/decisions/036-vscodium-web-migration.md
FROM linuxserver/vscodium-web:1.126.04524-ls35

# LinuxServer's VSCodium build points webviews at a stale VS Code CDN bundle.
# Keep the isolated-origin bootstrap on the upstream commit used by VSCodium
# 1.126.0; the stale bundle cannot load vscode-resource streams.
ARG VSCODE_WEBVIEW_COMMIT=7e7950df89d055b5a378379db9ee14290772148a
RUN VSCODE_PRODUCT_PATHS="/app/vscodium-web/product.json /app/vscodium-web/out" \
    && STALE_WEBVIEW_COMMIT=ef65ac1ba57f57f2a3961bfe94aa20481caca4c6 \
    && test "$(grep -rhoF "${STALE_WEBVIEW_COMMIT}" ${VSCODE_PRODUCT_PATHS} | wc -l)" -eq 8 \
    && grep -rlF "${STALE_WEBVIEW_COMMIT}" ${VSCODE_PRODUCT_PATHS} \
        | xargs sed -i "s/${STALE_WEBVIEW_COMMIT}/${VSCODE_WEBVIEW_COMMIT}/g" \
    && test "$(grep -rhoF "${STALE_WEBVIEW_COMMIT}" ${VSCODE_PRODUCT_PATHS} | wc -l)" -eq 0 \
    && test "$(grep -rhoF "${VSCODE_WEBVIEW_COMMIT}" ${VSCODE_PRODUCT_PATHS} | wc -l)" -eq 8

# ── System dependencies ────────────────────────────────────────────────
# Ubuntu 24.04 ships GLIBCXX_3.4.32+ natively — no PPA needed.
# procps is needed for sim scripts (pkill/pgrep).
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends \
        jq procps wget \
    && rm -rf /var/lib/apt/lists/*

# ── GitHub CLI (gh) ────────────────────────────────────────────────────
# Installed from GitHub's apt repo. Student auth (gh auth login) persists in
# ~/.config/gh under HOME=/config, which is the per-workspace bind mount.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        > /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update -qq \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ── JDKs (Adoptium Temurin) ───────────────────────────────────────────
# TARGETARCH (amd64/arm64, set by buildx) picks the Temurin arch classifier.
ARG TARGETARCH
ARG JDK17_VERSION=17.0.15+6
ARG JDK21_VERSION=21.0.12.1+1

RUN case "${TARGETARCH}" in \
        amd64) JDK_ARCH=x64 ;; \
        arm64) JDK_ARCH=aarch64 ;; \
        *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && mkdir -p /usr/lib/jvm \
    && JDK17_TAG="jdk-$(echo "${JDK17_VERSION}" | sed 's/+/%2B/')" \
    && JDK17_FILE="OpenJDK17U-jdk_${JDK_ARCH}_linux_hotspot_$(echo "${JDK17_VERSION}" | tr + _).tar.gz" \
    && wget -q "https://github.com/adoptium/temurin17-binaries/releases/download/${JDK17_TAG}/${JDK17_FILE}" -O /tmp/jdk17.tar.gz \
    && tar xzf /tmp/jdk17.tar.gz -C /usr/lib/jvm \
    && rm /tmp/jdk17.tar.gz \
    && ln -s "/usr/lib/jvm/jdk-${JDK17_VERSION}" /usr/lib/jvm/jdk-17 \
    && JDK21_TAG="jdk-$(echo "${JDK21_VERSION}" | sed 's/+/%2B/')" \
    && JDK21_FILE="OpenJDK21U-jdk_${JDK_ARCH}_linux_hotspot_$(echo "${JDK21_VERSION}" | tr + _).tar.gz" \
    && wget -q "https://github.com/adoptium/temurin21-binaries/releases/download/${JDK21_TAG}/${JDK21_FILE}" -O /tmp/jdk21.tar.gz \
    && tar xzf /tmp/jdk21.tar.gz -C /usr/lib/jvm \
    && rm /tmp/jdk21.tar.gz \
    && ln -s "/usr/lib/jvm/jdk-${JDK21_VERSION}" /usr/lib/jvm/jdk-21

ENV JAVA_HOME=/usr/lib/jvm/jdk-17
ENV JDK_HOME=/usr/lib/jvm/jdk-21
ENV PATH="${JAVA_HOME}/bin:${PATH}"

RUN java -version && "${JDK_HOME}/bin/java" -version

# ── Scripts ────────────────────────────────────────────────────────────
COPY containers/code/start-sim.sh containers/code/run-sim.sh containers/code/stop-sim.sh /usr/local/bin/
COPY containers/code/reconcile-extensions.sh /usr/local/bin/reconcile-frc-extensions
COPY containers/code/sim-headless.init.gradle /usr/local/share/frc/sim-headless.init.gradle

RUN chmod +x /usr/local/bin/start-sim.sh /usr/local/bin/run-sim.sh /usr/local/bin/stop-sim.sh \
             /usr/local/bin/reconcile-frc-extensions

# ── s6-overlay service definitions (additive to upstream) ─────────────
# Adds init-frc-setup oneshot and overrides svc-vscodium-web run script.
COPY containers/code/root/ /
RUN chmod +x /etc/s6-overlay/s6-rc.d/init-frc-setup/run \
             /etc/s6-overlay/s6-rc.d/svc-vscodium-web/run

# ── Download and install VS Code extensions ────────────────────────────
ARG REDHAT_JAVA_VERSION=1.55.0
ARG WPILIB_EXT_VERSION=2026.1.1
ARG JAVA_DEBUG_VERSION=0.59.0
ARG JAVA_TEST_VERSION=0.46.0
ARG MAVEN_VERSION=0.45.3
ARG GRADLE_VERSION=3.18.0
ARG JAVA_DEPS_VERSION=0.27.6
ARG JAVA_PACK_VERSION=0.31.1
ARG SPOTLESS_GRADLE_VERSION
ARG CODERUNNER_DEBUG_VERSION=0.1.2

# Download pinned Open VSX and GitHub Release artifacts. Spotless is copied
# from the pinned-source builder above.
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
       -O /tmp/exts/vscode-java-pack.vsix

COPY --from=spotless-builder /tmp/vscode-spotless-gradle.vsix /tmp/exts/vscode-spotless-gradle.vsix
COPY --from=coderunner-debug-builder /tmp/coderunner-debug.vsix /tmp/exts/coderunner-debug.vsix

# Do not resolve extension packs or dependencies from the gallery; every required
# Java extension is installed explicitly below.
RUN mkdir -p /opt/frc-extensions-cache \
    && /app/vscodium-web/bin/codium-server \
                     --do-not-include-pack-dependencies \
                     --install-extension /tmp/exts/redhat.java.vsix \
                     --install-extension /tmp/exts/vscode-wpilib.vsix \
                     --install-extension /tmp/exts/vscode-java-debug.vsix \
                     --install-extension /tmp/exts/vscode-java-test.vsix \
                     --install-extension /tmp/exts/vscode-maven.vsix \
                     --install-extension /tmp/exts/vscode-gradle.vsix \
                     --install-extension /tmp/exts/vscode-java-dependency.vsix \
                     --install-extension /tmp/exts/vscode-java-pack.vsix \
                     --install-extension /tmp/exts/vscode-spotless-gradle.vsix \
                     --install-extension /tmp/exts/coderunner-debug.vsix \
                     --extensions-dir /opt/frc-extensions-cache \
    && jq -e \
       --argjson expected '["redhat.java@'"${REDHAT_JAVA_VERSION}"'","wpilibsuite.vscode-wpilib@'"${WPILIB_EXT_VERSION}"'","vscjava.vscode-java-debug@'"${JAVA_DEBUG_VERSION}"'","vscjava.vscode-java-test@'"${JAVA_TEST_VERSION}"'","vscjava.vscode-maven@'"${MAVEN_VERSION}"'","vscjava.vscode-gradle@'"${GRADLE_VERSION}"'","vscjava.vscode-java-dependency@'"${JAVA_DEPS_VERSION}"'","vscjava.vscode-java-pack@'"${JAVA_PACK_VERSION}"'","richardwillis.vscode-spotless-gradle@'"${SPOTLESS_GRADLE_VERSION}"'","coderunner.coderunner-debug@'"${CODERUNNER_DEBUG_VERSION}"'"]' \
       'length == ($expected | length) and all(.[]; .metadata.source == "vsix" and .metadata.pinned == true) and ([.[] | "\(.identifier.id)@\(.version)"] | sort) == ($expected | sort)' \
       /opt/frc-extensions-cache/extensions.json > /dev/null \
    && rm -rf /tmp/exts

# ── Bundled lesson catalog ────────────────────────────────────────────
# Baked into the image so bundled module loads copy locally (no network).
COPY --chown=abc:abc catalog/ /opt/frc-catalog/

# ── Gradle / WPILib cache priming ─────────────────────────────────────
# Prime directly into the cache path shipped in the final image. Keeping the
# build, cleanup, and alias in one layer prevents the cache and template build
# output from being retained in earlier layers.
ENV GRADLE_USER_HOME=/config/.gradle
RUN mkdir -p /opt/frc-gradle-cache /workspace \
    && chown -R abc:abc /opt/frc-gradle-cache /workspace

# WPILib templates use permwrapper/dists while the catalog uses wrapper/dists.
# Gradle keys distributions by URL, so both paths can share the primed cache.
USER abc
WORKDIR /workspace
RUN cp -a /opt/frc-catalog/modules/robot-starter /workspace/template \
    && cd /workspace/template \
    && chmod +x gradlew \
    && GRADLE_USER_HOME=/opt/frc-gradle-cache ./gradlew --no-daemon --console=plain build \
    && GRADLE_USER_HOME=/opt/frc-gradle-cache ./gradlew --no-daemon --stop \
    && cd /workspace \
    && rm -rf /workspace/template \
    && test ! -e /opt/frc-gradle-cache/permwrapper \
    && test ! -L /opt/frc-gradle-cache/permwrapper \
    && ln -s wrapper /opt/frc-gradle-cache/permwrapper

USER root

# ── License notices ───────────────────────────────────────────────────
# This image redistributes VSCodium reh-web, Temurin, WPILib, and the bundled
# extensions; the BSD-3-Clause components require their notice to accompany
# the distribution. Placed after the Gradle priming so notice edits don't
# invalidate that layer.
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/coderunner/

# ── Runtime defaults ──────────────────────────────────────────────────
RUN mkdir -p /workspace/project \
    && chown -R abc:abc /workspace

WORKDIR /workspace/project

EXPOSE 3000 3300 5810
