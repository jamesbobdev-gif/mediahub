# Driving the TVs from a local model

How something else in the house talks to the hub and the TVs: a local AI model running on your own
computer, a script, a phone page. It can see which TVs are on, read what each is showing, search
every source's titles at once, and tell a TV to open a site, play a film, pause, or go home. Nothing
here leaves the house, and nothing here can buy, sign in, or change the hub's settings.

This is the companion to [SETUP.md](SETUP.md) (installing the hub) and [ARCHITECTURE.md](ARCHITECTURE.md)
(how it works inside). Everything on this page is also served by the hub itself at
`http://<pi>:8787/api/control`, in JSON, so a model can read the rules at run time.

Contents: [How it fits together](#how-it-fits-together) · [Set it up](#set-it-up) ·
[Find things](#find-things) · [Send a command](#send-a-command) · [Read a TV](#read-a-tv) ·
[A whole visit, step by step](#a-whole-visit-step-by-step) · [Give it to a local model](#give-it-to-a-local-model) ·
[Romulus](#romulus) · [Naming TVs](#naming-tvs) · [What it cannot do](#what-it-cannot-do) ·
[When something is off](#when-something-is-off)

## How it fits together

Each TV that opens the hub says hello to it and keeps one connection open, waiting. A controller,
your local model for instance, never talks to a TV directly: it posts a command to the hub, the hub
forwards it down that TV's open connection, the TV carries it out the way a remote key press would,
and answers. The hub hands that answer back as the result of the command.

```mermaid
flowchart LR
    M["Local model<br/>(or a script, a phone)"] -- "GET /api/tv<br/>GET /api/catalog/search<br/>POST /api/tv/id/command" --> H["Hub on the Pi<br/>:8787"]
    H -- "command, down the TV's<br/>open event stream" --> TV["TV shell"]
    TV -- "result (ack)<br/>and what it shows (state)" --> H
    H -- "the TV's answer" --> M
```

Three things to know before anything else:

* **The hub only forwards.** A command does what the remote could do: open, play, pause, press a key.
  There is no command that edits sources, allows hosts, or touches the Pi.
* **A TV is known while it is open.** The hub keeps the TVs in memory. When the hub restarts, the list
  is empty until each TV reconnects, which the shell does on its own within seconds. A TV that is
  switched off is not on the list.
* **A token stands in for a login.** Commands from another computer need the control token from
  `config/access.json`. Without one, the hub takes commands only from the Pi itself.

## Set it up

Three steps, once. On the Pi over SSH (see SETUP.md, Step 1):

**1. Choose a token.** Any word or phrase without spaces, the longer the better. This makes one:

```bash
openssl rand -hex 16
```

**2. Put it in the access file.**

```bash
nano ~/mediahub/config/access.json
```

```json
{
  "allowClients": [],
  "controlToken": "paste-the-token-here"
}
```

Save with Ctrl+O, leave with Ctrl+X. The hub reloads the file on its own; no restart. If
`allowClients` is set (SETUP.md, Step 4), add the controller's address to it too, since the
allowlist applies before the token.

**3. Check it from the other computer.** Replace the address and the token:

```bash
curl -H "Authorization: Bearer paste-the-token-here" http://192.168.1.200:8787/api/tv
```

A list comes back, one entry per TV that has the hub open. An empty list `[]` means no TV is
connected right now. A `401` means the token did not match what is in the file.

The token goes on every control call as the header `Authorization: Bearer <token>`. Where a header
is awkward, `?token=<token>` on the address works the same.

## Find things

Everything a controller reads. Only the first two need the token.

| Call | What comes back |
|---|---|
| `GET /api/tv` | The TVs: `id`, `name`, `ip`, `platform`, `online`, `lastSeen`, and `state` (see [Read a TV](#read-a-tv)). |
| `GET /api/tv/<id>` | One TV, the same shape. |
| `GET /api/control` | This page as JSON: the base address, how to send the token, every command and what it needs. |
| `GET /api/sources` | The sources the hub has: `id`, `name`, `origin`, `startPage`. The `id` is what commands take. |
| `GET /api/catalog/search?q=words` | Titles across every source that match, best first, each with `id`, `title`, `year`, `kind` (movie, series, episode), which `sources` carry it, and poster links. `&limit=20` for more than ten. Typos are fine. |
| `GET /api/catalog/item/<id>` | One title, the same shape. |
| `GET /api/status` | Catalog size, each source's last pull, and what the proxy blocked lately. |

An example, searching for a film:

```bash
curl "http://192.168.1.200:8787/api/catalog/search?q=night%20of%20the%20living"
```

```json
{ "query": "night of the living", "count": 1,
  "items": [ { "id": "3f0c1a9b2d7e4c55", "kind": "movie", "title": "Night of the Living Dead", "year": 1968,
               "sources": [ { "source": "archive", "url": "https://archive.org/details/night_of_the_living_dead" } ],
               "posters": [ "https://archive.org/services/img/night_of_the_living_dead" ] } ] }
```

The `id` is what `play` takes.

## Send a command

```
POST /api/tv/<id>/command
Authorization: Bearer <token>
Content-Type: application/json

{ "type": "<command>", ...its fields }
```

The hub answers when the TV has done it, usually within a second, with the TV's own result:
`{"ok": true, ...}` or `{"ok": false, "error": "one sentence"}`. If the TV does not answer in ten
seconds the hub answers `202` with `"pending": true`; read the TV's state to see what happened.

| Command | Fields | Does | Answers with |
|---|---|---|---|
| `status` | | Nothing; just asks. | `state`, as in [Read a TV](#read-a-tv). |
| `home` | | Goes to the hub home screen. | |
| `open_source` | `source` | Opens that app or site on its start page. | `opened` (its name), `loaded` (true once the page announced itself). |
| `open_url` | `source`, `path` | Opens one page of a source. `path` starts with `/` and is the page's path on that site. | `opened`, `loaded`. |
| `play` | `item` | Opens a catalog title and starts it. Waits up to eight seconds for the video. | `title`, `started`. When `started` is false, the page is open but the video has not begun; read the state again shortly. |
| `search` | `query` | Opens the search screen with the words typed in. | `results`: the first ten matches with their ids. |
| `key` | `intent` | Presses one remote key: `up`, `down`, `left`, `right`, `select`, `back`, `play`, `pause`, `playpause`, `ff`, `rw`, `menu`, `info`, `search`. | `view`, `focus` (the text under the focus afterwards). |
| `pause` | | Pauses the video. | Fails with "nothing is playing" when there is none. |
| `resume` | | Resumes a paused video. | Same. |
| `toggle_play` | | Pause if playing, play if paused; on a page with a video, hands the video to the player. | `started` on a hand-over. |
| `stop` | | Stops the video; with none playing, leaves the page. | `view`. |
| `back` | | The Back key. | `view`. |
| `say` | `text` | Shows up to 120 characters on the TV for a few seconds. Good for "pausing in 5 minutes". | |

A few, with curl. `TV` and `TOKEN` stand for the id and the token:

```bash
curl -X POST -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d '{"type":"play","item":"3f0c1a9b2d7e4c55"}' http://192.168.1.200:8787/api/tv/TV/command
```

```bash
curl -X POST -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d '{"type":"pause"}' http://192.168.1.200:8787/api/tv/TV/command
```

```bash
curl -X POST -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d '{"type":"key","intent":"down"}' http://192.168.1.200:8787/api/tv/TV/command
```

```bash
curl -X POST -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d '{"type":"say","text":"Dinner in ten minutes"}' http://192.168.1.200:8787/api/tv/TV/command
```

A command that is not well formed is refused before it reaches the TV, with a sentence that says
what is missing: `{"ok": false, "error": "\"play\" needs \"item\": a title id from GET /api/catalog/search"}`.

## Read a TV

`state` in `GET /api/tv` and `GET /api/tv/<id>`, and the answer to `status`. The TV sends it when
something changes and every five seconds.

| Field | Meaning |
|---|---|
| `view` | `home`, `search`, `settings`, or `portal` when a site is open. |
| `source` | The open source's id, or null. |
| `href` | The open page's path, or null. |
| `title` | The title being watched, when the TV knows it. |
| `playing` | `active`: the player has a video. `paused`. `t` and `d`: position and length, in seconds. |
| `focus` | The text of the tile or button the remote's focus is on (home, search and settings). |
| `query` | What is typed on the search screen, while it is open. |
| `mode` | `spatial` (focus moves between elements) or `cursor` (a pointer, for sites that need one). |
| `sources`, `titles` | How many the TV has. |
| `at` | When the TV last reported, in milliseconds since 1970. |

A TV with `online: false` said hello earlier but its connection is gone: it is off, asleep, or on
another app. Commands to it are refused at once with "is not connected right now".

## A whole visit, step by step

What a model does to play a film on the living room TV, in order. Each line is one call.

1. `GET /api/tv` → one TV, `id` `a1b2c3d4`, `name` "Fire TV", `online` true, `view` `home`.
2. `GET /api/catalog/search?q=fantastic%20planet` → one match, `id` `9e0d…`, on `archive`.
3. `POST /api/tv/a1b2c3d4/command` `{"type":"play","item":"9e0d…"}` → `{"ok":true,"title":"Fantastic Planet","started":true}`.
4. Twenty minutes later, `{"type":"pause"}` → `{"ok":true}`.
5. `GET /api/tv/a1b2c3d4` → `playing.paused` true, `t` 1203, `d` 4320.
6. `{"type":"resume"}`, and at the end `{"type":"stop"}` → `{"ok":true,"view":"home"}`.

Opening a site rather than a title, when the model wants the person to browse themselves:
`{"type":"open_source","source":"pbs"}`, then `key` presses to move around, `status` to see what the
focus is on, and `{"type":"key","intent":"select"}` to open it.

## Give it to a local model

A model drives this with ordinary HTTP calls, so any model with a tool that can fetch a URL can use
it, as can one with a purpose-built tool. What the model needs in its instructions, in full:

* The hub's base address (`http://192.168.1.200:8787`) and the token.
* To read `GET /api/control` once, or the tables above.
* The order of a visit: list the TVs, search for the title, send `play` with the title's `id`, read
  the state to confirm. Never guess an id.
* To say what it did in plain words: "Playing Fantastic Planet on the Fire TV" rather than JSON.

A tool definition in the shape Ollama and OpenAI-style models take, for a model that calls functions:

```json
{ "type": "function", "function": {
  "name": "media_hub",
  "description": "The TVs in the house, through the Media Hub. action: tvs (list them), search (find a title: query), play (item id, on tv), open (a source id, on tv), pause, resume, stop, home, key (intent), say (text), status. tv is the TV id from tvs; with one TV it may be left out.",
  "parameters": { "type": "object", "properties": {
    "action": { "type": "string", "enum": ["tvs", "search", "play", "open", "pause", "resume", "stop", "home", "key", "say", "status"] },
    "tv": { "type": "string" }, "query": { "type": "string" }, "item": { "type": "string" },
    "source": { "type": "string" }, "intent": { "type": "string" }, "text": { "type": "string" }
  }, "required": ["action"] } } }
```

Behind that tool, the code maps each action to one of the calls above. Romulus ships exactly this
tool for its local model; see the next section.

## Romulus

[Romulus](https://github.com/jamesbobdev-gif/Romulus) is the to-do app with an AI agent whose local
model (any Ollama) runs private tasks on your own computer. Its November 2026 builds can drive the hub:

1. In Romulus, open **Settings → Local model**. Under **Media Hub**, enter the hub's address
   (`http://192.168.1.200:8787`) and the control token from step 2 above. Save.
2. Write a task on the Agent tab in plain words: "play Fantastic Planet on the TV", "pause the living
   room TV", "put PBS on the TV", "what's on the TV right now?". A task about the TV goes to the local
   model, which uses the hub tool, and its reply says what it did.
3. The model never sees more than the hub shows anyone on the network: the catalog, the sources, what
   the TV is showing. It cannot change the hub's sources or settings from a task.

The skill that tells Romulus's model how to behave on TV tasks is `agent/skills/media-hub.md` in the
Romulus repository, and the tool itself is `media_hub` in `agent/local-tools.js`.

## Naming TVs

The hub names a TV after what it is: "Fire TV", "LG TV", "Samsung TV", "Android TV", or "Browser"
for a computer. With two of a kind, their ids tell them apart. To give a TV a name of your own, open
the hub on it once with `?tv=` and the name in the address: `http://192.168.1.200:8787/?tv=Living%20room`.
The TV keeps the name. For the Fire TV app, that address is the `hubUrl` it is built with
(`android/README.md`).

## What it cannot do

* **Nothing outside the house.** The hub listens on the home network only, and this page assumes the
  ports are not forwarded (SETUP.md, Step 4).
* **No settings.** Adding or removing a source, allowing a host, changing rules: those are the TV's
  Settings screen and the hub's own API, not commands. A model given only the control token cannot do
  them from here.
* **No money, no sign-ins, no typing into sites.** There is no command that types text into a page.
  `search` types into the hub's own search box only.
* **No TV that is off.** The hub cannot wake a TV or switch its input; it reaches the hub app while it
  is open.

## When something is off

| You see | It means | Do |
|---|---|---|
| `401` with "send the control token" | The token is missing or wrong. | Compare with `controlToken` in `config/access.json`; the hub reloads it on save. |
| `401` with "no control token is set" | Commands are allowed from the Pi only. | Set `controlToken` ([Set it up](#set-it-up)). |
| `403` page | The controller's address is not in `allowClients`. | Add it (SETUP.md, Step 4) or empty the list. |
| `404` "unknown TV" | The TV has not said hello since the hub started. | Back out of the hub app on the TV and open it again, then `GET /api/tv`. |
| `"is not connected right now"` | The TV said hello once but its connection dropped. | Same: reopen the hub on the TV. `online` in `GET /api/tv` shows it. |
| `202` with `"pending": true` | The TV took more than ten seconds. A heavy page can. | `GET /api/tv/<id>` a few seconds later. |
| `play` answers `started: false` | The title's page is open but the video has not begun. | Read the state again shortly; if `playing.active` stays false, the site needs a key press, `{"type":"key","intent":"select"}`, or has no player the hub can take over. `GET /api/trace` on the hub shows the TV's steps. |
| The TV does something, the answer says `ok: false` | The command ran but the TV reported a problem, such as "nothing is playing". | The error line says which. |
