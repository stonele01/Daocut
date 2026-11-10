# Security

Studio is a server on your machine: it reads and writes your projects and keeps the keys of the media services you
connect. It listens on 127.0.0.1 only, and answers the CLI and its own pages with a key it makes at launch.

## Reporting

Report Daocut issues to [this repository](https://github.com/stonele01/Daocut). If **Security → Report a
vulnerability** is available, use that private reporting form. If it is unavailable, open an issue asking the
maintainer for a private reporting channel, without including vulnerability details, credentials or private data.

Once a private channel is agreed, include what you found, how to reproduce it, and the Daocut version
(`daocut --version`) or source commit. Do not attach real project files or provider keys.

See the [development guide](docs/DEVELOPMENT.md) for the current implementation and validation scope.
