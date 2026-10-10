# Bulk Performer Scraper for Stash

Scrapes many Performers at once. You choose which Scrapers are used and which fields are applied.

> **Status:** Early version (0.3.1). The plugin has not yet been tested against a running Stash instance. Always start with the review before applying anything.

## Features

- **One Scraper per run:** Choose either a community Scraper or a Stash-Box (e.g. StashDB). Only one Scraper is used at a time.
- **Field selection:** Image, Disambiguation, Gender, Birthdate and Death date, Ethnicity, Country, Eye and Hair color, Height, Weight, Measurements, Fake tits, Penis length, Circumcised, Career length, Tattoos, Piercings, Aliases, URLs, Tags and Details.
- **Two modes:** Fill empty fields only (default) or overwrite existing values.
- **Everything in one window:** Opening the plugin shows a window with the settings (Scrapers, fields, Performers, genders, options). **Start review** switches to the same view, where Performers are checked live. Nothing is written during this step. For each Performer you see what would change (before/new, with a preview for images).
- **Keeps running in the background:** If you close the window, the review keeps running. If you open the plugin while a scrape is running, the running review is shown right away. Progress is also shown in the button in the *Performers* tab.
- **Sorting and filtering the result list:** by **Scenes + Images**, Scenes only, Images only, name, number of changes and status, each ascending or descending. You can filter by status (Changes, Unsure, No values, No result, Skipped, Error).
- **Selective apply:** You deselect or select individual results and apply only the selected ones.
- **Performer filter:** All Performers or only Performers with a specific Tag. You also select the genders via checkboxes (Male, Female, Transgender male, Transgender female, Intersex, Non-binary and "Not specified").
- **Skipping without a request:** If "Overwrite existing values" is off, Performers whose selected fields are all filled are skipped. No request is sent to the Scrapers and the wait time is omitted. They appear in the list with the status **Skipped**.
- **Match and link to the Scraper page:** For results with status **Changes**, the expanded entry shows the name of the match and a link to its page at the Scraper.
- **Possible matches for unsure results:** For status **Unsure**, the list shows the candidate matches (name, details, similarity, source, link and image). With **Select** you manually apply one of them to the Performer.
- **Profile with one click:** The name and image of a Performer open its Stash profile in a new tab.
- **Disambiguation and Aliases:** The Disambiguation is shown in parentheses after the name. Expanding an entry shows the Performer's stored Aliases.
- **Name matching with Disambiguation:** Matches whose name does not fit the Performer are not applied and are marked `unsure`. The Performer's Disambiguation helps to tell same-name matches apart and reduces the number of unsure cases.
- **Backup and undo:** The old values are backed up before every change.
- **Rate-limit protection:** Configurable pause between requests. Errors for individual Performers do not stop the run.

## Installation

1. Place the folder `bulk_performer_scraper/` with these files in the Stash plugin directory (by default `plugins/` next to `config.yml`):
   - `bulk_performer_scraper.yml`
   - `bulk_performer_scraper.py`
   - `bulk_performer_scraper.js`
   - `bulk_performer_scraper.css`
2. In Stash, click **Reload Plugins** under *Settings → Plugins*.
3. The **Bulk Scraper** button appears above the list in the *Performers* tab.

**Requirements:** Python 3 must be callable as `python`. If you only have `python3`, change the `exec` entry in `bulk_performer_scraper.yml`. No additional Python packages are required.

The Scrapers you want to use must be installed beforehand (*Settings → Metadata Providers → Available Scrapers*). Stash-Boxes must be configured there with endpoint and API key.

## Usage

1. Open **Bulk Performer Scraper** via the **Bulk Scraper** button at the top right of the *Performers* tab. The window opens immediately. If a review is running (or a result is available), it shows that view directly.
2. Select a Scraper in the window.
3. Select the fields to apply.
4. Choose whether to process all Performers or only Performers with a specific Tag, and check the genders to include.
5. Configure the options (see below). All settings are remembered automatically.
6. Click **Start review**. The window checks the Performers one after another. You can close it at any time with **Close**; the review then keeps running in the background (as long as the browser tab stays open). **Stop** aborts the review and keeps the results so far.
7. Sort the list, e.g. by **Scenes + Images** to check the Performers with the most content first. Click the row or the arrow to see the planned changes or the possible matches.
8. For entries with status **Unsure**, expand the row and click **Select** on the correct match. The entry then gets the status **Changes** (with the note "manual") and is included when applying. **Selected – undo** reverts this. Selecting a different match replaces the previous selection.
9. Deselect what you do not want and click **Apply N**. Applying runs as a Task in the background (with Backup and Report). You can follow the progress under *Settings → Tasks*.
10. **New review** (after completion or stop) takes you back to the settings.

