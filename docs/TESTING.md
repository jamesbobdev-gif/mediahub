# Testing the hub with real sources

What was tried, what went wrong, and what was done about it. The hub ran on the Pi at the time
(main as of 2026-11-14); sources were added and removed through the same API the Settings screen
calls, pages were opened through the hub's portal port from a PC, and the TV was used where it
was awake. Only free, licensed sites were used.

## Adding and removing sources

Each site was added by name and address, the finder was run, the home page was fetched through
the hub, and the site was removed again. After every removal the sources file, the catalog and
the artwork store were checked for leftovers.

| Site | Added as | Finder | Opens through the hub | Removed cleanly |
| --- | --- | --- | --- | --- |
| Crackle (crackle.com) | yes | nothing found | no: the Pi cannot reach crackle.com at all (connection fails before any page), so the hub answered a bare error | yes |
| Xumo Play (play.xumo.com) | yes | nothing found (the site is drawn entirely by script, no feed, no sitemap) | yes, as a page | yes |
| PBS Kids (pbskids.org/videos) | yes | the rows on its front page, 50 titles with pictures | yes | yes: 42 titles and 31 posters gone |
| NASA+ (plus.nasa.gov) | yes | nothing at first; now its WordPress list of videos, 50 titles with pictures (46 new to the catalog) | yes | yes: 46 titles and 44 posters gone |
| Internet Archive, classic_tv collection | yes | nothing at first; now the archive's own list of the collection, 200 titles with pictures (192 new, one shared with the films collection) | yes | yes: 191 titles and 89 posters gone, the shared title kept |

## Flaws found, and what was done

