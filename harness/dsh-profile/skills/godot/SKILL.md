---
name: godot
description: Working on a Godot 4 project — exact API from the official online class reference, the compile check, headless runs, screenshots, web export limits, GDScript typing rules.
whenToUse: The project has project.godot, or the task mentions Godot / GDScript / .tscn.
---

# godot: Godot 4 projects

Engine: the `_console` build of the installed Godot (`Godot_v4.x-stable_win64_console.exe`, so output reaches the
terminal). Look for it in the project's AGENTS.md, on PATH (`Get-Command godot*`) or ask the user once, then write
the path into AGENTS.md. Below `$G` is that path; `& $G --version` gives the version for the docs links.

## API: never from memory
- The class reference of your version is online: `web_fetch`
  `https://docs.godotengine.org/en/<version>/classes/class_<name>.html` (lower-case class name, e.g.
  `class_timer.html`; `<version>` = `stable`, `latest` or `4.4`) before writing any name you are not sure of.
  Global functions (`sin`, `pow`, `clampf`, `lerpf` …) are on `class_@globalscope.html`. A member is documented
  on the class that defines it; "Inherits:" shows where inherited ones are.
- Not on the page = does not exist (there is no `sinf`, `powf`, `PackedAudioBuffer`; `Timer` has `wait_time`
  and a `timeout` signal). Behaviour / how-to: web_search with `site:docs.godotengine.org`.
- Write the names you looked up and use often into the project's AGENTS.md, so later sessions do not fetch them again.

## Checks
- Compile every script: a `tools/check.tscn` + `tools/check.gd` that `load()`s every `.gd`/`.tscn` and prints
  `checked N`; run `& $G --headless --path . res://tools/check.tscn 2>&1 | Out-File _shots/check.txt` and read
  the file (piping to Select-Object -Last N hides the first error). Parse errors print as
  `Parse Error: <message> at: GDScript::reload (res://path.gd:LINE)` — go to that exact line.
- After adding a `class_name`: `& $G --headless --path . --import` once (rebuilds the class cache).
- A 3-line probe: `& $G --headless --quit-after 300 -s tools/probe.gd` where probe.gd `extends SceneTree`, does
  its work in `_init()` and ends with `quit()`. Always pass `--quit-after` too: a probe that forgets `quit()` (or
  awaits something that never comes) otherwise hangs until the shell's 60 s limit and costs a background-job wait.
  The same for any headless scene run: `--quit-after <frames>`.
- Screenshots: a scene/arg that renders N frames, then
  `get_viewport().get_texture().get_image().save_png("res://_shots/x.png")`, run WITHOUT `--headless`
  (`--resolution 1280x720`), then `read_image` the PNG. Keep `_shots/` in .gitignore. The sandbox allows writes
  only inside the project: use `res://`, not `user://`, for anything you need to read back.

## GDScript rules that bite
- Strict typing: `var x := dict["k"]` is an error (Variant) — write `var x: float = float(dict["k"])`.
- Nested typed collections (`Array[Array[float]]`) are not supported: use `Array` + casts.
- Tabs for indentation. Signals: `timer.timeout.connect(_on_timeout)`. `await get_tree().process_frame`.
- Web export (gl_compatibility, no threads): no SSAO/SSIL/SSR/volumetric fog; glow, shadows, fog work.
  `JavaScriptBridge` exists only on web: guard with `OS.has_feature("web")` and keep a stub path for desktop.
- Procedural meshes: SurfaceTool / ArrayMesh, winding order decides the normal (front = clockwise in Godot).
  A shader that writes POSITION in one branch must write it in all.
