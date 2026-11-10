# Daocut core

The `daocut` package contains the film format, CLI, rendering tools and Studio editor. Projects combine footage, images, audio and HTML scenes in `film.html`; Studio also provides product analysis, structure plans and independent drafts.

## From source

See the repository [development guide](../../docs/DEVELOPMENT.md) and [contributing instructions](../../CONTRIBUTING.md) for dependencies, isolated configuration and tests. Build the editor from the repository root:

```sh
pnpm --filter daocut build:ui
```

The source CLI is `node packages/daocut/bin/daocut.mjs`. Its commands include:

| Command | Purpose |
| --- | --- |
| no command | Print the agent manual |
| `open [folder]` | Open a project in Studio |
| `look [what] [t or a-b]` | Inspect film, scene or media frames |
| `render [a-b]` | Render a film or range |
| `get` | List configured media generation/transcription capabilities |
| `doctor` | Report local runtime diagnostics |

Use `--help` for each command's options. Configure isolated directories before opening projects; media-provider operations may call the services configured by the user.

The [manual](MANUAL.md) describes editing and CLI usage; [SPEC.md](SPEC.md) defines the film format. Source and support: [stonele01/Daocut](https://github.com/stonele01/Daocut).

## License

MIT licensed; see the repository [LICENSE](../../LICENSE) and this package's [third-party notices](THIRD_PARTY_NOTICES.md). Applicable upstream trademark notices are retained in [TRADEMARK.md](TRADEMARK.md).
