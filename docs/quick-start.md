---
sidebar_position: 3
title: Quick Start (Installation)
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Quick Start (Installation)

Run CodeRunner locally in demo mode to try the editor, Advantagescope telemetry, and PathPlanner without setting up OAuth.

:::danger[Do not expose demo mode to the internet]

Demo mode bypasses authentication. Every visitor shares the same admin account, workspace, and files. Use it only on your computer or a trusted local network.

:::

{/* TODO(pathplanner-docs): Recapture this with the PathPlanner tab visible. */}
![Landing in the editor in demo mode, ready to pick a lesson](../website/static/img/screenshots/demo-mode-landing.png)

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/), running with the Compose plugin (`docker compose version`)
- [Git](https://git-scm.com/downloads)

## Start CodeRunner

Clone the repository:

```bash
git clone https://github.com/mathewdunne/CodeRunner coderunner
cd coderunner
```

Then start the demo for your platform:

<Tabs groupId="shell">
<TabItem value="linux" label="Linux / WSL2" default>

```bash
CODERUNNER_DOCKER_GID=$(stat -c '%g' /var/run/docker.sock) CODERUNNER_DEMO_MODE=1 docker compose up
```

`CODERUNNER_DOCKER_GID` is required on Linux and WSL2 so the control plane can access the Docker socket.

</TabItem>
<TabItem value="macos" label="macOS">

```bash
CODERUNNER_DEMO_MODE=1 docker compose up
```

</TabItem>
<TabItem value="powershell" label="Windows (PowerShell)">

```powershell
$env:CODERUNNER_DEMO_MODE = "1"; docker compose up
```

</TabItem>
<TabItem value="cmd" label="Windows (cmd)">

```bat
set "CODERUNNER_DEMO_MODE=1" && docker compose up
```

</TabItem>
</Tabs>

The first start may take a while while Docker downloads the workspace image. When the services are ready, open [http://localhost:4000](http://localhost:4000), then follow [Using CodeRunner](./using-coderunner.md): load a project, edit the code, click **Start** in the Driver Station, and click **Enable** when the robot is ready.

:::note[Why `workspace-template` exits]

Docker Compose may report that `workspace-template` exited with code 0. This is
expected: it is a short-lived helper that pulls the multi-gigabyte
workspace image during startup, so the first student does not have to wait for
it to download when they log in. The control plane starts a separate workspace
container from that image when needed.

:::

To stop CodeRunner, press `Ctrl-C`, then run:

```bash
docker compose down --remove-orphans
```

## Deploy for a team

Demo mode is only for evaluation. For individual logins and isolated student workspaces, continue to [Local Deployment](./deploying/local.md).
