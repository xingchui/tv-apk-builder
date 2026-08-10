# AGENTS.md

Android TV APK ("TVSearch") that searches ikanbot.com and plays videos. Single Gradle module (`:app`), pure Java (no Kotlin), Java 17, minSdk 21 / targetSdk 35, Media3/ExoPlayer 1.3.1 for playback.

## Build & verify

- Build APK: `.\gradlew assembleDebug` (works locally with Android SDK; Java 17 required)
- CI: pushing to `master` triggers `.github/workflows/build-apk.yml` → `assembleDebug` → uploads artifact `tv-search-apk`. No tests run in CI.
- Download CI artifact: `gh run download <run-id> --name tv-search-apk` (artifact name is `tv-search-apk`, NOT `app-release.apk`)
- APK output: `app/build/outputs/apk/debug/app-debug.apk`
- Commit style (from history): conventional prefixes — `feat:`, `fix:`, `cleanup:` with optional scopes like `(player)`, `(local-server)`

## Architecture

- **UI is a WebView app**, not native views: `MainActivity.java` loads `app/src/main/assets/index.html` from `file:///android_asset/`. Frontend = `index.html` + `styles.css` + `app.js` (plain JS, DPad navigation for TV remotes, Chinese UI text).
- **Scraping lives in Java, not JS**: `WebAppInterface.java` is exposed to the WebView as `Android` and implements `search()`, `getPlayInfo()`, `playVideoNative()`, `exitApp()`, `log()`. It scrapes ikanbot.com with Jsoup and computes the site's `v_tks` token (`computeToken()`).
- **Playback is native ExoPlayer**: `ExoPlayerActivity.java` (Media3) plays HLS/MP4 with custom `Referer`/`Origin` headers. `app.js` calls `Android.playVideoNative()` when the bridge exists; the HLS.js `<video>` path in `app.js` is ONLY a browser-testing fallback — do not try to fix WebView playback bugs, the native path is the production path.
- **Native ↔ JS playback bridge (watch history / resume / auto-next / volume on TV)**: `playVideoNative()` accepts `{url, title, resumeTime(sec), volume(0-1)}`; ExoPlayer seeks to `resumeTime` on `STATE_READY` and applies `volume` via `player.setVolume()`. When ExoPlayer stops mid-video (watched ≥5s, not in last 5s), `ExoPlayerActivity.onStop` writes `{url,title,positionMs,durationMs}` to SharedPreferences `tvsearch_playback/progress_json`; when a video ends it writes `ended_url`. `MainActivity.onResume` consumes these keys (delete-after-read) and forwards them to JS via `evaluateJavascript`: `window.onNativeProgressSaved(json)` → `saveHistoryEntry()` and `window.onNativePlaybackEnded(url)` → `playNextEpisode()` (auto-next only if the URL matches the episode currently believed playing). History stays in JS `localStorage` — Java only relays. The browser HLS.js fallback uses its own `ended`/timeupdate listeners instead; keep both paths consistent when changing history/autoplay logic.
- Manifest: `MainActivity` + `ExoPlayerActivity`, both landscape; `leanback` required feature; `network_security_config.xml` allows cleartext because video CDNs serve HTTP streams.

## Gotchas (hard-earned)

- **Video CDN requires `Referer: https://www.ikanbot.com/`** — set in `ExoPlayerActivity.java` (`DefaultHttpDataSource.Factory.setDefaultRequestProperties`) and in app.js HLS.js `xhrSetup`. Missing it = playback failure.
- **The `v_tks` token algorithm is duplicated in 3 places** — `WebAppInterface.computeToken()` (Java), `local-server.py compute_token()` (Python), `test-scraping.mjs` (Node). If ikanbot changes it, update ALL THREE or browser testing diverges from the app.
- **ExoPlayer API**: custom data source must be set via `new ExoPlayer.Builder(...).setMediaSourceFactory(new DefaultMediaSourceFactory(dataSourceFactory))` — `player.setMediaSourceFactory()` does NOT exist (caused CI compile failures).
- WebView uses a spoofed Chrome/Android TV user agent (`MainActivity.java`) — keep it consistent with the UA used in `WebAppInterface` scraping.
- `MainActivity.onKeyDown` intercepts BACK and dispatches a synthetic `keydown` to the page; app.js handles `Back`/`Escape` for navigation. Don't add a second BACK handler.
- `.apk`, `.codegraph/`, `.omo/`, `.playwright-cli/` are gitignored; `out/` holds downloaded CI artifacts.

## Dev workflow (no TV needed)

- **Browser testing**: `python local-server.py` (stdlib only) serves the same `assets/` files at `http://localhost:8080` + `/api/search?q=` and `/api/play?url=` endpoints mirroring the Java bridge. Without the `Android` bridge, app.js falls back to these endpoints.
- **Scraping verification**: `cd test-scraping && node test-scraping.mjs [query]` — independently replicates the Java scraping logic against the live site (search → play page → token → API → HLS URLs).
- UI/styling changes are edited in `assets/` and tested via local-server; Java changes require a full build.
