SCENE SNAPSHOTS - plugin for Stash
Version 1.0.1
==================================================================

SUMMARY
-------
Scene Snapshots adds a camera button to the scene player. Clicking it opens
a window with screenshot suggestions taken from the video. For each
suggestion you can:

  - save it as an image in the Stash library path
  - set it as the cover (thumbnail) of the scene
  - set it as the image of one of the scene's performers

You can also take the current frame of the player directly.


AI DISCLOSURE
-------------
This plugin was created with the help of AI (Claude, by Anthropic). The
code, the texts and this README were generated in a conversation with the AI
and adjusted based on feedback and testing by the person who requested it.
As with any plugin, review the code before using it, especially since it
writes files to your library and changes data in your Stash database.


FILES
-----
  scene-snapshots.yml   Plugin manifest with settings and task
  snapshots.js          User interface: player button, windows, GraphQL calls
  snapshots.css         Styles for the button and windows
  snapshots.py          Backend task: save a frame with ffmpeg, start a scan
  README.txt            This file


REQUIREMENTS
------------
  - Stash with plugin support (UI plugins and "raw" plugins)
  - Python 3 (called as "python3"; the standard library is enough, no
    packages needed)
  - ffmpeg, reachable through the ffmpeg path configured in Stash or through
    the PATH of the Stash process
  - A browser that can play the scene's video format (the suggestions are
    generated in the browser)


INSTALLATION
------------
1. Put all files into their own folder inside Stash's plugins directory,
   for example:

     <Stash config folder>/plugins/scene-snapshots/

   (The folder name is up to you. The plugin ID is the file name of the YAML
   file without extension: "scene-snapshots".)

2. In Stash: Settings > Plugins > "Reload plugins".
3. Hard-reload the page (Ctrl+F5) so the browser loads the new JavaScript
   and CSS.
4. Optional: adjust the settings of "Scene Snapshots" under
   Settings > Plugins.

Docker: ffmpeg and Python 3 must be available inside the container. The
scene paths must be valid for the plugin process.


USAGE
-----
1. Open a scene. Move the mouse over the player so the control bar appears.
2. Click the camera icon to the left of the fullscreen button.
3. Configure the window:
     - Suggestions:  Number of frames (1 to 24)
     - Time range:   One slider with two handles (start and end) in steps of
                     0.1 seconds. The selected times are shown to the left
                     and right of it ("From" and "To"). Below it, "Last
                     used: ..." shows the range the last run actually took
                     frames from (narrowed to 5 % - 95 % when "Avoid intro
                     and outro" is active).
                     Keyboard: arrow keys move a handle by 1 second,
                     Shift + arrow keys by 0.1 second.
     - Avoid intro and outro:
                     Only frames between 5 % and 95 % of the scene length.
                     Hovering over the checkbox shows an explanation.
     - Add to gallery:
                     When saving, the image is put into a gallery of the
                     scene (see below).
4. Click "Load screenshots". The frames appear one by one. Nothing is loaded
   automatically. Afterwards the button is called "Reload".
5. For each frame:
     - "Save as image"            saves the image in the library path
     - "Set as cover"             sets the frame as the scene's cover image
     - "Set as performer image"   sets the frame as the image of a performer
                                  of the scene (only shown if the scene has
                                  performers; with several performers choose
                                  one in the selector first; you are asked
                                  for confirmation before it is replaced)
6. "Settings" opens a second window above the first one, in which all plugin
   settings can be edited and saved (the same values as under
   Settings > Plugins). After saving they apply immediately in the main
   window.
7. "Use current frame" adds the position where the player currently is (the
   player is paused when the window opens).
8. Close: "x" button, Escape or a click outside the window. Escape closes the
   settings window first if it is open.

The preview images are shown in the video's aspect ratio. If they do not fit
into the window, the image area scrolls.

For testing without the button: in the browser console (F12),
  window.sceneSnapshots.open()
opens the window on a scene page.


SETTINGS (Settings > Plugins > Scene Snapshots)
--------------------------------------------------
  Number of suggestions      Default 8 (1 to 24). Can be changed in the
                             window with the slider.
  Target folder inside the   Subfolder in the scene's library root.
  library                    Default: "Screenshots".
  JPEG quality               ffmpeg scale 2 to 31, lower = better.
                             Default 2.
  Add to gallery             Put the saved image into a gallery of the
                             scene. Default: on.
  Tag for snapshots          Saved images get this tag. Default
                             "Screenshot". Leave empty = no tag.
  Avoid intro and outro      Default: on.
  Copy metadata              Performers, studio and date of the scene are
                             copied to the image, where available.
                             Default: on.

Note: for checkbox settings in Stash, "not set" means the default listed here
(on). To turn one off, explicitly uncheck it and save.


WHAT HAPPENS WHEN SAVING
------------------------
1. The window starts the plugin task "Save Snapshot" (snapshots.py).
2. The task extracts the frame at full quality with ffmpeg to

     <library root>/<target folder>/<scene title> [<scene ID>]/
         <scene title>_<HH-MM-SS-mmm>.jpg

   The library root containing the scene file is used. The target folder
   must be inside the library.
3. The task starts a scan for that single file only.
4. The window waits until the image appears in the database (up to 90
   seconds) and then links it:
     - Pick a gallery and add the image:
         a) If the scene already has a manual gallery, the image goes
            there (a gallery "<title> - Snapshots" is preferred, otherwise
            the first manual gallery of the scene).
         b) Otherwise "<scene title> - Snapshots" is created (or an existing
            gallery of that name is used) and linked to the scene.
         Folder and zip galleries do not accept additional images in Stash
         and are skipped.
     - Set the tag
     - Copy performers, studio and date of the scene

