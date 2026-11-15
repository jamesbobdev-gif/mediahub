# Keeping Media Hub running, on your own

Everything you need to keep the hub going without anyone's help: where things are, the handful of
commands that matter, what to back up, what to do when something breaks, and how to change the code
yourself. [SETUP.md](SETUP.md) is the first install; this is the page for every day after.
[ARCHITECTURE.md](ARCHITECTURE.md) explains how it works inside, [CONTROL.md](CONTROL.md) how a
local model or a script drives the TVs, [TESTING.md](TESTING.md) what was tried with real sources.

Contents: [The machines](#the-machines) · [Every day](#every-day) · [Updating](#updating) ·
[The files that are yours](#the-files-that-are-yours) · [Backing up and restoring](#backing-up-and-restoring) ·
[The TV app](#the-tv-app) · [Pi-hole](#pi-hole) · [If the Pi has to be rebuilt](#if-the-pi-has-to-be-rebuilt) ·
[Changing the code yourself](#changing-the-code-yourself) · [When something breaks](#when-something-breaks) ·
[Still to do](#still-to-do)

## The machines

| What | Where | Notes |
|---|---|---|
| The hub | A Raspberry Pi, user `pi`, code in `~/mediahub`, running as the `mediahub` service | Two addresses when both Wi-Fi and the cable are up: the Wi-Fi one is what the TV app and the docs use; the wired one is the steadier for SSH. Find both with `hostname -I` on the Pi. |
| The hub's pages | `http://<pi>:8787` is the TV app and the API; `http://<pi>:8788` serves the sites through the proxy | Never forward either port on the router. |
| Pi-hole (if installed) | `http://<pi>/admin` on the same Pi | Set its password once with `sudo pihole setpassword`. |
| The TV | A Fire TV Stick with the Media Hub app, or any TV browser pointed at `http://<pi>:8787` | The app has the Pi's address baked in at build time ([The TV app](#the-tv-app)). |
| This repository | `github.com/jamesbobdev-gif/mediahub`, branch `main` | The Pi follows `main`; the Pi's own `config/` is kept out of updates. |

Reserve the Pi's and the TV's addresses in the router so they never change. Until they are reserved,
a new address means the TV app has to be rebuilt with the new one and `config/access.json` updated.

## Every day

Connect first: `ssh pi@<pi>` (SETUP.md, Step 1). Then:

| What | Command |
|---|---|
| Is it running | `systemctl status mediahub` |
| Live log | `journalctl -u mediahub -f` (Ctrl+C to stop) |
| Last 50 log lines | `journalctl -u mediahub -n 50` |
| Restart | `sudo systemctl restart mediahub` |
| Restart without a sudo password prompt (from a script) | `kill $(systemctl show -p MainPID --value mediahub)`; the service starts itself again within seconds |
| Stop / start | `sudo systemctl stop mediahub` / `sudo systemctl start mediahub` |
| Catalog size, pulls per source, what was blocked, cache | `curl http://<pi>:8787/api/status` |
| What the TV did on its last visit | `curl http://<pi>:8787/api/trace` |
| Pull every source's feed now | `curl -X POST http://<pi>:8787/api/ingest/run` |
| The TVs that are on, and what each shows | `curl -H "Authorization: Bearer <token>" http://<pi>:8787/api/tv` ([CONTROL.md](CONTROL.md)) |
| Free space on the Pi | `df -h /` |

Nothing here needs a restart to take effect except code changes: the three config files reload on save.

## Updating

```bash
cd ~/mediahub && git pull && sudo systemctl restart mediahub
```

If `git pull` complains about `config/sources.json`, your sources file has edits the repository does
not know about. Tell git once to leave it alone, then pull again:

```bash
cd ~/mediahub && git update-index --skip-worktree config/sources.json && git pull
```

Do the same for `config/access.json` once it holds your allow-list or control token. After an update,
`systemctl status mediahub` should say `active (running)`; if not, the log says why.

## The files that are yours

Everything the hub knows about your setup is in two folders on the Pi. Nothing else is yours.

| File | Holds | Reloaded |
|---|---|---|
| `~/mediahub/config/sources.json` | Your sources: name, address, start page, allowed hosts, feed. The Settings screen on the TV writes it; you may edit it by hand. | On save |
| `~/mediahub/config/access.json` | `allowClients` (which devices may use the hub; empty = all) and `controlToken` (the word a local model needs to drive the TVs) | On save |
| `~/mediahub/config/filters.json` | What the proxy blocks: hosts, paths, ad sizes. Rarely edited. | On save |
| `~/mediahub/data/catalog.sqlite` | The catalog, rebuilt from the feeds. Safe to delete; it fills again within minutes. | |
| `~/mediahub/data/artwork/` | Posters, downloaded again when missing. Safe to delete. | |
| On the TV itself | Resume positions, what was watched lately, the TV's name and id for the hub, sites that need the front-door route | Kept by the TV's browser |

Editing on the Pi: `nano <file>`, Ctrl+O to save, Ctrl+X to leave. A broken JSON file is ignored with
"config reload failed (keeping previous)" in the log, and the hub keeps the last good version.

## Backing up and restoring

The two config files are the whole backup. From your PC, once in a while:

```bash
scp pi@<pi>:~/mediahub/config/sources.json pi@<pi>:~/mediahub/config/access.json .
```

To restore onto a fresh Pi: install the hub (SETUP.md, Step 2), copy the two files back with `scp`
the other way, and the hub reloads them on its own. The catalog and posters rebuild themselves.

```bash
scp sources.json access.json pi@<pi>:~/mediahub/config/
```

## The TV app

The Fire TV and Android TV app is a thin wrapper that opens the hub; all the logic is on the Pi, so
the app only needs rebuilding when the Pi's address changes or a new remote key must pass through.
`android/README.md` has the build and install steps in full. In short, on a PC with Android Studio:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd android
.\gradlew.bat assembleRelease -PhubUrl=http://<pi>:8787/
adb connect <tv>
adb install -r app\build\outputs\apk\release\app-release.apk
```

To give the TV a name of its own on the hub (it shows in `/api/tv` and in a model's answers), build with
`?tv=` in the address once: `-PhubUrl="http://<pi>:8787/?tv=Living%20room"`. The TV keeps the name.

Two things learned the hard way: `adb` from a Git Bash window mangles `/sdcard/...` paths unless
`MSYS_NO_PATHCONV=1` is set, and `adb exec-out` piped through PowerShell corrupts binary files, so
take screenshots with `adb shell screencap -p /sdcard/x.png` and then `adb pull`.

## Pi-hole

SETUP.md, Step 6 covers installing Pi-hole on the same Pi so the stick's own reporting goes nowhere.
Day to day:

| What | Command or place |
|---|---|
| The page | `http://<pi>/admin` |
| Set or change its password | `sudo pihole setpassword` |
| Update the block lists | `pihole -g` |
| Update Pi-hole itself | `pihole -up` |
| See what a device asked for | Query Log on the page |

The stick only uses it once its DNS points at the Pi: on the TV, forget the Wi-Fi network and rejoin
it with Advanced settings, DNS 1 = the Pi's address. That step needs the Wi-Fi password, so nobody
can do it for you.

## If the Pi has to be rebuilt

* Flash Raspberry Pi OS Lite **64-bit** with Raspberry Pi Imager, SSH on, user `pi`.
* A Pi 5 on a 3 A power supply will not boot from a USB stick until `usb_max_current_enable=1` is
  under `[all]` in `config.txt` on the boot partition. Without it the Pi sits with a solid green light
  and a dark network jack.
* Run the one-command installer (SETUP.md, Step 2), put your two config files back
  ([Backing up and restoring](#backing-up-and-restoring)), set the token if you use the control
  channel ([CONTROL.md](CONTROL.md)), and reinstall Pi-hole if you had it (SETUP.md, Step 6).
* If the Pi's address changed, rebuild the TV app with the new one.

## Changing the code yourself

The hub is one Node 22 program with no dependencies, so there is nothing to install beyond Node.

| What | How |
|---|---|
| Get the code on a PC | `git clone https://github.com/jamesbobdev-gif/mediahub.git` |
| Run it on the PC | `npm start`, then open `http://127.0.0.1:8787` in a browser; arrow keys and Enter are the remote |
| Run the tests | `npm test` (a hundred or so, a few seconds) |
| Find your way around | `ARCHITECTURE.md`, then the comment at the top of each file |
| Change something | Edit, `npm test`, try it in the browser, then `git commit` and `git push` to `main`, then [Updating](#updating) on the Pi |
| Add a source without the TV | Add an entry to `config/sources.json` (the README shows the shape), or `POST /api/sources` with `{"name": "...", "address": "..."}` |

The most common change is allowing a host a site needs: the TV's Settings screen does it, and so does
`POST /api/sources/<id>/allow` with `{"host": "cdn.example.com"}`. The most common breakage after a
site redesign is a feed that stops matching; the fix is a new `feed` block for that source, and
`npm run ingest` on a PC shows what a feed yields before you put it on the Pi.

If you want help from a model without paying for one, any Ollama model on your PC can read this
repository: give it `ARCHITECTURE.md`, the file you are changing, and the failing test's output.
A model that can call a URL can also run the hub for you through [CONTROL.md](CONTROL.md).

## When something breaks

Work down the list; each line is one check.

1. `systemctl status mediahub` on the Pi. Not running: `journalctl -u mediahub -n 50` says why; a
   broken config file or a half-finished update are the usual causes.
2. `http://<pi>:8787/api/status` from a PC. No answer: the Pi's address changed, or Wi-Fi dropped;
   try the wired address, and `ping <pi>`.
3. The TV shows "This device is not allowed": its address is not in `allowClients`. Empty the list or
   add the address.
4. A site opens blank or its buttons do nothing: a host it needs is blocked. Settings on the TV, the
   source, "Blocked for this source", allow it. The same list is under `blockedHosts` in `/api/status`.
5. A title will not play: `/api/trace` shows what the TV did step by step; SETUP.md, Troubleshooting,
   has the known cases.
6. The home screen is empty or stale: `curl -X POST http://<pi>:8787/api/ingest/run`, then look at
   `ingest` in `/api/status` for an `error` per source.
7. Everything is slow: the first open of a site is always slow; the second comes from the cache.
   `cache` in `/api/status` shows hits and misses. The Pi on Ethernet beats Wi-Fi.
8. Nothing above helps: `cd ~/mediahub && git log --oneline -5` to see what version the Pi runs, then
   `git pull` and restart, or `git checkout <older commit>` to go back a step.

## Still to do

Written on 2026-11-14, for whoever picks this up:

* Reserve the Pi's and the TV's addresses in the router.
* Point the stick's DNS at the Pi for Pi-hole (needs the Wi-Fi password).
* Lock `allowClients` in `config/access.json` to the TV and the PC that drives it, once the addresses are reserved.
* YouTube opens on its empty signed-out home; a start page such as `/feed/trending` per source is the fix.
* Some sites still stall before playing a title; `/api/trace` and `TESTING.md` hold what is known.
