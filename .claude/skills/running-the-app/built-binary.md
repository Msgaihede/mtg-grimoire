# Launching a built binary

Read this only when you are measuring a **release path**. For everything else use
`npm run tauri dev`, which has none of the three traps below — `SKILL.md` carries that
recipe.

```powershell
Get-Process mtg-grimoire -ErrorAction SilentlyContinue   # must be empty
(Get-Item src-tauri\src\main.rs).LastWriteTime = Get-Date
npm run tauri build -- --debug --no-bundle
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
$proc = Start-Process "src-tauri\target\debug\mtg-grimoire.exe" -PassThru
pwsh -NoProfile -File $L adopt app -ProcessId $proc.Id
```

`Start-Process -PassThru` hands you the app's own pid here — unlike dev mode, where the
exe is a grandchild — so adopting `$proc.Id` is correct.

Two traps, both measured:

- **A frontend-only edit does not reach a built binary.** `tauri build` re-runs Vite,
  then cargo sees no Rust change and leaves the old bundle inside the old exe — and
  exits 0. Touching `main.rs` first is what forces the relink. The cheap tell is
  `[...document.querySelectorAll('script')].map(s => s.src)` against `ls dist/assets`.
- **The exe cannot be relinked while it runs** — `Access is denied. (os error 5)`. Stop
  it first.