Linking runs in the window and not in the Python task so that the task does
not wait for a scan job that sits behind it in the job queue.

Saving the same frame again overwrites the file.


PERFORMER IMAGE
---------------
The button only appears if at least one performer is assigned to the scene.
The frame is set uncropped, at full video size, as the performer's new image
(performerUpdate, image). The existing image is replaced; a confirmation is
shown first.

SET AS COVER
------------
"Set as cover" sends the frame as JPEG (data URL) to Stash via GraphQL
(sceneUpdate, cover_image). No file is created in the library path. Cover
images already loaded on the page are reloaded. If you still see the old
cover, reload the page.


KNOWN LIMITATIONS
-----------------
  - The suggestions are generated in the browser. Formats the browser cannot
    decode (e.g. some HEVC files) yield no frames and an error message is
    shown. "Save as image" uses ffmpeg and also works for such files, but
    the preview is missing.
  - The scene needs at least one video file. The first file of the scene is
    used.
  - Saved images only show up if the target folder is inside the library path
    and is not excluded from scanning by exclude patterns or the image file
    extension setting.
  - Performers, studio and date are copied when saving. Later changes to the
    scene are not carried over automatically.
  - Names of GraphQL fields and mutations can differ between Stash versions.
    On errors, the window shows Stash's message directly.


TROUBLESHOOTING
---------------
Camera button is missing
  - Is the plugin visible under Settings > Plugins? Did you run "Reload
    plugins"?
  - Hard-reload the page (Ctrl+F5), clear the browser cache.
  - The button only appears on scene pages (URL contains /scenes/<ID>) and
    only once the player's control bar exists.
  - Check in the console (F12):
      document.querySelector(".video-js .vjs-control-bar")
    If it returns "null", your theme or version names the classes
    differently.

Clicking the button does nothing
  - Check the console (F12) for errors.
  - Check that the current file is served: open
      http://<your-stash>/plugin/scene-snapshots/javascript
    and verify that it contains the current code.

No frames / error message in the window
  - The browser cannot decode the video format (see limitations).
  - Time range too short ("The selected time range is too short."; at least
    one second).

"Save as image" fails
  - "ffmpeg not found": set the ffmpeg path in the Stash settings or put
    ffmpeg on the PATH of the Stash process.
  - "Target folder is outside the library": check the "Target folder"
    setting (no "..", a relative path inside the library).
  - Write permissions: the Stash user must be allowed to write in the library
    folder.
  - Details are in the Stash log (Settings > Logs).

"Scan did not finish in time"
  - The scan may be waiting behind other jobs in the queue. The image is
    imported anyway, but not linked to gallery/tag/metadata. Link it
    manually afterwards or save it again.

Errors with gallery, tag or metadata
  - The error message appears directly on the image card. It contains the
    GraphQL message from Stash, which lets you check whether a field name is
    different in your Stash version.


FEATURES IN VERSION 1.0.0
-------------------------
  - Camera button in the player control bar
  - Frame suggestions, picked by sharpness and brightness
  - Adjustable number, time range (double slider, 0.1 s) and intro/outro
    avoidance
  - Frames are only generated after clicking "Load screenshots"
  - Use the current player frame
  - Save as image in the library path, with gallery (an existing gallery of
    the scene is preferred), tag, performers, studio and date
  - Set as the scene's cover
  - Set as performer image
  - Settings window inside the plugin


SECURITY
--------
The backend only accepts a numeric scene ID, a timestamp and a plain file
name ending in ".jpg". The file name must not contain path separators,
reserved characters (\ / : * ? " < > |) or control characters, and must not
start with a dot. The target path is checked against the library root so
that nothing is written outside the library.
