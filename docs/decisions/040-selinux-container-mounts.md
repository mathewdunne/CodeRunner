# 040 — SELinux container mounts

Date: 2026-09-07

## Context

On enforcing SELinux hosts, ordinary Unix ownership and Docker socket group
membership are insufficient: the control container can be denied database and
Docker socket access, and student containers can be denied project access.

## Decision

- Set `security_opt: [label=disable]` only on the Compose control service. It is
  a trusted orchestrator with host Docker daemon access. Student containers keep
  SELinux confinement; the host's SELinux enforcement remains enabled.
- Leave the control service's data and Docker socket mounts without relabeling.
  Relabeling the parent data tree could interfere with nested student mounts.
- Use `-v source:destination:z` for student project and normal-mode editor home
  bind mounts. Docker's `--mount` syntax cannot request SELinux relabeling.
- Preserve demo mode's Docker-managed `/config` named volume and its lifecycle.
  This avoids the Docker Desktop filesystem performance regression that would
  come from replacing it with a host bind mount.

## Consequences

Shared labels allow container access to these dedicated CodeRunner directories,
but do not provide private per-container SELinux category isolation for them.
Unix permissions and mount isolation still apply. The control service loses
SELinux confinement, a deliberate tradeoff for its host orchestration role.
No host-wide SELinux changes or socket relabeling are required.

`-v` can create a missing host source directory, unlike `--mount`. Existing
workspace directory preparation and host-path translation remain in place;
operators must still provision relocated data directories with correct ownership.
Existing student containers must be rebuilt to receive the new mount options.

The local base Compose deployment is the scope of this change. Additional
services in the production override (Caddy and Alloy) need separate SELinux
validation if that deployment is moved to an enforcing host.

Validation covers Docker argument generation and container lifecycle in both
modes. An enforcing-host check must additionally exercise startup, lesson load,
build/run, and control recreation while student containers exist; mocked tests
cannot validate host policy enforcement.

References:

- https://docs.docker.com/engine/storage/bind-mounts/#configure-the-selinux-label
- https://docs.docker.com/reference/compose-file/services/#volumes
- https://bugzilla.redhat.com/show_bug.cgi?id=1758227
