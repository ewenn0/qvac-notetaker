# Build resources

electron-builder reads packaging assets from this directory
(`directories.buildResources: build`).

## App icons

Drop the following files here. electron-builder picks them up automatically —
no path config needed in `electron-builder.yml`.

| File | Platform | Spec |
|---|---|---|
| `icon.ico` | Windows | multi-size .ico, include 256×256 |
| `icon.icns` | macOS | .icns, up to 1024×1024 |
| `icon.png` | Linux | 512×512 (or 1024×1024) PNG |

The fastest way to generate all three from one square master PNG (≥1024×1024):

```bash
npx electron-icon-builder --input=./build/icon-master.png --output=./build
# or use https://www.electron.build/icons
```

A placeholder `icon.png` is checked in so unsigned local builds succeed; replace
it (and add `icon.ico` / `icon.icns`) with real artwork before shipping.

## Code signing & notarization

Secrets are supplied via environment variables, never committed:

- **Windows:** `CSC_LINK` (path/URL to `.pfx`) and `CSC_KEY_PASSWORD`.
- **macOS:** `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
  (plus a Developer ID certificate in the keychain or via `CSC_LINK`).

With those unset, `npm run build:win` / `build:mac` still produce an unsigned
installer for local testing.