**Run directly** (in the settings) starts the entire run as a Task without a review. This is intended for very large libraries where you do not want to keep the browser tab open. Changes are written immediately (with Backup). The plugin page also has **Undo last run**.

### Result list in the window

| Element | Meaning |
| --- | --- |
| Sort | Status (default, descending: Changes first), Scenes + Images (sum), Scenes, Images, name, number of changes, status. The button next to it reverses the order. |
| Filter | All, Changes, Unsure, No result, Skipped, Error (each with count). |
| Status | **Changes**: there is something new that can be applied. **Unsure**: only matches whose name does not fit or that are ambiguous. The expanded entry lists the possible matches (up to 6, sorted by similarity), of which you can manually select one. **No values**: the Performer was found, but the Scraper returns none of the requested values. **No result**: the Scrapers found no matching Performer. **Skipped**: all selected fields were already filled, nothing was scraped. **Error**: the Scraper call failed. |
| Name and image | Open the Performer's profile in a new tab. The Disambiguation is shown in parentheses after the name; the expanded entry shows the list of stored Aliases. Expand via the row below or the arrow. |
| Selection | Only entries with changes can be selected and are checked by default. **Select all** and **Select none** apply to all entries with changes. |
| Export (JSON) | Saves the current result list as a file. |

Performers whose selected fields are all filled in "fill empty fields only" mode are not scraped (no request, no wait time) and appear with the status **Skipped**.

## Options

| Option | Meaning |
| --- | --- |
| Overwrite existing values | Off: only empty fields are filled, Performers without empty fields are skipped. On: found values replace existing ones. |
| Use disambiguation, birthdate and country for matching (fewer unsure results) | On by default. See the "Disambiguation" section below. |
| Create missing tags | Scrapers sometimes return Tags that do not exist in your library. Off: such Tags are ignored. On: they are created when applying. The review itself never creates Tags; new Tags are marked "(new)" there. |
| Delay between requests (seconds) | Wait time in seconds after each Scraper call. Default: 1. Increase it if you get rate-limit errors. |
| Minimum name similarity (0–1) | Value from 0 to 1. The Scraper result must be at least this similar to the Performer's name or an Alias. Default: 0.85. |

### How values are applied

- **Single values** (e.g. Country, Height): In "fill empty fields" mode, only fields that are currently empty are processed. Performers without empty fields are skipped without sending a request.
- **Lists** (Aliases, URLs, Tags): New entries are added to the existing ones, nothing is removed.
- **Image:** The Stash default image counts as "empty". The first image from the Scraper is applied.
- **Height and Weight:** Values in feet/inches or pounds are converted to cm or kg.
- **Penis length:** Stored in cm. Values in inches are converted.
- **Circumcised:** Mapped to the Stash values "cut" or "uncut". Other values are ignored.
- **Gender:** Only applied if it can be mapped to a Stash value.
- **Dates:** Only formats such as `YYYY`, `YYYY-MM` and `YYYY-MM-DD` are applied.

### How the search works

Depending on what a Scraper supports, the plugin tries in order:

1. Query via the stored Performer (fragment scraping),
2. Search by name,
3. Query via an already stored URL of the Performer, if it matches the Scraper.

If there are multiple matches, the one with the highest name similarity is used.

### Matching via Disambiguation, Birthdate and Country

If the option **Use disambiguation, birthdate and country for matching** is active (default), the plugin compares the values stored in Stash for the Performer with the matches. This happens regardless of which fields you scrape. Even a Performer whose Birthdate is not being scraped is matched via its existing Birthdate.

1. **Name comparison:** The match is also compared with "Name (Disambiguation)". If a Scraper appends a parenthesis to the name ("Anna Smith (actress)"), it is additionally stripped for the comparison.
2. **Same-name matches:** The Performer's Birthdate (weight 3), Disambiguation (2) and Country (1) are compared with the details of the matches. For Birthdate, the shared precision counts (year, month, day). For Country, names and ISO codes are treated as equal ("United States" = "US"). The Disambiguation is compared with the match's Disambiguation, Birthdate, Country, Ethnicity as well as Hair and Eye color. The match with the best agreement wins.
3. **Name just missed:** If the name similarity is up to 0.15 below the threshold and the Disambiguation or Birthdate clearly matches (at least 60%), the match is accepted anyway. Country alone is not sufficient.

A differing value does not reject a match with a fitting name. It only lowers its rank compared to other matches. If there are several equally good matches and the details cannot decide between them (or are missing), the Performer is marked `unsure` instead of picking an arbitrary match. With the option turned off, the match with the highest name similarity is used.

