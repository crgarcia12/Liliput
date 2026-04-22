# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please report vulnerabilities via [GitHub Security Advisories](../../security/advisories/new). This allows us to assess the risk and create a fix before public disclosure.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment:** Within 48 hours of your report
- **Assessment:** Within 5 business days
- **Fix:** Depending on severity, typically within 30 days

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | ✅        |

## Security Best Practices for Users

This is a **template repository**. When using it to build your own application:

- **Never commit secrets** — use environment variables and Azure Key Vault
- **Set `JWT_SECRET`** — always provide a strong, random JWT secret via environment variables; the app will refuse to start without one
- **Review Bicep templates** — customize `infra/` for your security requirements before deploying
- **Enable HTTPS** — Azure Container Apps provides TLS by default
- **Keep dependencies updated** — run `npm audit` regularly
