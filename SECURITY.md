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

The AI control plane uses `AI_ORCHESTRATOR_TOKEN`. It binds to localhost by
default; a remote GPU worker requires an explicit trusted LAN or VPN bind plus
firewall restrictions. The browser must access AI data through the authenticated
HomeCam web gateway and must never receive the internal token.

Face identity and raw person detection are local-only policies. A real external
provider adapter must add explicit opt-in, input minimization or redaction,
transport encryption, and documented provider retention controls before use.
The generic HTTP JSON adapter requires HTTPS and keeps
`EXTERNAL_PROVIDER_TOKEN` inside the worker process.
