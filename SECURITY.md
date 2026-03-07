# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅ Yes    |

## Reporting a Vulnerability

**Please do not report security vulnerabilities via public GitHub issues.**

Instead, report them privately via [GitHub Security Advisories](https://github.com/sebmuc99/Ghost-Media-Manager/security/advisories/new).

Include as much detail as possible:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

You will receive a response within **72 hours** acknowledging receipt. We aim to
release a fix within **14 days** of a confirmed vulnerability.

## Security Considerations

Ghost Media Manager runs as a self-hosted container and requires a valid
Ghost Admin API key for every request. It is intended to be run on a private
network or behind a reverse proxy with authentication.

**Do not expose port 3334 directly to the public internet without additional
authentication** (e.g. Nginx basic auth, VPN, or Cloudflare Access).

## Dependency Scanning

Dependencies are monitored via [Dependabot](https://github.com/sebmuc99/Ghost-Media-Manager/security/dependabot).
Security advisories for npm packages are automatically raised as PRs.
