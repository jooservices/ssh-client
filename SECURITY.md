# Security

## Reporting a vulnerability

Do **not** open a public issue. Report privately to
<jooservices@gmail.com>.

## Threat model

This library will hold **SSH credentials** and open sessions to network hosts.
It must:

- Pin SSH host keys by default (reject MITM)
- Never log passwords or private key material
- Prefer management on a trusted LAN

## Operator guidance

- Put secrets in `.env` (chmod 600, gitignored); use `.env.example` as a template
- Set `hostFingerprint` for every non-test connection
- Prefer short `commandTimeoutMs` / optional `idleTimeoutMs` so hung shells fail closed
- Never enable `insecureSkipVerify` against untrusted networks
