# Release engineering

The application and release use the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`; keep all three synchronized. Commit lockfile changes. Add `docs/releases/vVERSION.md` and update `CHANGELOG.md`.

## Required secrets

- `TAURI_SIGNING_PRIVATE_KEY`: new Slate Music updater private key, stored only in GitHub encrypted Actions secrets and a protected local backup.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: only required for a password-protected key.

The public counterpart is embedded in `tauri.conf.json`. Never casually regenerate or replace it: installed versions must trust the key that signs future updates. This key does not establish a Windows Authenticode publisher identity. To eliminate unknown-publisher prompts, the owner must separately supply an appropriate code-signing certificate/service and configure the bundle signing step.

## Automated releases

1. Run tests and packaged-app checks. Commit all source and documentation.
2. Create a lightweight version tag at the exact source commit and push the branch and tag.
3. `.github/workflows/release.yml` tests, builds the NSIS installer, signs it, prepares `latest.json` and checksums, and publishes a GitHub Release.
4. Verify anonymous access to `releases/latest/download/latest.json`, installer hashes and a real installed client's update check.

Released artifacts are immutable. The workflow refuses to overwrite an existing release. Use a new version for fixes. Public repository visibility is required for anonymous default update downloads.

To verify hosted compilation and signing for an existing version, manually run **Signed Windows release** from `main`, set `source_ref` to its tag (for example `v1.0.1`), and leave `verify_only` enabled. This runs tests, builds and signs the exact tagged source, and uploads the results as a workflow artifact. Publication is skipped. For a new release, push its version tag normally; publication verifies that the tag points to the exact built commit.

## Local release fallback

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = '<path to private key outside the repository>'
npm run build:app
node tools/release.mjs prepare
git tag v1.0.0
git push origin main v1.0.0
node tools/release.mjs publish
```

Do not run local publication concurrently with the tag workflow. `prepare` requires a clean committed tree and records its commit and artifact hashes in `../release/build.json`. `publish` verifies them against the current tree and remote tag before creating a draft, uploading assets, then publishing it. Git Credential Manager or `GITHUB_TOKEN` supplies authentication internally; the token is never logged. `SLATE_RELEASE_DIR` overrides the output directory.

Installer files, `.sig`, `latest.json` and SHA256 checksums are public release assets. Private profiles, artwork caches, original music, Spotify credentials and signing keys must never be attached.

## Update validation

`tools/tauri.qa.json` enables loopback HTTP for a debug build only. `verify_update_fixture` downloads a local signed installer and verifies its signed version. Test valid data, a modified executable and a modified manifest version. The production build rejects this test command and uses HTTPS. Also test a per-user install, exit/restart, and reinstall over the same version while retaining the database. A true future-version production upgrade can only be tested once a second version exists.
