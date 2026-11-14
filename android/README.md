# Media Hub on Fire TV and Android TV

A one-screen app that opens the hub full screen and hands the remote's keys to it. All the logic
stays on the Pi, so the app never needs updating when the hub changes. Only the hub's address is
baked in, at build time.

## Build

Needs a JDK 17 and the Android SDK (both come with Android Studio). On Windows:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd android
.\gradlew.bat assembleRelease -PhubUrl=http://192.168.1.50:8787/
```

Use your Pi's address. The result is `android/app/build/outputs/apk/release/app-release.apk`.
Reserve the Pi's address in the router first (see `docs/SETUP.md`, Step 3) so it never changes.

## Install on a Fire TV

1. On the TV: Settings, My Fire TV, Developer Options. Turn on ADB Debugging and Apps from
   Unknown Sources. If Developer Options is missing, go to About and select the device name
   seven times to reveal it.
2. Find the TV's address under Settings, My Fire TV, About, Network.
3. From the PC, with `adb` from the SDK's `platform-tools` folder:

```powershell
adb connect 192.168.1.60
adb install -r android\app\build\outputs\apk\release\app-release.apk
```

The first `adb connect` makes the TV ask whether to allow this computer; choose Always allow.
The app then appears under Your Apps & Games as Media Hub.

Android TV and Google TV boxes work the same way with their own Developer Options.

## Remote keys

The hub's `shell/js/keymap.js` already maps Android key codes. The app sends every remote key
through as is, with two stand-ins for keys a Fire TV remote lacks: the menu (three lines) button
acts as the hub's "menu" key, and holding Back for a second leaves the app.

If the hub can't be reached, the app shows a plain page saying which address it tried. Select
tries again, Back leaves.