| Flaw | Where | Done |
| --- | --- | --- |
| A site the hub cannot reach showed a bare "upstream error" text in the frame, which the shell took for an escaped page and bounced home after four tries | proxy | The hub now serves a plain page saying it could not reach the site; Back leaves it like any page |
| A removed source's posters stayed on disk until the next budget sweep | catalog, artwork store | Posters no remaining title uses are deleted when the source is removed |
| WordPress sites (NASA+) gave the finder nothing although they publish a list of their videos | finder | The finder reads the site's WordPress API when the page shows it is WordPress |
| An Internet Archive collection page gave the finder nothing (the page is drawn by script) | finder | A collection address maps to the archive's own search feed for that collection |
| Opening a title directly on Tubi lands on Tubi's 404 screen on its real host; the frame refuses that and showed white | shell, injected script | The hub goes in through the site's front page and moves to the title inside the app; the site is remembered |
| Allowing a blocked host from Settings changed nothing for up to an hour | proxy | Blocked placeholders are no longer cacheable |
| A heavy page (YouTube) was taken for an escaped page after 600 ms and two missed pings | shell | A tested liveness rule: four seconds after load, the same after a self-navigation, ten seconds of silence |
| On the Fire TV stick, Pluto rendered and then reloaded itself every half minute; the trace showed the page "silent" for 12 seconds while the shell's own one-second timer had not run either (the stick runs shell and page on one thread) | shell | Time the watcher slept through counts against nobody; a load event with no new page behind it is forgotten once the page talks again (both tested) |
| YouTube's home shows nothing to a signed-out viewer | source | Its TV page (youtube.com/tv) is used as the start page, fetched as a TV browser; a second entry starts on a search |
| Scripts that build URLs with the page's scheme asked Tubi's CDN over plain http and were refused | injected script, proxy | Such URLs resolve against the real site; http is upgraded to https for an https site |
| An app's API calls lost their tokens because the hub sent only a few request headers upstream | proxy | The page's own headers go through, minus the ones that name the TV or the hub |
| Picking a title landed on the site's page and waited for the user to press play | shell | A chosen title plays at once: the page presses its own play control and hands the video over |
| Movies and Series rows showed one source's titles in a block before the next source's | shell | Rows take titles in turns across sources |
| Nothing on the home screen showed what the viewer actually opened lately | shell | A Recently watched row across all sources, after Continue watching |
| Xumo Play, The Roku Channel and Plex give the finder nothing: they are drawn entirely by script with no feed, sitemap or public list | finder | Open question. They open as pages; no titles reach the home screen |
| Posters still downloading when a source is removed land in the store afterwards and are never deleted (about 240 files after two passes) | artwork store | Open: a sweep of posters no title uses, at start-up |
| Pluto TV shows "You may be using a VPN or proxy" from a PC on a VPN, with or without the hub | site | Not a hub fault; from the Pi it loads |
| The play-at-once press did not start Coraline on the Fire TV, while the same flow plays on a PC | shell, injected script | The play control sat below the fold and Tubi offered "Play in the App" to an Android browser: the control is scrolled to first and the page sees a desktop browser. Coraline plays at once on the stick; pause, seek and Back work; Continue watching shows the minutes left |
| The Fire TV's Info button opens a system "pair your remote" dialog instead of the hub's stats | Fire TV | Open: the hub's stats need another key on that remote |
| YouTube's TV page took the hub's synthetic clicks for nothing: a lean-back app wants real arrow keys | shell, injected script | A source rule `keys: page` forwards the remote's keys into the page and hides the hub's ring; the menu key returns to the hub. Watch as guest and the sidebar work on the stick |
| Tiles on YouTube's TV page were blank: a script sets their pictures as CSS backgrounds, which the page's policy refuses from another host | injected script | Pictures set as CSS backgrounds by script go through the hub too |
| Pluto's title page put the ring around the whole page: its hero is one link the size of the screen, and nothing counts as above or below it, so the arrows only scrolled | injected script | A link or button the size of the screen is a backdrop, not a control |
| On the hub's home screen the outline did not line up with the tile after a move: the tile grows and lifts for 140 ms after the ring is drawn, and the stick snaps the row into place a frame later | shell | The ring follows the tile until it has settled |
| Pluto's "Play Now" reaches its player, which stays at "Advertisement is loading" on the stick (screen black, no sound, the page stops answering) and on a PC through the hub. Its StreamingUrl call answers with a relative stitcher path and no URL; the player logs that it has no asset URL | site, proxy | Open. Allowing its consent manager (ketchcdn, ketchjs, paramount) and ad SDK (imasdk) hosts changed nothing; those stay allowed for Pluto |
| Keys sent over ADB reach the stick late or not at all while a page is busy; a press can land seconds later, on a different screen | test method | The hub's control channel (`POST /api/tv/<id>/command`, docs/CONTROL.md) is the reliable way to drive the stick from a script |
| On a PBS show page the play control is "Watch Now", a link to the episode page; the stick landed there and waited | shell | Play at once follows a play control that is a link, once, on the page it opens |
| On Vimeo the page already held its video, but the play step pressed a footer link called "Watch" and left for Vimeo's general watch page | injected script | A link away from the page is not its play control when the page holds a video. Paper Trail then played on the stick (14 min, the hub's player took it over) |
| Opening a second title right after one had played was reported as "already playing" and the play step was skipped (Plex after Vimeo) | shell | Opening a title forgets the previous page's video |
| PBS's episode page never gives its player frame an address through the hub (the frame is sized but empty on the stick); the page's identity check stays "unknown", and the frame's address is only built after it resolves | site | Open. The same page in a PC browser on a VPN showed the same, so it may not be the hub |
| Plex's "Watch Free" page draws its player (0:00 / 0:00) and never loads a stream, on the stick and on a PC through the hub; it offers Sign In | site | Open; Plex's free streaming may need an account. Its ad SDK hosts (imasdk, gstatic) were allowed for Plex and changed nothing |
| A YouTube video chosen from the desktop search results (second YouTube entry) went black and the stick stopped reporting, like Pluto's player | site, shell | Open. YouTube's TV page is the better entry: it opens and its keys work; a video was not tried there because its signed-out home offers only a search box, which the remote cannot type into |

## Still to check on the TV itself

- Done on the stick: Tubi (Coraline from its poster: plays at once, pause, seek, Back), Vimeo
  (Paper Trail from its poster: plays at once), YouTube's TV page (opens, keys drive it), Pluto
  (opens, title page, Play Now reaches a player that does not start), PBS and Plex (reach their
  player pages, which stay empty: see the table), the Settings screen (list, detail, Allow buttons
  and the button row all reachable with the arrows; Open works). The Internet Archive is no longer
  among the configured sources.
- Pause and seek on Vimeo; a free video on YouTube's TV page.
- Adding and removing a source from the Settings screen with the remote, as opposed to through
  the API the screen calls.
