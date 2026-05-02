# JDK 21 is the default `java` on PATH (jdtls 1.58 requires JavaSE 21+).
# JDK 17 is staged in /opt/jdk17 for the WPILib gradle prime step, since
# WPILib 2026's build.gradle pins source/target to JavaVersion.VERSION_17
# and we want the prime to match what the sim container does.
FROM eclipse-temurin:17-jdk-jammy AS jdk17

FROM eclipse-temurin:21-jdk-jammy

COPY --from=jdk17 /opt/java/openjdk /opt/jdk17

# Headless tooling deps. No GUI libs (jdtls runs over stdio).
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

# Pinned jdtls release. Update all three ARGs together; SHA verified against
# the .sha256 file Eclipse publishes alongside the tarball.
# See docs/decisions/007-jdtls-container.md.
ARG JDTLS_VERSION=1.58.0
ARG JDTLS_BUILD=202604151538
ARG JDTLS_SHA256=2a5bbe55ec91b4325392050dc422cead3220a2459b3766be35e1fff45b4a50d9

RUN curl -fsSL "https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}/jdt-language-server-${JDTLS_VERSION}-${JDTLS_BUILD}.tar.gz" \
        -o /tmp/jdtls.tar.gz \
    && echo "${JDTLS_SHA256}  /tmp/jdtls.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/jdtls \
    && tar -xzf /tmp/jdtls.tar.gz -C /opt/jdtls \
    && rm /tmp/jdtls.tar.gz

# Bake a copy of the project so we can prime gradle during image build.
# At runtime the named volume mount overlays /workspace/project with the live
# tree, so this baked copy is only used for cache priming and as the
# fallback contents if the volume is ever fresh.
WORKDIR /workspace
COPY containers/sim/project/ /workspace/project/

WORKDIR /workspace/project
RUN sed -i 's/\r$//' gradlew && chmod +x gradlew
# Prime ~/.gradle with WPILib deps + classpath resolution under JDK 17 to
# match what the sim container does.
RUN JAVA_HOME=/opt/jdk17 PATH=/opt/jdk17/bin:$PATH ./gradlew --no-daemon --console=plain build
RUN JAVA_HOME=/opt/jdk17 PATH=/opt/jdk17/bin:$PATH ./gradlew --no-daemon --stop; rm -rf /workspace/project/build /workspace/project/.gradle

# jdtls workspace data lives in the writable layer. Recreated by image rebuild;
# not pre-warmed here because driving jdtls via stdio in a build step is
# fiddly. First /lsp connection is ~30s cold; subsequent reuse is fast.
ENV JDTLS_WORKSPACE=/workspace/jdtls-data
RUN mkdir -p "$JDTLS_WORKSPACE"

COPY containers/lsp/entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
