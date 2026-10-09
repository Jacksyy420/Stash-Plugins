/* Scene Snapshots - UI-Teil
 *
 * No dependency on the Stash plugin API:
 *   - The modal is plain DOM (no React/ReactDOM needed)
 *   - GraphQL runs via fetch against /graphql (same origin, session cookie)
 *   - The player button is attached via MutationObserver, not via events
 */
(function () {
  "use strict";

  const PLUGIN_ID = "scene-snapshots";
  const TASK_NAME = "Save Snapshot";
  const MIN_COUNT = 1;
  const MAX_COUNT = 24;
  const DEFAULT_COUNT = 8;
  const CANDIDATES_PER_SEGMENT = 3; // 3 frames are scored per segment, the best one wins
  const EDGE = 0.05; // skip intro/outro (5 % each)
  const RANGE_STEP = 0.1; // granularity of the time range selection in seconds
  const RANGE_MIN_GAP = 1; // smallest gap between start and end in seconds


  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  async function gql(query, variables) {
    const res = await fetch(new URL("graphql", document.baseURI), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    const json = await res.json();
    if (json.errors && json.errors.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    return json.data;
  }

  function fmtClock(sec) {
    const s = Math.floor(sec);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return (hh ? hh + ":" : "") + pad(mm) + ":" + pad(ss);
  }

  // mm:ss.t (tenths of a second)
  function fmtFine(sec) {
    const t = Math.round(sec * 10);
    return fmtClock(Math.floor(t / 10)) + "." + (t % 10);
  }

  // Scene title as a safe file name part: no path/reserved characters, at most 120 UTF-8 bytes
  function safeTitle(title) {
    let t = String(title || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .replace(/[. ]+$/, "");
    const enc = new TextEncoder();
    const chars = Array.from(t);
    while (chars.length && enc.encode(chars.join("")).length > 120) chars.pop();
    t = chars.join("").replace(/[. ]+$/, "");
    return t || "Untitled";
  }

  // File name: <scene title>_<HH-MM-SS-mmm>.jpg (the backend validates it again)
  function fileNameFor(scene, time) {
    const ms = Math.round(time * 1000);
    const pad = (n, w) => String(n).padStart(w, "0");
    const stamp =
      pad(Math.floor(ms / 3600000), 2) + "-" +
      pad(Math.floor((ms % 3600000) / 60000), 2) + "-" +
      pad(Math.floor((ms % 60000) / 1000), 2) + "-" +
      pad(ms % 1000, 3);
    return safeTitle(scene.title) + "_" + stamp + ".jpg";
  }

  /* ------------------------------------------------------------------ */
  /* Load settings and scene                                             */
  /* ------------------------------------------------------------------ */

  function normalizeSettings(s) {
    const count = Number(s.suggestionCount);
    return {
      suggestionCount: clamp(Math.round(count) || DEFAULT_COUNT, MIN_COUNT, MAX_COUNT),
      linkGallery: s.linkGallery !== false,
      tagName: typeof s.tagName === "string" ? s.tagName.trim() : "Screenshot",
      copyMetadata: s.copyMetadata !== false,
      avoidIntroOutro: s.avoidIntroOutro !== false,
    };
  }

  async function loadRawSettings() {
    const d = await gql("{ configuration { plugins } }");
    return (d.configuration.plugins || {})[PLUGIN_ID] || {};
  }

  async function loadSettings() {
    return normalizeSettings(await loadRawSettings());
  }

  async function loadScene(id) {
    const d = await gql(
      `query($id: ID!){ findScene(id:$id){
         id title date
         studio{ id }
         performers{ id name }
         galleries{ id title folder{ id } files{ id } }
         files{ path duration width height }
         paths{ stream }
       } }`,
      { id }
    );
    return d.findScene;
  }

  /* ------------------------------------------------------------------ */
  /* Capturing frames (client-side)                                      */
  /* ------------------------------------------------------------------ */

  function waitEvent(el, name, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        el.removeEventListener(name, on);
        reject(new Error("Timeout waiting for '" + name + "'"));
      }, ms || 10000);
      function on() {
        clearTimeout(timer);
        resolve();
      }
      el.addEventListener(name, on, { once: true });
    });
  }

  async function seek(video, t) {
    const p = waitEvent(video, "seeked", 10000);
    video.currentTime = t;
    await p;
  }

  // Scores a frame: brightness (0-255) and sharpness (variance of the Laplacian)
  function analyse(ctx, video, w, hgt) {
    ctx.drawImage(video, 0, 0, w, hgt);
    const px = ctx.getImageData(0, 0, w, hgt).data;
    const gray = new Float32Array(w * hgt);
    let sum = 0;
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      gray[j] = g;
      sum += g;
    }
    const brightness = sum / gray.length;
    let lapSum = 0;
    let lapSq = 0;
    let n = 0;
    for (let y = 1; y < hgt - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        lapSum += l;
        lapSq += l * l;
        n++;
      }
    }
    const mean = lapSum / n;
    return { brightness, sharpness: lapSq / n - mean * mean };
  }

  function score(a) {
    // Practically rule out nearly black or blown-out frames
    const penalty = a.brightness < 25 || a.brightness > 235 ? 0.02 : 1;
    return a.sharpness * penalty;
  }

  async function captureFrames(src, duration, range, count, onFrame, token) {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    video.src = src;
    try {
      await waitEvent(video, "loadedmetadata", 15000);
      const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) throw new Error("The browser cannot decode this video format.");

      const full = document.createElement("canvas");
      full.width = vw;
      full.height = vh;
      const fctx = full.getContext("2d");

      const sw = 160;
      const sh = Math.max(1, Math.round((sw * vh) / vw));
      const small = document.createElement("canvas");
      small.width = sw;
      small.height = sh;
      const sctx = small.getContext("2d", { willReadFrequently: true });

      const start = Math.max(0, range.start);
      const end = Math.min(range.end, dur - 0.05);
      if (end - start < 0.5) throw new Error("The selected time range is too short.");
      const span = (end - start) / count;

      for (let i = 0; i < count; i++) {
        if (token.cancelled) return;
        let best = { t: start + span * 0.5 + span * i, s: -1 };
        for (let c = 0; c < CANDIDATES_PER_SEGMENT; c++) {
          const t = start + span * i + (span * (c + 0.5)) / CANDIDATES_PER_SEGMENT;
          await seek(video, t);
          if (token.cancelled) return;
          const s = score(analyse(sctx, video, sw, sh));
          if (s > best.s) best = { t, s };
        }
        await seek(video, best.t);
        fctx.drawImage(video, 0, 0, vw, vh);
        onFrame({
          id: "f" + Math.round(best.t * 1000),
          time: best.t,
          dataUrl: full.toDataURL("image/jpeg", 0.92),
          width: vw,
          height: vh,
        });
      }
    } finally {
      video.removeAttribute("src");
      video.load();
    }
  }

  // Take the current frame straight from the player
  function grabCurrentFrame() {
    const v = document.querySelector(".video-js video");
    if (!v || !v.videoWidth) throw new Error("No player video found.");
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    return {
      id: "cur" + Math.round(v.currentTime * 1000),
      time: v.currentTime,
      dataUrl: c.toDataURL("image/jpeg", 0.92),
      width: c.width,
      height: c.height,
      current: true,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Actions: cover, save, link                                          */
  /* ------------------------------------------------------------------ */

  async function setCover(sceneId, dataUrl) {
    await gql(
      `mutation($input: SceneUpdateInput!){ sceneUpdate(input:$input){ id } }`,
      { input: { id: sceneId, cover_image: dataUrl } }
    );
    // Reload cover images already loaded on the page
    const bust = Date.now();
    document.querySelectorAll('img[src*="/scene/' + sceneId + '/screenshot"]').forEach((img) => {
      const base = img.src.split("?")[0];
      img.src = base + "?t=" + bust;
    });
  }

  async function setPerformerImage(performerId, dataUrl) {
    await gql(
      `mutation($input: PerformerUpdateInput!){ performerUpdate(input:$input){ id } }`,
      { input: { id: performerId, image: dataUrl } }
    );
    // Reload performer images already loaded on the page
    const bust = Date.now();
    document.querySelectorAll('img[src*="/performer/' + performerId + '/image"]').forEach((img) => {
      img.src = img.src.split("?")[0] + "?t=" + bust;
    });
  }

  async function waitForJob(id) {
    for (;;) {
      const d = await gql(`query($id: ID!){ findJob(input:{id:$id}){ status error } }`, { id });
      const job = d.findJob;
      if (!job) return; // job has already disappeared from the list
      if (job.status === "FINISHED") return;
      if (job.status === "FAILED" || job.status === "CANCELLED") {
        throw new Error(job.error || "Task " + job.status.toLowerCase());
      }
      await sleep(500);
    }
  }

  // Waits until the scan has created the image
  async function waitForImage(filename, timeoutMs) {
    const q = `query($q: String!){
      findImages(image_filter:{ path:{ value:$q, modifier:INCLUDES } }, filter:{ per_page: 10 }){
        images{ id files{ path } }
      } }`;
    const deadline = Date.now() + (timeoutMs || 90000);
    while (Date.now() < deadline) {
      const d = await gql(q, { q: filename });
      const img = d.findImages.images.find((i) => i.files.some((f) => f.path.endsWith(filename)));
      if (img) return img;
      await sleep(1500);
    }
    throw new Error("Scan did not finish in time. The image will be imported later but is not linked.");
  }

  const SNAPSHOT_SUFFIX = " – Snapshots";

  // Returns {id, title} of the gallery the images go into:
  // 1. a manual gallery already linked to the scene (preferring the "– Snapshots" gallery),
  // 2. otherwise a gallery with the snapshot title (gets linked to the scene),
  // 3. otherwise a new gallery.
  // Folder and zip galleries do not accept images and are skipped.
  async function ensureGallery(scene) {
    const manual = (scene.galleries || []).filter(
      (g) => !g.folder && !(g.files && g.files.length)
    );
    if (manual.length) {
      const g =
        manual.find((x) => (x.title || "").endsWith(SNAPSHOT_SUFFIX)) || manual[0];
      return { id: g.id, title: g.title || "Gallery " + g.id };
    }

    const title = (scene.title || "Scene " + scene.id) + SNAPSHOT_SUFFIX;
    const found = await gql(
      `query($t: String!){
         findGalleries(gallery_filter:{ title:{ value:$t, modifier:EQUALS } }, filter:{ per_page: 5 }){
           galleries{ id scenes{ id } }
         } }`,
      { t: title }
    );
    const existing = found.findGalleries.galleries[0];
    if (existing) {
      const ids = existing.scenes.map((x) => x.id);
      if (!ids.includes(scene.id)) {
        await gql(
          `mutation($input: GalleryUpdateInput!){ galleryUpdate(input:$input){ id } }`,
          { input: { id: existing.id, scene_ids: ids.concat(scene.id) } }
        );
      }
      return { id: existing.id, title };
    }
    const created = await gql(
      `mutation($input: GalleryCreateInput!){ galleryCreate(input:$input){ id } }`,
      { input: { title, scene_ids: [scene.id] } }
    );
    return { id: created.galleryCreate.id, title };
  }

  async function ensureTag(name) {
    const found = await gql(
      `query($n: String!){
         findTags(tag_filter:{ name:{ value:$n, modifier:EQUALS } }, filter:{ per_page: 1 }){ tags{ id } }
       }`,
      { n: name }
    );
    if (found.findTags.tags[0]) return found.findTags.tags[0].id;
    const created = await gql(
      `mutation($input: TagCreateInput!){ tagCreate(input:$input){ id } }`,
      { input: { name } }
    );
    return created.tagCreate.id;
  }

  async function linkImage(scene, imageId, settings, cache) {
    if (settings.linkGallery) {
      if (!cache.galleryId) {
        const g = await ensureGallery(scene);
        cache.galleryId = g.id;
        cache.galleryTitle = g.title;
      }
      await gql(
        `mutation($input: GalleryAddInput!){ addGalleryImages(input:$input) }`,
        { input: { gallery_id: cache.galleryId, image_ids: [imageId] } }
      );
    }

    // Write tag and scene metadata to the image in a single update
    const input = { ids: [imageId] };
    if (settings.tagName) {
      if (!cache.tagId) cache.tagId = await ensureTag(settings.tagName);
      input.tag_ids = { ids: [cache.tagId], mode: "ADD" };
    }
    if (settings.copyMetadata) {
      if (scene.performers && scene.performers.length) {
        input.performer_ids = { ids: scene.performers.map((p) => p.id), mode: "ADD" };
      }
      if (scene.studio) input.studio_id = scene.studio.id;
      if (scene.date) input.date = scene.date;
    }
    if (Object.keys(input).length > 1) {
      await gql(
        `mutation($input: BulkImageUpdateInput!){ bulkImageUpdate(input:$input){ id } }`,
        { input }
      );
    }
  }

  async function saveAsImage(scene, frame, settings, cache, onStep) {
    const filename = fileNameFor(scene, frame.time);

    onStep("Extracting frame…");
    const run = await gql(
      `mutation($pid: ID!, $task: String!, $args: Map){
         runPluginTask(plugin_id:$pid, task_name:$task, args_map:$args)
       }`,
      {
        pid: PLUGIN_ID,
        task: TASK_NAME,
        args: { scene_id: String(scene.id), time: frame.time, filename },
      }
    );
    await waitForJob(run.runPluginTask);

    onStep("Waiting for scan…");
    const image = await waitForImage(filename);

    if (settings.linkGallery || settings.tagName || settings.copyMetadata) {
      onStep("Linking…");
      await linkImage(scene, image.id, settings, cache);
    }
    return image;
  }

  /* ------------------------------------------------------------------ */
  /* Modal (plain DOM, no React dependency)                              */
  /* ------------------------------------------------------------------ */

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        if (k === "class") e.className = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), attrs[k]);
        else e.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach((c) => c && e.appendChild(c));
    return e;
  }

  function button(text, cls, onclick) {
    return el("button", { type: "button", class: cls, text: text, onclick: onclick });
  }

  function currentSceneId() {
    const m = location.pathname.match(/\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  /* ------------------------------------------------------------------ */
  /* Settings window (sits above the snapshot window)                    */
  /* ------------------------------------------------------------------ */

  const SETTING_FIELDS = [
    {
      key: "suggestionCount", type: "number", label: "Number of suggestions", min: MIN_COUNT, max: MAX_COUNT,
      help: "Default number of suggested frames (1–24). Can be changed in the window with the slider.",
    },
    {
      key: "outputFolder", type: "text", label: "Target folder inside the library", placeholder: "Screenshots",
      help: "Subfolder in the scene's library root where images are saved. Empty = “Screenshots”.",
    },
    {
      key: "jpegQuality", type: "number", label: "JPEG quality", min: 2, max: 31,
      help: "ffmpeg scale 2–31. Lower means better quality (default 2).",
    },
    {
      key: "linkGallery", type: "checkbox", label: "Add to gallery",
      help: "Put saved images into a gallery of the scene. If the scene already has a manual gallery it is used, otherwise a new one is created.",
    },
    {
      key: "tagName", type: "text", label: "Tag for snapshots", placeholder: "Screenshot",
      help: "Saved images get this tag. Leave empty for no tag.",
    },
    {
      key: "avoidIntroOutro", type: "checkbox", label: "Avoid intro and outro",
      help: "Only suggest frames between 5 % and 95 % of the scene length. Can be changed per run in the main window.",
    },
    {
      key: "copyMetadata", type: "checkbox", label: "Copy metadata",
      help: "Copy performers, studio and date of the scene to saved images, where available.",
    },
  ];

  // Display values for the form (defaults included)
  function settingsToForm(raw) {
    const n = normalizeSettings(raw);
    return {
      suggestionCount: n.suggestionCount,
      outputFolder: typeof raw.outputFolder === "string" ? raw.outputFolder : "",
      jpegQuality: clamp(Math.round(Number(raw.jpegQuality)) || 2, 2, 31),
      linkGallery: n.linkGallery,
      tagName: n.tagName,
      avoidIntroOutro: n.avoidIntroOutro,
      copyMetadata: n.copyMetadata,
    };
  }

  let settingsOverlay = null;

  function closeSettingsModal() {
    if (settingsOverlay) settingsOverlay.remove();
    settingsOverlay = null;
  }

  // onSaved(normalizedSettings) is called after a successful save
  async function openSettingsModal(onSaved) {
    if (settingsOverlay) return;

    const errorEl = el("div", { class: "ss-error" });
    errorEl.style.display = "none";
    const form = el("div", { class: "ss-form" }, [el("p", { class: "ss-help", text: "Loading settings…" })]);
    const inputs = {};
    const saveBtn = button("Save", "ss-btn-action ss-primary", save);
    const cancelBtn = button("Cancel", "ss-btn-action", closeSettingsModal);
    saveBtn.disabled = true;

    const modal = el(
      "div",
      { class: "ss-modal ss-modal-narrow", role: "dialog", "aria-modal": "true", "aria-label": "Settings" },
      [
        el("header", { class: "ss-header" }, [
          el("div", null, [
            el("h2", { text: "Settings" }),
            el("p", { class: "ss-sub", text: "Plugin “Scene Snapshots”" }),
          ]),
          el("button", { type: "button", class: "ss-close", "aria-label": "Close", text: "×", onclick: closeSettingsModal }),
        ]),
        errorEl,
        form,
        el("footer", { class: "ss-footer" }, [cancelBtn, saveBtn]),
      ]
    );

    settingsOverlay = el("div", { class: "ss-overlay ss-overlay-top" }, [modal]);
    settingsOverlay.addEventListener("mousedown", (e) => {
      if (e.target === settingsOverlay) closeSettingsModal();
    });
    document.body.appendChild(settingsOverlay);

    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (!settingsOverlay) {
        document.removeEventListener("keydown", onKey);
        return;
      }
      closeSettingsModal();
      document.removeEventListener("keydown", onKey);
    };
    document.addEventListener("keydown", onKey);

    function showError(msg) {
      errorEl.textContent = msg || "";
      errorEl.style.display = msg ? "" : "none";
    }

    function addField(f, value) {
      const id = "ss-set-" + f.key;
      let input;
      if (f.type === "checkbox") {
        input = el("input", { type: "checkbox", id: id });
        input.checked = !!value;
      } else {
        input = el("input", { type: f.type, id: id, class: "ss-input" });
        if (f.min != null) {
          input.min = f.min;
          input.max = f.max;
        }
        if (f.placeholder) input.placeholder = f.placeholder;
        input.value = value;
      }
      inputs[f.key] = input;
      const help = el("p", { class: "ss-help", text: f.help });
      form.appendChild(
        f.type === "checkbox"
          ? el("div", { class: "ss-field ss-field-check" }, [
              el("label", { for: id }, [input, el("span", { text: f.label })]),
              help,
            ])
          : el("div", { class: "ss-field" }, [el("label", { for: id, text: f.label }), input, help])
      );
    }

    async function save() {
      showError(null);
      const vals = {};
      for (const f of SETTING_FIELDS) {
        const input = inputs[f.key];
        if (f.type === "checkbox") {
          vals[f.key] = input.checked;
        } else if (f.type === "number") {
          const n = Math.round(Number(input.value));
          if (input.value === "" || !isFinite(n) || n < f.min || n > f.max) {
            showError(f.label + ": Please enter a value between " + f.min + " and " + f.max + ".");
            return;
          }
          vals[f.key] = n;
        } else {
          vals[f.key] = input.value.trim();
        }
      }
      if (/(^|[\\/])\.\.([\\/]|$)/.test(vals.outputFolder)) {
        showError("Target folder: “..” is not allowed.");
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "…";
      try {
        // Reload and merge so that unknown keys are preserved
        const fresh = await loadRawSettings();
        const merged = Object.assign({}, fresh, vals);
        await gql(
          `mutation($pid: ID!, $input: Map!){ configurePlugin(plugin_id:$pid, input:$input) }`,
          { pid: PLUGIN_ID, input: merged }
        );
        closeSettingsModal();
        onSaved(normalizeSettings(merged));
      } catch (e) {
        showError("Saving failed: " + e.message);
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
      }
    }

    try {
      const values = settingsToForm(await loadRawSettings());
      if (!settingsOverlay) return; // closed in the meantime
      form.textContent = "";
      SETTING_FIELDS.forEach((f) => addField(f, values[f.key]));
      saveBtn.disabled = false;
    } catch (e) {
      form.textContent = "";
      showError("Could not load settings: " + e.message);
    }
  }

  let overlay = null;

  function openModal() {
    const sceneId = currentSceneId();
    if (!sceneId) {
      alert("Scene Snapshots: No scene ID found in the URL (" + location.pathname + ").");
      return;
    }
    if (overlay) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    const player = document.querySelector(".video-js video");
    if (player && !player.paused) player.pause();

    const state = {
      scene: null,
      settings: null,
      count: DEFAULT_COUNT,
      avoid: true,
      lastRange: null, // time range of the last run
      token: { cancelled: false },
      cache: {},
      cards: new Map(),
    };

    /* --- Elements --- */
    const subEl = el("p", { class: "ss-sub" });
    const sliderLabel = el("span", { text: "Suggestions: " + DEFAULT_COUNT });
    const slider = el("input", { type: "range", min: MIN_COUNT, max: MAX_COUNT, value: DEFAULT_COUNT });
    slider.disabled = true;
    slider.addEventListener("input", () => {
      state.count = Number(slider.value);
      sliderLabel.textContent = "Suggestions: " + state.count;
    });
    const regenBtn = button("Load screenshots", "ss-btn-action ss-primary", () => generate());
    const grabBtn = button("Use current frame", "ss-btn-action", onGrab);
    const settingsBtn = button("Settings", "ss-btn-action", openSettings);
    settingsBtn.disabled = true;
    regenBtn.disabled = true;
    grabBtn.disabled = true;

    // Time range
    const fromLabel = el("span", { class: "ss-rangeval", text: "From: 00:00.0" });
    const toLabel = el("span", { class: "ss-rangeval ss-rangeval-end", text: "To: 00:00.0" });
    const fromSlider = el("input", {
      type: "range", min: 0, max: 1, step: RANGE_STEP, value: 0, "aria-label": "Time range start",
    });
    const toSlider = el("input", {
      type: "range", min: 0, max: 1, step: RANGE_STEP, value: 1, "aria-label": "Time range end",
    });
    const rangeFill = el("div", { class: "ss-range-fill" });
    const rangeBox = el(
      "div",
      {
        class: "ss-range",
        title: "Arrow keys: ±1 s, Shift + arrow keys: ±0.1 s",
      },
      [el("div", { class: "ss-range-track" }), rangeFill, fromSlider, toSlider]
    );
    const effEl = el("span", { class: "ss-effective" });
    fromSlider.disabled = toSlider.disabled = true;
    fromSlider.addEventListener("input", () => updateRange("from"));
    toSlider.addEventListener("input", () => updateRange("to"));
    // Keyboard: ±1 s, with Shift ±0.1 s
    [fromSlider, toSlider].forEach((inp) =>
      inp.addEventListener("keydown", (e) => {
        const k = e.key;
        if (k !== "ArrowLeft" && k !== "ArrowRight" && k !== "ArrowUp" && k !== "ArrowDown") return;
        e.preventDefault();
        const dir = k === "ArrowRight" || k === "ArrowUp" ? 1 : -1;
        inp.value = Number(inp.value) + dir * (e.shiftKey ? RANGE_STEP : 1);
        inp.dispatchEvent(new Event("input"));
      })
    );

    // Options with hover explanation
    const avoidInput = el("input", { type: "checkbox" });
    avoidInput.checked = true;
    avoidInput.disabled = true;
    avoidInput.addEventListener("change", () => {
      state.avoid = avoidInput.checked;
      updateEffective();
    });
    const avoidLabel = el("label", { class: "ss-check", tabindex: "0" }, [
      avoidInput,
      el("span", { text: "Avoid intro and outro" }),
      el("span", {
        class: "ss-tip",
        role: "tooltip",
        text:
          "Tries to skip intro and outro: only frames between 5 % and 95 % of the scene length are suggested. A selected time range is narrowed accordingly.",
      }),
    ]);

    const galleryInput = el("input", { type: "checkbox" });
    galleryInput.disabled = true;
    galleryInput.addEventListener("change", () => {
      if (state.settings) state.settings.linkGallery = galleryInput.checked;
    });
    const galleryLabel = el("label", { class: "ss-check", tabindex: "0" }, [
      galleryInput,
      el("span", { text: "Add to gallery" }),
      el("span", {
        class: "ss-tip",
        role: "tooltip",
        text:
          "The image is put into a gallery of the scene. If the scene already has a manual gallery it is used. Otherwise “<scene title> – Snapshots” is created and linked to the scene.",
      }),
    ]);

    function sceneDuration() {
      const d = (state.scene && state.scene.files[0].duration) || 0;
      return Math.floor(d * 10) / 10;
    }

    const round1 = (v) => Math.round(v * 10) / 10;

    // Time range actually used, in seconds
    function getRange() {
      const dur = (state.scene && state.scene.files[0].duration) || 0;
      let a = Number(fromSlider.value);
      let b = Number(toSlider.value);
      if (state.avoid) {
        a = Math.max(a, dur * EDGE);
        b = Math.min(b, dur * (1 - EDGE));
      }
      return { start: a, end: b };
    }

    // Shows the time range that was actually used in the last run
    function updateEffective() {
      const r = state.lastRange;
      effEl.textContent = r
        ? "Last used: " + fmtFine(r.start) + " – " + fmtFine(r.end)
        : "Last used: –";
    }

    function updateRange(changed) {
      const max = sceneDuration();
      let a = Number(fromSlider.value);
      let b = Number(toSlider.value);
      if (changed === "from" && a > b - RANGE_MIN_GAP) a = Math.max(0, b - RANGE_MIN_GAP);
      if (changed === "to" && b < a + RANGE_MIN_GAP) b = Math.min(max, a + RANGE_MIN_GAP);
      a = round1(a);
      b = round1(b);
      fromSlider.value = a;
      toSlider.value = b;
      fromLabel.textContent = "From: " + fmtFine(a);
      toLabel.textContent = "To: " + fmtFine(b);

      // Highlighted range (account for the 16 px thumb width)
      const pa = max ? a / max : 0;
      const pb = max ? b / max : 1;
      rangeFill.style.left = "calc(8px + (100% - 16px) * " + pa + ")";
      rangeFill.style.width = "calc((100% - 16px) * " + (pb - pa) + ")";
      // If both thumbs are at the right edge, the left one must stay grabbable
      fromSlider.style.zIndex = pa > 0.5 ? 4 : 2;
      updateEffective();
    }

    const errorEl = el("div", { class: "ss-error" });
    errorEl.style.display = "none";
    const grid = el("div", { class: "ss-grid" });
    const statusEl = el("div", { class: "ss-status", text: "Loading scene…" });
    const HINT = "Set the time range and number, then click “Load screenshots”.";

    const modal = el("div", { class: "ss-modal", role: "dialog", "aria-modal": "true", "aria-label": "Screenshots" }, [
      el("header", { class: "ss-header" }, [
        el("div", null, [el("h2", { text: "Screenshots" }), subEl]),
        el("button", { type: "button", class: "ss-close", "aria-label": "Close", text: "×", onclick: close }),
      ]),
      el("div", { class: "ss-toolbar" }, [
        el("div", { class: "ss-row" }, [
          el("label", { class: "ss-slider" }, [sliderLabel, slider]),
          regenBtn,
          grabBtn,
          settingsBtn,
        ]),
        el("div", { class: "ss-row ss-row-range" }, [
          el("span", { class: "ss-rowtitle", text: "Time range" }),
          fromLabel,
          rangeBox,
          toLabel,
          effEl,
        ]),
        el("div", { class: "ss-row" }, [avoidLabel, galleryLabel]),
      ]),
      errorEl,
      grid,
      statusEl,
    ]);

    overlay = el("div", { class: "ss-overlay" }, [modal]);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);

    const onKey = (e) => e.key === "Escape" && !settingsOverlay && close();
    document.addEventListener("keydown", onKey);

    function close() {
      closeSettingsModal();
      state.token.cancelled = true;
      document.removeEventListener("keydown", onKey);
      if (overlay) overlay.remove();
      overlay = null;
    }

    function showError(msg) {
      errorEl.textContent = msg || "";
      errorEl.style.display = msg ? "" : "none";
    }

    function setMsg(card, text, isError) {
      card.msg.textContent = text || "";
      card.msg.className = "ss-msg" + (isError ? " ss-msg-error" : "");
    }

    /* --- Cards --- */
    function addCard(frame, prepend) {
      const old = state.cards.get(frame.id);
      if (old) old.fig.remove();

      const card = { frame: frame };
      card.saveBtn = button("Save as image", "ss-btn-action", () => onSave(card));
      card.coverBtn = button("Set as cover", "ss-btn-action ss-primary", () => onCover(card));
      card.msg = el("div", { class: "ss-msg" });

      // Performer image: only if the scene has performers; a selector if there are several
      const performers = (state.scene && state.scene.performers) || [];
      let perfRow = null;
      if (performers.length) {
        if (performers.length > 1) {
          card.perfSelect = el(
            "select",
            { class: "ss-select", "aria-label": "Choose performer" },
            performers.map((p) => el("option", { value: p.id, text: p.name }))
          );
        }
        card.perfBtn = button("Set as performer image", "ss-btn-action", () => onPerformer(card));
        card.perfBtn.title = performers.length === 1 ? "For " + performers[0].name : "For the selected performer";
        perfRow = el("div", { class: "ss-actions" }, [card.perfSelect, card.perfBtn]);
      }

      card.fig = el("figure", { class: "ss-card" + (frame.current ? " ss-card-current" : "") }, [
        el("img", {
          src: frame.dataUrl,
          alt: "Frame at " + fmtFine(frame.time),
          width: frame.width,
          height: frame.height,
          style: "aspect-ratio: " + frame.width + " / " + frame.height,
        }),
        el("figcaption", null, [
          el("span", { class: "ss-time", text: (frame.current ? "Current · " : "") + fmtFine(frame.time) }),
          el("div", { class: "ss-actions" }, [card.saveBtn, card.coverBtn]),
          perfRow,
          card.msg,
        ]),
      ]);
      state.cards.set(frame.id, card);
      if (prepend) grid.insertBefore(card.fig, grid.firstChild);
      else grid.appendChild(card.fig);
    }

    function setBusy(card, busy) {
      card.saveBtn.disabled = card.coverBtn.disabled = busy;
      if (card.perfBtn) card.perfBtn.disabled = busy;
      if (card.perfSelect) card.perfSelect.disabled = busy;
    }

    async function onPerformer(card) {
      const performers = (state.scene && state.scene.performers) || [];
      const id = card.perfSelect ? card.perfSelect.value : performers[0] && performers[0].id;
      const perf = performers.find((p) => p.id === id);
      if (!perf) return;
      if (!confirm("Are you sure you want to replace the image of “" + perf.name + "” with this frame?")) return;
      setBusy(card, true);
      card.perfBtn.textContent = "…";
      setMsg(card, "");
      try {
        await setPerformerImage(perf.id, card.frame.dataUrl);
        setMsg(card, "Performer image of " + perf.name + " updated.");
      } catch (e) {
        setMsg(card, e.message, true);
      } finally {
        card.perfBtn.textContent = "Set as performer image";
        setBusy(card, false);
      }
    }

    async function onSave(card) {
      setBusy(card, true);
      card.saveBtn.textContent = "…";
      setMsg(card, "");
      try {
        await saveAsImage(state.scene, card.frame, state.settings, state.cache, (m) => setMsg(card, m));
        card.saveBtn.textContent = "Saved";
        setMsg(
          card,
          state.settings.linkGallery && state.cache.galleryTitle
            ? "Saved to the library path and added to gallery “" + state.cache.galleryTitle + "”."
            : "Saved to the library path."
        );
      } catch (e) {
        card.saveBtn.textContent = "Save as image";
        setMsg(card, e.message, true);
      } finally {
        setBusy(card, false);
      }
    }

    async function onCover(card) {
      setBusy(card, true);
      card.coverBtn.textContent = "…";
      setMsg(card, "");
      try {
        await setCover(state.scene.id, card.frame.dataUrl);
        card.coverBtn.textContent = "Cover set";
        setMsg(card, "Cover image updated.");
      } catch (e) {
        card.coverBtn.textContent = "Set as cover";
        setMsg(card, e.message, true);
      } finally {
        setBusy(card, false);
      }
    }

    function openSettings() {
      openSettingsModal((norm) => {
        state.settings = norm;
        delete state.cache.tagId; // the tag name may have changed
        galleryInput.checked = norm.linkGallery;
        state.avoid = norm.avoidIntroOutro;
        avoidInput.checked = state.avoid;
        state.count = norm.suggestionCount;
        slider.value = state.count;
        sliderLabel.textContent = "Suggestions: " + state.count;
        updateEffective();
        statusEl.textContent = "Settings saved.";
      });
    }

    function onGrab() {
      try {
        addCard(grabCurrentFrame(), true);
        showError(null);
      } catch (e) {
        showError(e.message);
      }
    }

    /* --- Generate frames --- */
    async function generate() {
      state.token.cancelled = true;
      const token = { cancelled: false };
      state.token = token;
      const n = state.count;
      const range = getRange();
      if (range.end - range.start < 1) {
        showError("The selected time range is too short.");
        return;
      }
      state.lastRange = range;
      updateEffective();
      grid.textContent = "";
      state.cards.clear();
      showError(null);
      regenBtn.disabled = true;
      let done = 0;
      statusEl.textContent = "Finding frames… 0 / " + n;
      regenBtn.textContent = "Reload";
      try {
        await captureFrames(
          state.scene.paths.stream,
          state.scene.files[0].duration,
          range,
          n,
          (f) => {
            if (token.cancelled) return;
            addCard(f, false);
            statusEl.textContent = "Finding frames… " + ++done + " / " + n;
          },
          token
        );
      } catch (e) {
        if (!token.cancelled) showError(e.message);
      } finally {
        if (!token.cancelled) {
          statusEl.textContent = "";
          regenBtn.disabled = false;
        }
      }
    }

    /* --- Start --- */
    (async () => {
      try {
        const res = await Promise.all([loadScene(sceneId), loadSettings()]);
        if (!overlay) return; // closed in the meantime
        const scene = res[0];
        if (!scene || !scene.files.length) throw new Error("Scene has no video file.");
        state.scene = scene;
        state.settings = res[1];
        state.count = res[1].suggestionCount;
        slider.value = state.count;
        sliderLabel.textContent = "Suggestions: " + state.count;
        slider.disabled = false;
        grabBtn.disabled = false;
        settingsBtn.disabled = false;

        const dur = sceneDuration();
        fromSlider.max = toSlider.max = dur;
        fromSlider.value = 0;
        toSlider.value = dur;
        fromSlider.disabled = toSlider.disabled = dur < 2;
        state.avoid = res[1].avoidIntroOutro;
        avoidInput.checked = state.avoid;
        avoidInput.disabled = false;
        galleryInput.checked = res[1].linkGallery;
        galleryInput.disabled = false;
        updateRange();

        subEl.textContent = scene.title || "Scene " + scene.id;
        statusEl.textContent = HINT;
        regenBtn.disabled = false; // frames are only loaded after a click
      } catch (e) {
        console.error("[Scene Snapshots]", e);
        statusEl.textContent = "";
        showError(e.message);
      }
    })();
  }

  // For testing in the console: window.sceneSnapshots.open()
  window.sceneSnapshots = { open: openModal };

  /* ------------------------------------------------------------------ */
  /* Button in the player control bar                                    */
  /* ------------------------------------------------------------------ */

  const ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' +
    '<circle cx="12" cy="13" r="3.5"/></svg>';

  function injectButton() {
    if (!currentSceneId()) return;
    const bar = document.querySelector(".video-js .vjs-control-bar");
    if (!bar || bar.querySelector(".ss-player-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vjs-control vjs-button ss-player-btn";
    btn.title = "Suggest screenshots";
    btn.setAttribute("aria-label", "Suggest screenshots");
    btn.innerHTML = ICON;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openModal();
    });
    bar.insertBefore(btn, bar.querySelector(".vjs-fullscreen-control"));
  }

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      injectButton();
    });
  }).observe(document.body, { childList: true, subtree: true });
  injectButton();
})();
