# Security Policy

## Supported versions

Security fixes are applied to the latest release. Pre-release versions may
change configuration or storage formats without backward-compatibility
guarantees.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting feature from the repository Security tab. Include:

- the affected version or commit;
- deployment topology and exposed ports;
- reproduction steps;
- expected and actual behavior;
- any suggested mitigation.

Avoid attaching real recordings, credentials, IP addresses, or exported
configuration files. Replace them with synthetic examples.

## Deployment boundary

HomeCam is intended for a trusted LAN, VPN, or authenticated HTTPS reverse
proxy. It does not provide TLS and must not be exposed directly to the public
internet. Rotate all credentials if a `.env` file, Pi environment file, or
controller token is disclosed.
