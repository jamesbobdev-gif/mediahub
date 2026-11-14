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
| PBS Kids (pbskids.org/videos) | yes | the rows on its front page, 50 titles with pictures | yes | yes, 42 titles gone |
| NASA+ (plus.nasa.gov) | yes | nothing at first; now its WordPress list of videos, 50 titles with pictures | yes | yes |
| Internet Archive, classic_tv collection | yes | nothing at first; now the archive's own list of the collection, 200 titles with pictures | yes | yes |

## Flaws found, and what was done

| Flaw | Where | Done |
| --- | --- | --- |
| A site the hub cannot reach showed a bare "upstream error" text in the frame, which the shell took for an escaped page and bounced home after four tries | proxy | The hub now serves a plain page saying it could not reach the site; Back leaves it like any page |
| A removed source's posters stayed on disk until the next budget sweep | catalog, artwork store | Posters no remaining title uses are deleted when the source is removed |
| WordPress sites (NASA+) gave the finder nothing although they publish a list of their videos | finder | The finder reads the site's WordPress API when the page shows it is WordPress |
| An Internet Archive collection page gave the finder nothing (the page is drawn by script) | finder | A collection address maps to the archive's own search feed for that collection |
| Opening a title directly on Tubi lands on Tubi's 404 screen on its real host; the frame refuses that and showed white | shell, injected script | The hub goes in through the site's front page and moves to the title inside the app; the site is remembered |
| Allowing a blocked host from Settings changed nothing for up to an hour | proxy | Blocked placeholders are no longer cacheable |
| A heavy page (YouTube) was taken for an escaped page after 600 ms and two missed pings | shell | A tested liveness rule: four seconds after load, the same after a self-navigation, four seconds of silence |
| YouTube's home shows nothing to a signed-out viewer | source | Its TV page (youtube.com/tv) is used as the start page, fetched as a TV browser; a second entry starts on a search |
| Scripts that build URLs with the page's scheme asked Tubi's CDN over plain http and were refused | injected script, proxy | Such URLs resolve against the real site; http is upgraded to https for an https site |
| An app's API calls lost their tokens because the hub sent only a few request headers upstream | proxy | The page's own headers go through, minus the ones that name the TV or the hub |
| Picking a title landed on the site's page and waited for the user to press play | shell | A chosen title plays at once: the page presses its own play control and hands the video over |
| Movies and Series rows showed one source's titles in a block before the next source's | shell | Rows take titles in turns across sources |
| Nothing on the home screen showed what the viewer actually opened lately | shell | A Recently watched row across all sources, after Continue watching |
| Xumo Play, The Roku Channel and Plex give the finder nothing: they are drawn entirely by script with no feed, sitemap or public list | finder | Open question. They open as pages; no titles reach the home screen |
| Pluto TV shows "You may be using a VPN or proxy" from a PC on a VPN, with or without the hub | site | Not a hub fault; from the Pi it loads |
| The play-at-once press did not start Coraline on the Fire TV, while the same flow plays on a PC | shell, injected script | Open: the TV now reports each step to `/api/trace`; the stick was asleep before it could be read |
| The Fire TV's Info button opens a system "pair your remote" dialog instead of the hub's stats | Fire TV | Open: the hub's stats need another key on that remote |

## Still to check on the TV itself

- YouTube's TV page: whether the shell's focus and OK drive the lean-back app, which expects
  arrow keys.
- Each configured source, from its card and from a poster: open, play, pause, seek, Back to the
  hub, with no bounce and no white screen.
- Adding and removing a source from the Settings screen with the remote, as opposed to through
  the API the screen calls.
