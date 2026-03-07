# Contributing

## Development Setup

```bash
git clone https://github.com/sebmuc99/Ghost-Media-Manager.git
cd Ghost-Media-Manager
npm install
cp .env.example .env
# Edit .env with your Ghost URL and API key
node server.js
```

Open http://localhost:3334

## Project Structure

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full
technical overview before making changes.

## Critical Rules

Before touching any post update logic, read the
**Critical Rules** section in ARCHITECTURE.md.
Incorrect Lexical JSON handling will corrupt Ghost posts.

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run syntax check: `node --check server.js && node --check public/app.js`
5. Test the key workflows from the test checklist
6. Open a pull request against `main`

## Reporting Bugs

Use the [GitHub issue tracker](https://github.com/sebmuc99/Ghost-Media-Manager/issues).
Include Ghost version, Ghost Media Manager version, and relevant logs.
