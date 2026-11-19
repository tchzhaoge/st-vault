# Security and data protection

[简体中文](SECURITY.md) · **English**

ST-Vault is a personal, single-administrator application, not a multi-tenant service, and has not undergone an independent security audit. Limit access to the local host or trusted networks; use HTTPS and restrict remote entry points.

## Authentication and credentials

- Initial setup sets and confirms a six-digit PIN before entering the workbench. Connecting a site account is an optional later action. A restricted setup authorization cannot read account data, media or administrative APIs.
- PINs use a random salt and scrypt. Verification has persistent failure counts and source rate limits. Six digits are still unsuitable for public exposure; prevent another user from claiming initial setup. Existing password installations verify the old password before migration.
- Administrator sessions use HttpOnly, SameSite=Strict cookies with a default seven-day lifetime. Logout revokes the current client's session. The local PIN and site account are independent.
- Site login, one-time codes and human verification happen in the user's own browser. Only exported cookies are pasted; ST-Vault does not accept site passwords or replace verification.
- Cookies are used only for account information and the following list. Status, HLS and media requests are anonymous and grant no private/paid-content access.
- Saved cookies and manual keys use purpose-separated AES-256-GCM encryption, with the master key under data/private. Routine status APIs do not return saved values. Only an explicit administrator disconnect returns the former cookies once in a non-cacheable HTTPS/private-LAN-IP/loopback response for reconnecting. Cookie drafts are stored unencrypted in localStorage for this browser and ST-Vault origin, surviving reloads and local administrator logout until manually cleared or the site changes. Use a trusted browser profile; clearing browser data also removes drafts. Disconnecting deletes credentials, archives broadcasters and stops recording while retaining media.

Compose binds 127.0.0.1:10002 by default. Public IPs and DNS names require HTTPS. Private LAN IPs allow HTTP, exposing PINs, cookies and sessions in plaintext; use only on a trusted LAN. Reverse proxies must preserve Host and support SSE. `STV_SECURE_COOKIE=1` does not create certificates or TLS and cannot substitute for encrypted transport.

## Storage boundaries

PostgreSQL listens only on an application-private Unix socket; port 5432 is not mapped. Database storage must be reliable and local, not SMB/NFS. Only one instance may write a library. State directories and backups include sensitive settings and need restricted permissions. Anyone controlling the host or application process can still access data; media has no application-level encryption at rest.

Stop writes before backing up complete data and media. Moving only media can rebuild indexes for browsing and management, but does not restore PINs, cookies or private keys; initialize them again. Do not copy isolated PostgreSQL tables, WAL fragments or a single journal as a complete backup. See the [user guide](../README.en.md#backups-recovery-and-updates).

Shorter retention and manual deletion permanently reclaim media. Favorites protect automatic retention cleanup, not explicit manual deletion. Space thresholds, retries and recovery do not replace backups or guarantee uninterrupted recording on every system/network.

## Reporting and dependencies

Do not publicly share cookies, tokens, full request headers, HAR files, databases or private recordings. Use the repository's private vulnerability-reporting entry point when enabled; otherwise use a private channel explicitly published by the maintainer. No unpublished email address, response deadline or historical-version support is promised.

Include the affected commit, deployment method, minimal reproduction and sanitized error codes. CI checks production dependencies for high/critical advisories, but results are snapshots, not proof that no unknown vulnerabilities exist. Development tools are not included in runtime. See [third-party notices](third-party.en.md) for licenses.
