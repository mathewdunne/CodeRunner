---
sidebar_position: 1
title: Privacy Policy
---

# Privacy Policy

**Last updated: September 30, 2026**

CodeRunner is a self-hosted, browser-based IDE for teaching FRC robot programming. This
policy explains what personal information CodeRunner handles, why, and what is done with it.

## Who this policy covers

CodeRunner is open-source software that schools and robotics teams install and run on their
own hardware. Each installation is operated independently.

- **For the instance you use.** The organization that runs your instance — your school,
  robotics team, or mentor — decides who may sign in, controls the server, and is
  responsible for the data on it. They configure their own Google and GitHub OAuth
  credentials.
- **For the CodeRunner project.** The project maintainers publish the software and this
  documentation. They do not operate your instance, cannot see your data, and receive no
  data from installations.

This policy describes how the software behaves. An operator may publish additional terms of
their own.

## What information is collected

**Account information from sign-in.** CodeRunner supports signing in with Google or GitHub.
It requests only basic profile scopes — for Google, `openid`, `email`, and `profile`. From
that, it stores:

- your Google or GitHub account identifier
- your email address
- your display name
- your profile picture URL

These fields refresh from the provider each time you sign in.

CodeRunner requests **no** access to Gmail, Drive, Calendar, Contacts, your repositories, or
any other Google or GitHub data. It cannot read your mail, files, or private code.

**Classroom guests.** If you join with a classroom code, CodeRunner stores the
name you enter and links your guest account to that classroom. You do not need
a Google or GitHub account.

**Work you create.** The Java code, project files, and lesson progress in your workspace are
stored on the operator's server.

**Operational records.** The server keeps a session record so you stay signed in, a log of
administrative actions (recording the acting user's ID and email, the action, and its
target), and standard application logs.

## How the information is used

The information you provide is used only to run the service:

- to identify you across sessions and keep you signed in
- to check your email against the operator's allowlist, or your code against
  an active classroom
- to derive your workspace name and provision your personal container
- to display your name and picture in the interface
- to let administrators of that instance see who has an account and what administrative
  actions were taken

## What is not done with it

- It is **never sold, rented, or traded**.
- It is **not used for advertising** or ad targeting, and not shared with data brokers.
- There are **no third-party analytics or tracking services** in the application.
- It is **not shared** with anyone outside the operator of your instance, except where the
  operator is legally required to disclose it.
- It is **not used to train machine learning or AI models**.

CodeRunner's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Where information is stored

Everything stays on the server your operator runs. Account records, sessions, and audit
entries live in a SQLite database on that machine; your code lives in a directory on the same
machine. Nothing is sent to a CodeRunner-operated service, because there isn't one.

Your operator is responsible for securing that server, and for any backups they choose to
make.

## How long it is kept

Google and GitHub sign-in sessions last up to 14 days and refresh as you use
the app. Those account records and workspaces persist until an administrator
deletes them or removes the instance. Classroom guest sessions end with the
classroom. Guest accounts and workspace files are then deleted from the live
server. Audit entries and any operator backups may remain.

Note that some ordinary actions **intentionally discard** your workspace contents: switching
or resetting a lesson module, or importing a repository, replaces what was there. Use Git for
work you need to keep. See the [Terms of Service](./terms.md).

## Your choices

- **Stop sharing.** If you signed in with Google or GitHub, you can revoke
  CodeRunner's access from your
  [Google Account permissions page](https://myaccount.google.com/permissions) or GitHub
  application settings. Doing so prevents future sign-ins.
- **Access or delete your data.** Contact your instance's administrator. They can delete your
  account and workspace from the server.

## Children's privacy

CodeRunner is built for FRC teams, so many users are minors. It is deployed by schools and
robotics programs, and students use it under the supervision of that program. Students can
sign in with an allowed Google or GitHub account, or join a time-limited classroom with a
code and a name. If you are a parent or guardian with questions about a particular instance,
contact the operating school or team.

## Changes to this policy

Material changes will be reflected here with an updated date above. The revision history is
public in the
[project repository](https://github.com/mathewdunne/CodeRunner/commits/main/docs/legal/privacy.md).

## Contact

For questions about the CodeRunner software or this policy, open an issue at
[github.com/mathewdunne/CodeRunner/issues](https://github.com/mathewdunne/CodeRunner/issues).

For questions about a specific installation and the data on it, contact the school, team, or
mentor who operates it.
