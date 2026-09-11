# Contributing

## Development setup

The web service uses Node.js 22 or later and has no runtime npm dependencies.
FFmpeg and FFprobe are required for recording playback tests.

```bash
cd app
npm test
```

Before submitting a pull request, also run:

```bash
node --check app/server.js
node --check app/public/app.js
bash -n pi/install.sh pi/install-control.sh scripts/check-stack.sh
PYTHONPYCACHEPREFIX=/tmp/homecam-pycache python3 -m py_compile pi/homecam-control.py
docker compose config
```

## Pull requests

- Keep changes focused and preserve the Pi, media server, and web ownership
  boundaries.
- Add or update tests for playback, proxy, authentication, and path handling
  changes.
- Do not commit recordings, `.env` files, credentials, private addresses, or
  deployment-specific paths.
- Explain any manual hardware or browser verification in the pull request.
- Update README and configuration examples when behavior changes.

By contributing, you agree that your contribution is licensed under the
Apache License 2.0.
