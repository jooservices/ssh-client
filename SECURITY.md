# Security

## Reporting a vulnerability

Do **not** open a public issue. Report privately to
<jooservices@gmail.com>.

## Threat model

This package will hold **router admin credentials** and open an SSH session to
a Vigor 3912S on a trusted LAN. It must:

- Pin SSH host keys (reject MITM)
- Never log passwords or private key material
- Keep management traffic off the public Internet by default

## Non-goals

- MCP confirm gates / AI tool policy (belong in `vigor3912s-mcp`)
- Typed CLI command catalogs (belong in `vigor3912s-sdk`)
