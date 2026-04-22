# Contributing to spec2cloud

Thank you for your interest in contributing! This document provides guidelines for contributing to the spec2cloud shell template.

## Getting Started

1. Fork the repository
2. Clone your fork and install dependencies:
   ```bash
   npm install
   cd src/web && npm install && cd ../..
   cd src/api && npm install && cd ../..
   ```
3. Create a feature branch: `git checkout -b my-feature`

## Development

### Running locally

```bash
npm run dev:aspire        # Recommended: all services via Aspire
npm run dev:all           # Alternative: API + Web + Docs concurrently
```

### Running tests

```bash
npm run test:api          # Unit tests (API)
npm run test:cucumber     # BDD tests (requires Aspire)
npm run test:e2e          # End-to-end tests (requires Aspire)
npm run test:all          # All tests
```

### Building

```bash
npm run build:all         # Production build (API + Web)
```

## How to Contribute

### Reporting Issues

- Use GitHub Issues to report bugs or suggest features
- Include reproduction steps, expected behavior, and actual behavior
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

### Submitting Changes

1. Ensure your changes pass all existing tests: `npm run test:all`
2. Add tests for new functionality
3. Follow existing code style and conventions
4. Write clear commit messages
5. Submit a pull request with a description of what changed and why

### Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Update documentation if your changes affect user-facing behavior
- Ensure CI passes before requesting review

## Code Style

- **TypeScript strict mode** — no `any` types, explicit null checks
- **Naming** — camelCase for variables/functions, PascalCase for types/interfaces, kebab-case for files
- **Testing** — all code must be covered by tests
- **Comments** — only when code intent is non-obvious

## Skills

Agent skills live in `.github/skills/` and follow the [agentskills.io](https://agentskills.io) specification. If you're contributing a new skill:

1. Use the `skill-creator` skill as a guide
2. Include a `SKILL.md` with proper YAML frontmatter
3. Add tests or verification steps

## License

By contributing, you agree that your contributions will be licensed under the [ISC License](LICENSE).
