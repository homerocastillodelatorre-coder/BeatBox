// Sidebar, My Beats, and simple account system.
// This file only reads/modifies global state exposed by app.js and does not change its logic.

(function () {
  const BEATS_STORAGE_KEY = "beatbox_my_beats";
  const PROJECTS_STORAGE_KEY = "beatbox_projects";
  const PUBLISHED_BEATS_KEY = "beatbox_published_beats";
  const COMMUNITY_LIKES_KEY = "beatbox_community_likes"; // beatId -> { username: true }
  const COMMUNITY_RATINGS_KEY = "beatbox_community_ratings"; // beatId -> { username: rating }
  const COMMUNITY_COMMENTS_KEY = "beatbox_community_comments"; // array
  const USER_STORAGE_KEY = "beatbox_user_account";

  function loadBeatsFromStorage() {
    try {
      const raw = window.localStorage.getItem(BEATS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveBeatsToStorage(beats) {
    try {
      window.localStorage.setItem(BEATS_STORAGE_KEY, JSON.stringify(beats));
    } catch {
      // ignore
    }
  }

  function loadProjectsFromStorage() {
    try {
      const raw = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveProjectsToStorage(projects) {
    try {
      window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
    } catch {
      // ignore
    }
  }

  function loadPublishedBeatsFromStorage() {
    try {
      const raw = window.localStorage.getItem(PUBLISHED_BEATS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function savePublishedBeatsToStorage(beats) {
    try {
      window.localStorage.setItem(PUBLISHED_BEATS_KEY, JSON.stringify(beats));
    } catch {
      // ignore
    }
  }

  function loadCommunityMapFromStorage(key) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveCommunityMapToStorage(key, map) {
    try {
      window.localStorage.setItem(key, JSON.stringify(map));
    } catch {
      // ignore
    }
  }

  function loadCommentsFromStorage() {
    try {
      const raw = window.localStorage.getItem(COMMUNITY_COMMENTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveCommentsToStorage(comments) {
    try {
      window.localStorage.setItem(COMMUNITY_COMMENTS_KEY, JSON.stringify(comments));
    } catch {
      // ignore
    }
  }

  function loadUserFromStorage() {
    try {
      const raw = window.localStorage.getItem(USER_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function getCurrentUsername() {
    const user = loadUserFromStorage();
    return user && user.username ? user.username : "Guest";
  }

  function saveUserToStorage(user) {
    try {
      window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    } catch {
      // ignore
    }
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  // ---- Sidebar UI ----
  function initSidebar() {
    const toggleBtn = document.getElementById("sidebar-toggle");
    const sidebar = document.getElementById("sidebar");
    const navButtons = document.querySelectorAll(".sidebar-nav-item");

    if (!toggleBtn || !sidebar) return;

    toggleBtn.addEventListener("click", () => {
      sidebar.classList.toggle("sidebar-open");
    });

    navButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.section;
        if (!targetId) return;
        document
          .querySelectorAll(".sidebar-section")
          .forEach((section) => {
            section.classList.toggle(
              "sidebar-section-active",
              section.id === targetId,
            );
          });
      });
    });
  }

  // ---- My Beats: capture & restore patterns ----
  function cloneCurrentPatterns() {
    if (typeof patterns === "undefined") return null;
    const copy = [];
    for (let p = 0; p < patterns.length; p++) {
      const grid = patterns[p];
      const gridCopy = grid.map((row) =>
        row.map((step) => ({
          active: !!step.active,
          velocity: typeof step.velocity === "number" ? step.velocity : 1,
          probability:
            typeof step.probability === "number" ? step.probability : 1,
        })),
      );
      copy.push(gridCopy);
    }
    return copy;
  }

  function applyPatternsSnapshot(snapshot) {
    if (!snapshot || typeof patterns === "undefined") return;
    const patternsCount = Math.min(patterns.length, snapshot.length);
    for (let p = 0; p < patternsCount; p++) {
      const grid = patterns[p];
      const snapGrid = snapshot[p];
      const trackCount = Math.min(grid.length, snapGrid.length);
      for (let t = 0; t < trackCount; t++) {
        const row = grid[t];
        const snapRow = snapGrid[t];
        const stepCount = Math.min(row.length, snapRow.length);
        for (let s = 0; s < stepCount; s++) {
          const src = snapRow[s];
          const dest = row[s];
          dest.active = !!src.active;
          dest.velocity =
            typeof src.velocity === "number" ? src.velocity : 1;
          dest.probability =
            typeof src.probability === "number" ? src.probability : 1;
        }
      }
    }
    if (typeof refreshWholePatternVisual === "function") {
      refreshWholePatternVisual();
    }
    if (typeof buildTimelinePatternRow === "function") {
      buildTimelinePatternRow();
    }
  }

  function saveCurrentBeat() {
    if (typeof bpm === "undefined" || typeof swingPercent === "undefined") {
      alert("Beat engine not ready yet.");
      return;
    }

    const name = window.prompt("Name this beat:");
    if (!name) return;

    const patternsSnapshot = cloneCurrentPatterns();
    if (!patternsSnapshot) {
      alert("Could not capture beat data.");
      return;
    }

    const melodySnapshot =
      typeof pianoRollNotes !== "undefined" &&
      Array.isArray(pianoRollNotes) &&
      pianoRollNotes.length
        ? JSON.parse(JSON.stringify(pianoRollNotes))
        : [];

    const beat = {
      id: Date.now().toString(),
      name: name.trim(),
      createdAt: new Date().toISOString(),
      bpm,
      swingPercent,
      stepsPerTrack,
      patterns: patternsSnapshot,
      pianoRollNotes: melodySnapshot,
    };

    const beats = loadBeatsFromStorage();
    beats.push(beat);
    saveBeatsToStorage(beats);

    // Best-effort: also send a small record to Google Sheets (if configured).
    // This should never block or break local save/publish logic.
    try {
      if (typeof saveBeatToSheet === "function") {
        const user = loadUserFromStorage();
        const username = user && user.username ? user.username : "Guest";
        saveBeatToSheet([beat.name, username, Date.now()]).catch(() => {});
      }
    } catch (err) {
      console.warn("Google Sheets save failed:", err);
    }

    // ===== ADDED: Also save beat to Firebase Firestore (cloud backup) =====
    // This runs after local save so it never blocks or breaks the existing flow.
    try {
      if (typeof window.saveBeatToFirebase === "function") {
        const user = loadUserFromStorage();
        const username = user && user.username ? user.username : "Guest";
        // NOTE: Firestore does not support nested arrays.
        // JSON.stringify the pattern so it saves as a plain string.
        window.saveBeatToFirebase({
          name:           beat.name,
          user:           username,
          bpm:            beat.bpm,
          swingPercent:   beat.swingPercent,
          stepsPerTrack:  beat.stepsPerTrack,
          pattern:        JSON.stringify(beat.patterns),
          pianoRollNotes: JSON.stringify(beat.pianoRollNotes || []),
          localId:        beat.id,
          savedAt:        beat.createdAt,
        });
        // renderBeatsListWithCloud() called after to refresh the "My Beats" panel
        // but only if it has finished — we don't await here on purpose.
      }
    } catch (err) {
      console.warn("[Firebase] Beat cloud-save hook failed:", err);
    }
    // ===== End Firebase addition =====

    renderBeatsList();
    // Refresh cloud beats list in the background (non-blocking)
    renderCloudBeatsList();
  }

  // ===== ADDED: Cloud Beats panel — loads beats from Firebase and renders them =====
  // This is appended below the local "My Beats" list in the sidebar.
  // It never modifies the local list and is fully non-blocking.
  function renderCloudBeatsList() {
    // Ensure the cloud container exists; create it once inside #my-beats-list wrapper
    // We append it below the existing local list.
    const wrapper = document.getElementById("my-beats-section");
    if (!wrapper) return;

    let cloudSection = document.getElementById("firebase-cloud-beats-section");
    if (!cloudSection) {
      // Create the section once
      cloudSection = document.createElement("div");
      cloudSection.id = "firebase-cloud-beats-section";
      cloudSection.style.marginTop = "1rem";

      const heading = document.createElement("h4");
      heading.textContent = "☁ Cloud Beats";
      heading.style.fontSize = "0.85rem";
      heading.style.color = "#9ca3af";
      heading.style.marginBottom = "0.4rem";
      cloudSection.appendChild(heading);

      const listEl = document.createElement("div");
      listEl.id = "firebase-cloud-beats-list";
      cloudSection.appendChild(listEl);

      wrapper.appendChild(cloudSection);
    }

    const listEl = document.getElementById("firebase-cloud-beats-list");
    if (!listEl) return;

    if (typeof window.loadBeatsFromFirebase !== "function") {
      listEl.innerHTML = '<p class="sidebar-hint">Firebase not configured.</p>';
      return;
    }

    listEl.innerHTML = '<p class="sidebar-hint">Loading from cloud…</p>';

    window.loadBeatsFromFirebase()
      .then((beats) => {
        listEl.innerHTML = "";
        if (!beats.length) {
          const p = document.createElement("p");
          p.className = "sidebar-hint";
          p.textContent = "No cloud beats found.";
          listEl.appendChild(p);
          return;
        }

        beats.forEach((beat) => {
          const item = document.createElement("div");
          item.className = "my-beats-item";

          const info = document.createElement("div");
          info.className = "my-beats-info";

          const title = document.createElement("div");
          title.className = "my-beats-name";
          title.textContent = (beat.name || "Untitled") + " ☁";

          const meta = document.createElement("div");
          meta.className = "my-beats-meta";
          const savedDate = beat.savedAt
            ? formatDate(beat.savedAt)
            : beat.createdAt
              ? new Date(beat.createdAt).toLocaleString()
              : "";
          meta.textContent = `${beat.user || "Guest"} • ${beat.bpm || "?"}bpm • ${savedDate}`;

          info.appendChild(title);
          info.appendChild(meta);

          const actions = document.createElement("div");
          actions.className = "my-beats-actions";

          // "Load" applies the cloud beat's pattern into the sequencer
          const loadBtn = document.createElement("button");
          loadBtn.textContent = "Load";
          loadBtn.className = "btn btn-small btn-secondary";
          loadBtn.addEventListener("click", () => {
            loadCloudBeatIntoSequencer(beat);
          });

          actions.appendChild(loadBtn);
          item.appendChild(info);
          item.appendChild(actions);
          listEl.appendChild(item);
        });
      })
      .catch((err) => {
        listEl.innerHTML = '<p class="sidebar-hint">Could not load cloud beats.</p>';
        console.error("[Firebase] renderCloudBeatsList error:", err);
      });
  }

  // Load a cloud beat (fetched from Firestore) into the local sequencer.
  // Mirrors the logic of loadBeatIntoSequencer but works with the Firestore shape.
  function loadCloudBeatIntoSequencer(beat) {
    if (!beat) return;
    if (typeof stopPlayback === "function") stopPlayback();

    // Pattern and pianoRollNotes are stored as JSON strings in Firestore
    // Parse them back to arrays before applying.
    const cloudPatterns = typeof beat.pattern === "string"
      ? JSON.parse(beat.pattern)
      : (beat.pattern || beat.patterns);

    const cloudNotes = typeof beat.pianoRollNotes === "string"
      ? JSON.parse(beat.pianoRollNotes)
      : (beat.pianoRollNotes || []);

    if (
      typeof handleStepCountChange === "function" &&
      beat.stepsPerTrack &&
      typeof stepsPerTrack !== "undefined" &&
      beat.stepsPerTrack !== stepsPerTrack
    ) {
      handleStepCountChange(beat.stepsPerTrack);
    }
    if (typeof handleBpmChange === "function" && beat.bpm) {
      handleBpmChange(beat.bpm);
    }
    if (typeof handleSwingChange === "function" && typeof beat.swingPercent === "number") {
      handleSwingChange(beat.swingPercent);
    }
    if (cloudPatterns) {
      applyPatternsSnapshot(cloudPatterns);
    }
    if (
      Array.isArray(cloudNotes) &&
      typeof pianoRollNotes !== "undefined"
    ) {
      pianoRollNotes.length = 0;
      cloudNotes.forEach((n) => pianoRollNotes.push(n));
      if (typeof refreshPianoRollVisual === "function") refreshPianoRollVisual();
    }
    console.log("[Firebase] Cloud beat loaded into sequencer:", beat.name);
  }
  // ===== End Cloud Beats panel =====

  function renderBeatsList() {
    const container = document.getElementById("my-beats-list");
    if (!container) return;
    const beats = loadBeatsFromStorage();

    container.innerHTML = "";
    if (!beats.length) {
      const p = document.createElement("p");
      p.className = "sidebar-hint";
      p.textContent =
        'No beats saved yet. Use the "Save Beat" button near the transport controls.';
      container.appendChild(p);
      return;
    }

    beats
      .slice()
      .sort((a, b) => Number(b.id) - Number(a.id))
      .forEach((beat) => {
        const item = document.createElement("div");
        item.className = "my-beats-item";

        const info = document.createElement("div");
        info.className = "my-beats-info";

        const title = document.createElement("div");
        title.className = "my-beats-name";
        title.textContent = beat.name || "Untitled Beat";

        const meta = document.createElement("div");
        meta.className = "my-beats-meta";
        meta.textContent = formatDate(beat.createdAt);

        info.appendChild(title);
        info.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "my-beats-actions";

        const loadBtn = document.createElement("button");
        loadBtn.textContent = "Load Beat";
        loadBtn.className = "btn btn-small btn-secondary";
        loadBtn.addEventListener("click", () => {
          loadBeatIntoSequencer(beat.id);
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "Delete";
        deleteBtn.className = "btn btn-small btn-secondary";
        deleteBtn.addEventListener("click", () => {
          deleteBeat(beat.id);
        });

        const publishBtn = document.createElement("button");
        publishBtn.textContent = "Publish";
        publishBtn.className = "btn btn-small btn-secondary";
        publishBtn.addEventListener("click", () => {
          publishBeatToCommunity(beat.id);
        });

        actions.appendChild(loadBtn);
        actions.appendChild(deleteBtn);
        actions.appendChild(publishBtn);

        item.appendChild(info);
        item.appendChild(actions);
        container.appendChild(item);
      });
  }

  function loadBeatIntoSequencer(beatId) {
    const beats = loadBeatsFromStorage();
    const beat = beats.find((b) => b.id === beatId);
    if (!beat) return;

    if (typeof stopPlayback === "function") {
      stopPlayback();
    }

    if (
      typeof handleStepCountChange === "function" &&
      typeof stepsPerTrack !== "undefined" &&
      beat.stepsPerTrack &&
      beat.stepsPerTrack !== stepsPerTrack
    ) {
      handleStepCountChange(beat.stepsPerTrack);
    }

    if (typeof handleBpmChange === "function" && typeof bpm !== "undefined") {
      handleBpmChange(beat.bpm || bpm);
    }
    if (
      typeof handleSwingChange === "function" &&
      typeof swingPercent !== "undefined"
    ) {
      handleSwingChange(
        typeof beat.swingPercent === "number"
          ? beat.swingPercent
          : swingPercent,
      );
    }

    applyPatternsSnapshot(beat.patterns);

    // Restore melody if present in the saved beat.
    if (
      beat.pianoRollNotes &&
      Array.isArray(beat.pianoRollNotes) &&
      typeof pianoRollNotes !== "undefined"
    ) {
      pianoRollNotes.length = 0;
      beat.pianoRollNotes.forEach((n) => pianoRollNotes.push(n));
      if (typeof refreshPianoRollVisual === "function") {
        refreshPianoRollVisual();
      }
    }
  }

  function deleteBeat(beatId) {
    const beats = loadBeatsFromStorage();
    const next = beats.filter((b) => b.id !== beatId);
    saveBeatsToStorage(next);
    renderBeatsList();
  }

  function initSaveBeatButton() {
    const btn = document.getElementById("save-beat-button");
    if (!btn) return;
    btn.addEventListener("click", saveCurrentBeat);
  }

  // ---- Projects: capture & restore full project state ----
  function saveCurrentProject() {
    if (typeof window.getProjectSnapshot !== "function") {
      alert("Project engine not ready yet.");
      return;
    }

    const name = window.prompt("Name this project:");
    if (!name) return;

    const snapshot = window.getProjectSnapshot();
    if (!snapshot) {
      alert("Could not capture project state.");
      return;
    }

    const projects = loadProjectsFromStorage();
    projects.push({
      id: snapshot.id,
      name: name.trim(),
      createdAt: snapshot.savedAt,
      snapshot,
    });
    saveProjectsToStorage(projects);
    renderProjectsList();
  }

  function loadProjectIntoApp(projectId) {
    const projects = loadProjectsFromStorage();
    const proj = projects.find((p) => p.id === projectId);
    if (!proj) return;

    if (typeof window.applyProjectSnapshot !== "function") return;
    window.applyProjectSnapshot(proj.snapshot);
  }

  function deleteProject(projectId) {
    const projects = loadProjectsFromStorage();
    const next = projects.filter((p) => p.id !== projectId);
    saveProjectsToStorage(next);
    renderProjectsList();
  }

  function renderProjectsList() {
    const container = document.getElementById("projects-list");
    if (!container) return;

    const projects = loadProjectsFromStorage();
    container.innerHTML = "";

    if (!projects.length) {
      const p = document.createElement("p");
      p.className = "sidebar-hint";
      p.textContent = "No projects saved yet. Use “Save Project” to create one.";
      container.appendChild(p);
      return;
    }

    projects
      .slice()
      .sort((a, b) => Number(b.id) - Number(a.id))
      .forEach((proj) => {
        const item = document.createElement("div");
        item.className = "my-beats-item";

        const info = document.createElement("div");
        info.className = "my-beats-info";

        const title = document.createElement("div");
        title.className = "my-beats-name";
        title.textContent = proj.name || "Untitled Project";

        const meta = document.createElement("div");
        meta.className = "my-beats-meta";
        meta.textContent = formatDate(proj.createdAt || proj.snapshot?.savedAt);

        info.appendChild(title);
        info.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "my-beats-actions";

        const loadBtn = document.createElement("button");
        loadBtn.textContent = "Load";
        loadBtn.className = "btn btn-small btn-secondary";
        loadBtn.addEventListener("click", () => loadProjectIntoApp(proj.id));

        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "Delete";
        deleteBtn.className = "btn btn-small btn-secondary";
        deleteBtn.addEventListener("click", () => deleteProject(proj.id));

        actions.appendChild(loadBtn);
        actions.appendChild(deleteBtn);

        item.appendChild(info);
        item.appendChild(actions);
        container.appendChild(item);
      });
  }

  // ---- Community / Explore ----
  function applyBeatObjectToSequencer(beat) {
    if (!beat || !beat.patterns) return;

    if (typeof stopPlayback === "function") {
      stopPlayback();
    }

    if (
      typeof handleStepCountChange === "function" &&
      typeof stepsPerTrack !== "undefined" &&
      beat.stepsPerTrack &&
      beat.stepsPerTrack !== stepsPerTrack
    ) {
      handleStepCountChange(beat.stepsPerTrack);
    }

    if (typeof handleBpmChange === "function" && typeof bpm !== "undefined") {
      handleBpmChange(beat.bpm || bpm);
    }

    if (typeof handleSwingChange === "function" && typeof swingPercent !== "undefined") {
      handleSwingChange(
        typeof beat.swingPercent === "number" ? beat.swingPercent : swingPercent,
      );
    }

    applyPatternsSnapshot(beat.patterns);

    if (beat.pianoRollNotes && Array.isArray(beat.pianoRollNotes) && typeof pianoRollNotes !== "undefined") {
      pianoRollNotes.length = 0;
      beat.pianoRollNotes.forEach((n) => pianoRollNotes.push(n));
      if (typeof refreshPianoRollVisual === "function") {
        refreshPianoRollVisual();
      }
    }
  }

  function publishBeatToCommunity(beatId) {
    const beats = loadBeatsFromStorage();
    const beat = beats.find((b) => b.id === beatId);
    if (!beat) return;

    const username = getCurrentUsername();
    const genrePrompt = window.prompt(
      "Genre for this beat (e.g., Hip-Hop, House, Trap):",
      "General",
    );
    const genre = (genrePrompt || "General").trim() || "General";

    const published = loadPublishedBeatsFromStorage();
    const publishedBeat = {
      ...beat,
      genre,
      publisher: username,
      publishedAt: new Date().toISOString(),
    };

    const idx = published.findIndex((b) => b.id === beatId);
    if (idx >= 0) published[idx] = publishedBeat;
    else published.push(publishedBeat);

    savePublishedBeatsToStorage(published);
    // Best-effort: also record publish action to Google Sheets.
    try {
      if (typeof saveBeatToSheet === "function") {
        saveBeatToSheet([beat.name, username, Date.now()]).catch(() => {});
      }
    } catch {
      // ignore
    }
    renderExploreBeatsList();
    alert("Beat published to community feed.");
  }

  function renderExploreBeatsList() {
    const listEl = document.getElementById("explore-beats-list");
    const searchEl = document.getElementById("explore-search-input");
    const genreEl = document.getElementById("explore-genre-filter");
    if (!listEl || !genreEl) return;

    const searchQ = (searchEl && searchEl.value ? searchEl.value : "")
      .trim()
      .toLowerCase();
    const selectedGenre = genreEl.value || "All";

    const published = loadPublishedBeatsFromStorage();
    const likesMap = loadCommunityMapFromStorage(COMMUNITY_LIKES_KEY);
    const ratingsMap = loadCommunityMapFromStorage(COMMUNITY_RATINGS_KEY);
    const allComments = loadCommentsFromStorage();

    // Build genre options from current feed.
    const genres = Array.from(
      new Set(published.map((b) => (b.genre ? String(b.genre) : "General"))),
    ).sort((a, b) => a.localeCompare(b));

    const currentSelected = selectedGenre;
    genreEl.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "All";
    allOpt.textContent = "All genres";
    genreEl.appendChild(allOpt);
    genres.forEach((g) => {
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      genreEl.appendChild(opt);
    });
    genreEl.value = genres.includes(currentSelected) ? currentSelected : "All";

    const finalSelectedGenre = genreEl.value || "All";

    const filtered = published.filter((b) => {
      const nameOk = b.name
        ? String(b.name).toLowerCase().includes(searchQ)
        : true;
      const genreOk =
        finalSelectedGenre === "All"
          ? true
          : (b.genre ? String(b.genre) : "General") === finalSelectedGenre;
      return nameOk && genreOk;
    });

    listEl.innerHTML = "";

    if (!filtered.length) {
      const p = document.createElement("p");
      p.className = "sidebar-hint";
      p.textContent = "No published beats match your filters.";
      listEl.appendChild(p);
      return;
    }

    filtered
      .slice()
      .sort((a, b) => Number(b.id) - Number(a.id))
      .forEach((beat) => {
        const beatId = beat.id;
        const username = getCurrentUsername();

        const likesForBeat = likesMap[beatId] || {};
        const liked = !!likesForBeat[username];
        const likeCount = Object.keys(likesForBeat).length;

        const ratingsForBeat = ratingsMap[beatId] || {};
        const userRating = ratingsForBeat[username] || 0;
        const ratingValues = Object.values(ratingsForBeat).filter(
          (v) => typeof v === "number" && v >= 1 && v <= 5,
        );
        const avgRating =
          ratingValues.length > 0
            ? ratingValues.reduce((a, c) => a + c, 0) / ratingValues.length
            : 0;

        const commentsForBeat = allComments
          .filter((c) => c.beatId === beatId)
          .slice()
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

        const item = document.createElement("div");
        item.className = "my-beats-item";

        const info = document.createElement("div");
        info.className = "my-beats-info";

        const title = document.createElement("div");
        title.className = "my-beats-name";
        title.textContent = beat.name || "Untitled Beat";

        const meta = document.createElement("div");
        meta.className = "my-beats-meta";
        const genreLabel = beat.genre ? String(beat.genre) : "General";
        meta.textContent = `Genre: ${genreLabel} • By ${beat.publisher || "Unknown"} • ${formatDate(
          beat.publishedAt || beat.createdAt,
        )}`;

        info.appendChild(title);
        info.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "my-beats-actions";

        const loadBtn = document.createElement("button");
        loadBtn.textContent = "Load";
        loadBtn.className = "btn btn-small btn-secondary";
        loadBtn.addEventListener("click", () => {
          applyBeatObjectToSequencer(beat);
        });

        const likeBtn = document.createElement("button");
        likeBtn.textContent = liked ? `Unlike (${likeCount})` : `Like (${likeCount})`;
        likeBtn.className = "btn btn-small btn-secondary";
        likeBtn.addEventListener("click", () => {
          const nextLikesMap = loadCommunityMapFromStorage(COMMUNITY_LIKES_KEY);
          nextLikesMap[beatId] = nextLikesMap[beatId] || {};
          const nextLiked = !nextLikesMap[beatId][username];
          if (nextLiked) nextLikesMap[beatId][username] = true;
          else delete nextLikesMap[beatId][username];
          saveCommunityMapToStorage(COMMUNITY_LIKES_KEY, nextLikesMap);
          renderExploreBeatsList();
        });

        const ratingSelect = document.createElement("select");
        ratingSelect.style.borderRadius = "0.6rem";
        ratingSelect.style.padding = "0.3rem 0.4rem";
        ratingSelect.style.background = "#020617";
        ratingSelect.style.color = "#e5e7eb";
        ratingSelect.style.border = "1px solid rgba(55, 65, 81, 0.9)";
        ratingSelect.innerHTML = `
          <option value="0">Rate</option>
          <option value="1">1 ★</option>
          <option value="2">2 ★</option>
          <option value="3">3 ★</option>
          <option value="4">4 ★</option>
          <option value="5">5 ★</option>
        `;
        ratingSelect.value = String(userRating || 0);
        ratingSelect.addEventListener("change", () => {
          const nextRatingsMap = loadCommunityMapFromStorage(COMMUNITY_RATINGS_KEY);
          nextRatingsMap[beatId] = nextRatingsMap[beatId] || {};
          const nextVal = Number(ratingSelect.value);
          if (nextVal >= 1 && nextVal <= 5) nextRatingsMap[beatId][username] = nextVal;
          else delete nextRatingsMap[beatId][username];
          saveCommunityMapToStorage(COMMUNITY_RATINGS_KEY, nextRatingsMap);
          renderExploreBeatsList();
        });

        const commentsBtn = document.createElement("button");
        commentsBtn.textContent = `Comments (${commentsForBeat.length})`;
        commentsBtn.className = "btn btn-small btn-secondary";

        actions.appendChild(loadBtn);
        actions.appendChild(likeBtn);
        actions.appendChild(ratingSelect);
        actions.appendChild(commentsBtn);

        item.appendChild(info);
        item.appendChild(actions);

        // Inline comments preview + add.
        const commentsWrap = document.createElement("div");
        commentsWrap.style.marginTop = "0.5rem";
        commentsWrap.style.width = "100%";

        const preview = document.createElement("div");
        preview.style.fontSize = "0.8rem";
        preview.style.color = "#9ca3af";

        const previewLines = commentsForBeat.slice(0, 2).map((c) => {
          const who = c.username ? String(c.username) : "Guest";
          const text = c.text ? String(c.text) : "";
          return `${who}: ${text}`;
        });
        preview.textContent =
          previewLines.length > 0 ? previewLines.join(" • ") : "No comments yet.";

        const commentInput = document.createElement("input");
        commentInput.type = "text";
        commentInput.placeholder = "Write a comment...";
        commentInput.style.marginTop = "0.35rem";
        commentInput.style.width = "100%";
        commentInput.style.borderRadius = "0.6rem";
        commentInput.style.border = "1px solid rgba(55, 65, 81, 0.9)";
        commentInput.style.padding = "0.35rem 0.45rem";
        commentInput.style.background = "#020617";
        commentInput.style.color = "#e5e7eb";

        const addCommentBtn = document.createElement("button");
        addCommentBtn.textContent = "Add";
        addCommentBtn.className = "btn btn-small btn-secondary";
        addCommentBtn.style.marginTop = "0.4rem";
        addCommentBtn.addEventListener("click", () => {
          const text = (commentInput.value || "").trim();
          if (!text) return;
          const nextComments = loadCommentsFromStorage();
          nextComments.push({
            id: Date.now().toString(),
            beatId,
            username,
            text,
            createdAt: new Date().toISOString(),
          });
          saveCommentsToStorage(nextComments);
          renderExploreBeatsList();
        });

        commentsWrap.appendChild(preview);
        commentsWrap.appendChild(commentInput);
        commentsWrap.appendChild(addCommentBtn);

        item.appendChild(commentsWrap);

        listEl.appendChild(item);
      });
  }

  function initCommunityControls() {
    const searchEl = document.getElementById("explore-search-input");
    const genreEl = document.getElementById("explore-genre-filter");
    if (searchEl) searchEl.addEventListener("input", () => renderExploreBeatsList());
    if (genreEl) genreEl.addEventListener("change", () => renderExploreBeatsList());

    renderExploreBeatsList();
  }

  function initSaveProjectButton() {
    const btn = document.getElementById("save-project-button");
    if (!btn) return;
    btn.addEventListener("click", saveCurrentProject);
  }

  // ---- Account system ----
  function updateSidebarUsernameDisplay(username) {
    const usernameEl = document.getElementById("sidebar-username");
    if (!usernameEl) return;
    usernameEl.textContent = username || "Guest";
  }

  // ===== REPLACED: Firebase Authentication (was local-only before) =====

  function handleSignUp() {
    const usernameInput = document.getElementById("account-username");
    const emailInput    = document.getElementById("account-email");
    const passwordInput = document.getElementById("account-password");
    if (!usernameInput || !emailInput || !passwordInput) return;

    const username = usernameInput.value.trim();
    const email    = emailInput.value.trim();
    const password = passwordInput.value;

    if (!username || !email || !password) {
      alert("Please fill in all fields.");
      return;
    }

    // Check Firebase Auth is available
    if (typeof firebase === "undefined" || !firebase.auth) {
      alert("Firebase not loaded. Cannot create account.");
      return;
    }

    const signupBtn = document.getElementById("account-signup");
    if (signupBtn) { signupBtn.disabled = true; signupBtn.textContent = "Creating…"; }

    firebase.auth()
      .createUserWithEmailAndPassword(email, password)
      .then((userCredential) => {
        // Save display name to Firebase profile
        return userCredential.user.updateProfile({ displayName: username })
          .then(() => {
            // Also keep in localStorage so getCurrentUsername() still works
            saveUserToStorage({ username, email });
            updateSidebarUsernameDisplay(username);
            // Clear fields
            usernameInput.value = "";
            emailInput.value    = "";
            passwordInput.value = "";
            alert(`Welcome, ${username}! Account created with Firebase.`);
            console.log("[Firebase Auth] Account created:", email);
          });
      })
      .catch((err) => {
        console.error("[Firebase Auth] Sign up error:", err);
        alert("Sign up failed: " + err.message);
      })
      .finally(() => {
        if (signupBtn) { signupBtn.disabled = false; signupBtn.textContent = "Sign Up"; }
      });
  }

  function handleLogin() {
    const usernameInput = document.getElementById("account-username");
    const emailInput    = document.getElementById("account-email");
    const passwordInput = document.getElementById("account-password");
    if (!usernameInput || !emailInput || !passwordInput) return;

    const email    = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      alert("Please enter your email and password.");
      return;
    }

    if (typeof firebase === "undefined" || !firebase.auth) {
      alert("Firebase not loaded. Cannot log in.");
      return;
    }

    const loginBtn = document.getElementById("account-login");
    if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = "Logging in…"; }

    firebase.auth()
      .signInWithEmailAndPassword(email, password)
      .then((userCredential) => {
        const user     = userCredential.user;
        const username = user.displayName || usernameInput.value.trim() || email.split("@")[0];
        saveUserToStorage({ username, email });
        updateSidebarUsernameDisplay(username);
        // Clear fields
        usernameInput.value = "";
        emailInput.value    = "";
        passwordInput.value = "";
        alert(`Welcome back, ${username}!`);
        console.log("[Firebase Auth] Logged in:", email);
        renderCloudBeatsList();
      })
      .catch((err) => {
        console.error("[Firebase Auth] Login error:", err);
        alert("Login failed: " + err.message);
      })
      .finally(() => {
        if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = "Log In"; }
      });
  }

  function handleLogout() {
    if (typeof firebase === "undefined" || !firebase.auth) return;
    firebase.auth().signOut().then(() => {
      saveUserToStorage(null);
      updateSidebarUsernameDisplay("Guest");
      console.log("[Firebase Auth] Logged out.");
    });
  }

  function initAccountSection() {
    const signupBtn = document.getElementById("account-signup");
    const loginBtn  = document.getElementById("account-login");
    if (signupBtn) signupBtn.addEventListener("click", handleSignUp);
    if (loginBtn)  loginBtn.addEventListener("click", handleLogin);

    // Listen for Firebase auth state changes so sidebar stays in sync
    // even after page refresh (Firebase restores the session automatically).
    if (typeof firebase !== "undefined" && firebase.auth) {
      firebase.auth().onAuthStateChanged((user) => {
        if (user) {
          const username = user.displayName || user.email.split("@")[0];
          saveUserToStorage({ username, email: user.email });
          updateSidebarUsernameDisplay(username);
          console.log("[Firebase Auth] Session restored:", user.email);

          // Add a Log Out button dynamically if not already there
          const accountButtons = document.querySelector(".account-buttons");
          if (accountButtons && !document.getElementById("account-logout")) {
            const logoutBtn = document.createElement("button");
            logoutBtn.id        = "account-logout";
            logoutBtn.textContent = "Log Out";
            logoutBtn.className = "btn btn-small btn-secondary";
            logoutBtn.addEventListener("click", handleLogout);
            accountButtons.appendChild(logoutBtn);
          }
        } else {
          updateSidebarUsernameDisplay("Guest");
          // Remove logout button if present
          const logoutBtn = document.getElementById("account-logout");
          if (logoutBtn) logoutBtn.remove();
        }
      });
    } else {
      // Firebase not configured — fall back to local display
      const stored = loadUserFromStorage();
      updateSidebarUsernameDisplay(stored && stored.username ? stored.username : "Guest");
    }
  }
  // ===== End Firebase Authentication =====

  document.addEventListener("DOMContentLoaded", () => {
    initSidebar();
    initSaveBeatButton();
    renderBeatsList();
    initSaveProjectButton();
    renderProjectsList();
    initCommunityControls();
    initAccountSection();
    // ===== ADDED: Load cloud beats in the background after page is ready =====
    setTimeout(() => {
      renderCloudBeatsList();
    }, 1500);
    // ===== End Firebase addition =====
  });
})();

