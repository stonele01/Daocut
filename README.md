<p align="center">
  <img src="docs/logo-light.svg#gh-light-mode-only" alt="Daocut" height="72">
  <img src="docs/logo-dark.svg#gh-dark-mode-only" alt="Daocut" height="72">
</p>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>

# Daocut

Daocut is a local AI video editing workspace for livestream product clips. It combines a timeline editor, agent chat, product analysis and reusable video plans. The Windows company edition adds employee accounts, feedback and optional company-hosted updates. Model keys and personal projects stay on each user's computer.

## Product workflow

1. Use **Transcribe and discover products** to prepare a livestream. Product names and ranges can be corrected; saved manual ranges determine subsequent analysis.
2. Select one occurrence and analyze its speech. Saved analysis is reused; returning lectures are separate selections.
3. Compose plans with a product introduction, selling point, current quoted price and purchase close. Price and benefits are separate. Each opening has at most three substantively different plans, fewer when material is insufficient.
4. Preview plans in the right panel. Preview leaves the timeline unchanged; **Edit this plan** opens an independent personal draft. Each draft keeps its own edits when switching or reopening.
5. Select plans and use the existing export dialog to export separate Jianying drafts. Personal drafts take priority.

The editor also supports footage, images, audio, HTML scenes, subtitles and its existing export formats. A project is a folder containing `film.html` and its assets; see the [manual](packages/daocut/MANUAL.md) and [film format](packages/daocut/SPEC.md).

Current version: **0.2.51**. Packaged tests and actual desktop playback, seeking, subtitle reopening and a real analysis/composition sample have been checked. Broader machine, long-video and shared-storage coverage remain release acceptance work. See the [release handoff](docs/HANDOFF-0.2.51.md) for the exact scope and [development guide](docs/DEVELOPMENT.md) for implementation paths.

## Use or develop

Employees should use the installer supplied by their administrator. Deployment instructions are in the [company release guide](docs/DAOCUT-COMPANY-RELEASE.md) and [company service guide](apps/company-service/README.md).

For source development, use Node 24 (minimum 22.18), pnpm 9.15.9, Git, FFmpeg and ffprobe:

```sh
git clone https://github.com/stonele01/Daocut.git
cd Daocut
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
```

Before starting Studio or the desktop app, configure a separate project library, shared home, exports directory and port as described in [CONTRIBUTING.md](CONTRIBUTING.md). Development defaults can otherwise reuse an existing project library. Use mock responses and synthetic media for tests.
