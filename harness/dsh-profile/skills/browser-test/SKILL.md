---
name: browser-test
description: Check a web app or HTML5 game in a real browser (Edge via the mcp__browser__* tools of the "AFKLLM + браузер" preset) — start the dev server, open the page, click through, read console errors and network failures, take screenshots.
whenToUse: Any web project (Vite, React, Cocos/HTML5 build, Yandex Games build, plain HTML) after a change that affects what the page shows or does, or when the user asks to "открой в браузере" / "проверь сайт" / "почему не работает страница".
---

# browser-test: see it work, do not assume

0. The `mcp__browser__*` tools exist only in the "AFKLLM + браузер" preset. If they are missing, say so and ask
   the user to start a session with that preset; meanwhile use `mcp__afkllm__screenshot` of a browser window.
1. Serve the app: start the project's dev / preview server in a persistent terminal (terminal tools) or as a
   background job, not in a blocking shell call. Read its output for the real URL and port. A static build:
   `npx http-server <dir> -p 8080 -c-1` (or `python -m http.server 8080 -d <dir>`).
2. `mcp__browser__browser_navigate` to the URL, then `browser_snapshot` (the page as an accessibility tree — the
   cheapest way to see it, use refs from it to click and type). `browser_take_screenshot` when the look matters
   (layout, canvas, game scene), then `read_image` on the saved file if it is not shown inline.
3. Always read `browser_console_messages` after loading and after each important action: errors there are the
   bug report. `browser_network_requests` for 404s / failed assets / CORS.
4. Drive it like a user: `browser_click`, `browser_type`, `browser_press_key`, `browser_wait_for` (text to appear
   or a time) — canvas games: keys and clicks at coordinates, then a screenshot to see the result.
5. Fix → reload (`browser_navigate` again) → re-check console and the screenshot. Report what you saw (quote
   console errors exactly), not what should happen. Close the browser (`browser_close`) and stop the server
   when done.
