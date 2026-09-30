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
- Set `hostFingerprint` for every non-test connection. A mismatch fails with `hostkey`
- `exec` sends one line and rejects control characters. It does not quote or sandbox the remote shell — escape untrusted data before passing it in
- The password is kept in private fields and is not shown by `util.inspect` or `JSON.stringify`. Do not log the client, command strings, or session options
- Prefer short `commandTimeoutMs` / optional `idleTimeoutMs` so hung shells fail closed
- Never enable `insecureSkipVerify` against untrusted networks. It is a lab and test hatch only