### Match details

For many Scrapers, the name search only returns a short profile (often name, URL and image). Before applying, whether automatically or via **Select**, the plugin therefore fetches the match's details from the Scraper. It proceeds like the Stash UI: it passes the match to the Scraper again and, if necessary, queries via the match URL. Stash-Box matches are already complete. If fetching fails, a note on the match states what was searched for and what the match contains.

## Backups, Reports and undo

All files are located in the plugin folder:

- `backups/backup_<timestamp>.jsonl`: old values of all changed Performers, one line per Performer. Appended before every write, so it is preserved even if the run is aborted.
- `reports/report_<timestamp>.json`: result per Performer (`updated`, `no_result`, `no_data`, `unsure`, `skipped`, `error`) as well as counters and status of the run. When applying from the review and for the direct run, one Backup and one Report are written each.

### Report on abort

You also get a Report if you cancel the Task in Stash. The `status` field tells how the run ended:

| Status | Meaning |
| --- | --- |
| `completed` | The run finished completely. |
| `cancelled` | The Task was cancelled and the plugin was still able to finalize the Report itself. `processed` shows how many Performers were processed, `interrupted_at` the Performer at which it was cancelled (this one is no longer in the entries). |
| `aborted` | The process was killed hard without the plugin being able to react. The Report was reconstructed from the entries written up to that point, at the next start of the plugin. Until then it exists as `report_<timestamp>.jsonl` (one line per Performer) in the `reports/` folder. |

Each entry is written immediately, so at most the Performer currently being processed is lost. The Report of aborted runs lacks the `skipped` counter (Performers without empty fields), because these are not listed individually.

The Backup is also written entry by entry and is therefore complete even after an abort. **Undo last run** restores the newest Backup. The same can be done via the Task "Restore last bulk scrape".

Limitations of undo:

- **Images are not restored.**
- Fields that were previously empty are cleared for text fields. Empty numeric and selection fields (e.g. Height, Gender) cannot be reset and keep the new value.

Backups and Reports are not deleted automatically.

## Troubleshooting

| Problem | Solution |
| --- | --- |
| The button in the *Performers* tab is missing | The plugin replaces the `FilteredPerformerList` component there. If it does not exist under this name in your Stash version, the button is not shown (error messages appear in the browser console). The page is then only reachable directly via the address `/plugin/bulk-performer-scraper`. |
| The Task fails with a GraphQL error | Some field names differ depending on the Stash version (e.g. `career_length`). Adjust the constants `PERFORMER_FIELDS` and `SCRAPED_FIELDS` at the top of `bulk_performer_scraper.py`. |
| Scraper list is empty | Install Scrapers (*Settings → Metadata Providers*) and reload the page. |
| Many errors or empty results | Increase the pause between requests. The Scraper may be outdated or the site may be blocking requests (rate limit, captcha). |
| Many Performers as `unsure` | Lower the name similarity or check the match manually. The list is in the Report. |
| Task "Bulk scrape performers" in the Task settings reports missing configuration | The Task requires the settings from the plugin page. Please start it via the **Bulk Scraper** button in the *Performers* tab. |

## Known limitations

- The gender filter is applied in the browser or in Python, not by Stash. It is therefore independent of the Stash version. Performers without a gender are only excluded if "Not specified" is deselected.
- The review runs in the browser. Closing the window and navigating to other Stash pages do not interfere with it. Closing or reloading the browser tab aborts it, and the result list is lost (export it beforehand if needed). While a review is running, the browser asks for confirmation before leaving the page.
- Applying as well as **Run directly** run as a Task and show progress only under *Settings → Tasks*.
- A manual match selection applies only to the current review. If you start a **New review**, it is gone. Only one match per Performer can be selected; values from different matches cannot be mixed. If the selected match yields no changes for the selected fields, the entry stays unsure and a note is shown.
- The matching logic (name comparison, Disambiguation) exists twice: in the browser for the review and in Python for **Run directly**. Changes must be made in both files.
- Selecting individual Performers (instead of All/Tag) is supported by the backend (`scope.type = "ids"`) but has no UI yet.
- Settings are stored in the browser (localStorage) and therefore apply per browser.

## Files

| File | Purpose |
| --- | --- |
| `bulk_performer_scraper.yml` | Plugin manifest with Tasks and UI integration |
| `bulk_performer_scraper.py` | Backend: scraping, mapping, Backup, restore |
| `bulk_performer_scraper.js` | UI page with Scraper, field and option selection |
| `bulk_performer_scraper.css` | Styles of the page |
