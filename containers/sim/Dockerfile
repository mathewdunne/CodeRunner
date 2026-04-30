FROM eclipse-temurin:17-jdk-jammy

# Headless sim deps only. We deliberately omit libgl1, libxrandr, libxcursor, etc.
# because the sim runs without SimGUI (see project/build.gradle and
# docs/decisions/001-sim-container.md).
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates curl procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY project/ /workspace/project/

# Prime the Gradle dependency cache by running a full build during image build.
# This downloads GradleRIO + WPILib jars + native libs and bakes them into the
# image so container startup doesn't hit the network.
WORKDIR /workspace/project
RUN sed -i 's/\r$//' gradlew && chmod +x gradlew
RUN ./gradlew --no-daemon --console=plain build
RUN ./gradlew --no-daemon --stop; rm -rf /workspace/project/build /workspace/project/.gradle

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 5810
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
