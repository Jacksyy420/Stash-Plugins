# Collapsible Plugin Settings

A UI plugin for [Stash](https://github.com/stashapp/stash) that makes long plugin lists in the settings easier to handle.

It works in two places:

- **Settings → Plugins**: the settings of the individual plugins
- **Settings → Tasks → Plugin Tasks**: the tasks of the individual plugins

## Features

- **Collapsing:** Click the header of a plugin to collapse or expand it. In the "Plugins" tab an arrow shows the state. In "Plugin Tasks" the arrow button that Stash already provides is used.
- **Remembers the state:** Which plugins are collapsed is stored in the browser (see the "Default state" setting).
- **Search:** The search field to the right of the heading filters the plugins. The whole text of a group is searched: name, description and settings. The number of matches is shown next to it, for example `3 / 12`. Press Esc in the field to clear the search.
- **Sorting:** Default order (as in Stash), Name (A - Z) or Name (Z - A). The choice is stored.
- **Collapse all / Expand all:** Applies to all plugins of the section that is currently visible.

The toolbar with search, sorting and buttons is right-aligned at the height of the "Plugins" or "Plugin Tasks" heading. It follows the heading when sections above it (for example "Generate") are collapsed or expanded.

## Installation

Tested with Stash v0.31.1.

1. Put the folder `collapsible-plugin-settings` into the plugin directory of Stash (next to `config.yml`, typically `~/.stash/plugins/`).
2. In Stash, click **Reload plugins** under *Settings → Plugins*.
3. Hard-reload the page (Ctrl+F5) so that the JavaScript and CSS are loaded.

Included files:

| File | Purpose |
| --- | --- |
| `collapsible-plugin-settings.yml` | Plugin description and settings |
| `collapsible-plugin-settings.js` | Logic |
| `collapsible-plugin-settings.css` | Styling |

## The "Default state" setting

Found in the settings of this plugin under *Settings → Plugins*. Stash offers no dropdown for plugin settings, so the value is entered as text:

| Value | Effect |
| --- | --- |
| `remember` | Last saved state (default; also used for an empty or invalid value) |
| `collapsed` | Everything is collapsed when the tab is opened |
| `expanded` | Everything is expanded when the tab is opened |

With `collapsed` and `expanded` you can still collapse and expand groups by hand. This only lasts until you open the tab again or reload the page; after that the default applies again. Only `remember` stores your state permanently. The setting is read again whenever the tab is opened, so no page reload is needed after changing it.

## Stored data

Everything is kept in the browser's `localStorage`. No data is sent to Stash or to third parties.

| Key | Content |
| --- | --- |
| `csp-collapsed-groups` | Collapsed groups. The ones from "Plugin Tasks" have the prefix `tasks:`, so identical plugin names stay separate in both tabs. |
| `csp-sort-mode` | Selected sorting |

The search term is not stored and is reset when you switch tabs. Because the data lives in the browser, it only applies to that browser.

## Customizing the JavaScript

At the top of `collapsible-plugin-settings.js`:

- `SELECTORS`: selectors for the Plugins tab and for a plugin group. Adjust them if the DOM of your Stash version differs.
- `TASKS.pane` and `TASKS.headings`: the tab and the heading of the "Plugin Tasks" section. The section is recognized by its heading text. Add the wording of your UI language to `headings` (in lower case). If the section is not recognized, nothing happens there.
- `PLUGIN_ID`: the ID of this plugin, i.e. the file name of the YAML without extension. If you rename the file, change this value as well.

## Technical notes

- Stash is a React application. The plugin therefore changes neither classes nor children of elements managed by React; it only sets `data-` attributes and uses CSS. This keeps React unaffected when it redraws, for example when a plugin is enabled or disabled.
- The toolbar is attached to the page itself, not to the plugin list. Its position is calculated from the coordinates of the heading.
- Sorting uses CSS (`order` in a flex container). The elements are not moved in the DOM.
- In "Plugin Tasks" the plugin operates Stash's own arrow button instead of building a second collapse mechanism. When a collapsed state is restored, Stash's animation is therefore briefly visible.

## Known limitations

- The "Plugins" heading is recognized by its English text. With a different UI language the toolbar may end up at a fallback position (above the first plugin group).
- In very narrow windows, for example on a phone, the toolbar can overlap the heading.
- The search also covers descriptions and settings text, so a term can match plugins that only mention it in their description.
- Sorting applies to both sections together.

## Troubleshooting

- **Nothing happens:** Reload the plugins and hard-reload the page with Ctrl+F5. Check that the plugin is enabled in the plugin list.
- **Groups are not recognized:** Look at the HTML of a plugin entry with the developer tools (right click → *Inspect*) and adjust `SELECTORS`.
- **Toolbar is in the wrong place:** Check the HTML of the heading and add your wording to `TASKS.headings` if needed.
- **Reset stored states:** Delete the keys `csp-collapsed-groups` and `csp-sort-mode` from the browser's `localStorage`.

## Uninstall

Delete the folder and click *Reload plugins* in Stash. The stored data stays in the browser and can be removed as described above.

## AI disclosure

This plugin was created with the help of AI (Claude by Anthropic). Besides checks in a simulated page, it has been tested manually in Stash v0.31.1 by the person who published it. It has not been tested on other Stash versions or setups, so please review it before use and report problems you run into.

## Changelog

- **0.8.5**: Sort options renamed to "Name (A - Z)" and "Name (Z - A)".
- **0.8.4**: README: tested Stash version (v0.31.1) added.
- **0.8.3**: README: test status updated.
- **0.8.2**: README: AI disclosure added.
- **0.8.1**: Wording aligned with Stash's own terminology ("Reload plugins", "Default order", "Name (ascending/descending)", "Search plugins…").
- **0.8.0**: Translated to English (interface, settings, README).
- **0.7.1**: The toolbar follows the "Plugin Tasks" heading when sections above it collapse or expand. README added.
- **0.7.0**: The plugin also works for "Plugin Tasks" in the "Tasks" tab.
- **0.5.0**: Sorting by name.
- **0.4.0**: Search.
- **0.3.x**: Toolbar next to the "Plugins" heading.
- **0.2.x**: "Default state" setting; robustness when enabling and disabling plugins.
- **0.1.0**: Collapsible plugin groups.
