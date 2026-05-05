FROM eclipse-temurin:17-jdk-jammy

ARG FRC_UID=1000
ARG FRC_GID=1000

RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates curl procps tini \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "${FRC_GID}" frc \
    && useradd --uid "${FRC_UID}" --gid "${FRC_GID}" --home-dir /home/frc --create-home --shell /bin/bash frc

ENV HOME=/home/frc
ENV GRADLE_USER_HOME=/home/frc/.gradle

WORKDIR /workspace
COPY templates/wpilib-java-command/ /workspace/template/
COPY containers/sim/entrypoint.sh containers/sim/start-sim.sh containers/sim/stop-sim.sh /usr/local/bin/

RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh /usr/local/bin/start-sim.sh /usr/local/bin/stop-sim.sh \
    && chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/start-sim.sh /usr/local/bin/stop-sim.sh \
    && chown -R "${FRC_UID}:${FRC_GID}" /workspace /home/frc

USER ${FRC_UID}:${FRC_GID}

WORKDIR /workspace/template
RUN sed -i 's/\r$//' gradlew && chmod +x gradlew
RUN ./gradlew --no-daemon --console=plain build
RUN ./gradlew --no-daemon --stop; rm -rf /workspace/template/build /workspace/template/.gradle

USER root
RUN mkdir -p /opt/frc-gradle-cache \
    && cp -a /home/frc/.gradle/. /opt/frc-gradle-cache/ \
    && chown -R "${FRC_UID}:${FRC_GID}" /opt/frc-gradle-cache

USER ${FRC_UID}:${FRC_GID}
WORKDIR /workspace/project

EXPOSE 5810
ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
