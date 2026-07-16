# Markdown Editor

A live, side-by-side Markdown editor. Raw monospace on the left, GitHub-styled
preview on the right, with a draggable divider, light/dark toggle, multi-file
support, autosave, upload, and `.md` download. Everything persists to
`localStorage`. Built with Vite + React + Tailwind + shadcn/ui, and packaged as
a lightweight desktop app with Electron.

## Download

Grab the latest desktop build from the
[**Releases**](https://github.com/Jumballaya/md-editor/releases) page:

| Platform | File |
| --- | --- |
| macOS | `.dmg` (installer) or `.zip` |
| Windows | `.exe` (installer) or `portable .exe` |
| Linux | `.AppImage` or `.deb` |

> macOS builds are unsigned. On first launch, right-click the app → **Open**, or
> allow it under System Settings → Privacy & Security.

## Develop

```bash
npm install
npm run dev          # web dev server on http://localhost:8080
npm run electron:dev # build web assets and launch the desktop app
```

## Build desktop packages locally

```bash
npm run dist   # builds installers for your current OS into ./release
```

## Releasing

Releases are automated. Push a version tag and GitHub Actions builds macOS,
Windows, and Linux packages and attaches them to a GitHub Release:

```bash
npm version patch      # bumps package.json + creates a git tag
git push --follow-tags
```

The `.github/workflows/release.yml` workflow runs on any `v*` tag (and via
manual dispatch for a dry run without publishing).
