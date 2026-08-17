// @ts-check

/** @type {typeof import("obsidian")} */
const {
  Notice,
  normalizePath,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
} = require("obsidian");

const BODY_CLASS = "plawe-native-sidebar";
const ACTIVE_FILE_CLASS = "plawe-sidebar-active-file";
const ACTIVE_PATH_CLASS = "plawe-sidebar-active-path";
const CONTEXT_BAR_CLASS = "plawe-sidebar-context";

/**
 * @typedef {Object} PlaweSidebarSettings
 * @property {boolean} enabled
 * @property {boolean} mobileOnly
 * @property {"comfortable" | "compact"} density
 * @property {boolean} largeTitle
 * @property {boolean} showActivePath
 * @property {boolean} showQuickActions
 * @property {boolean} highlightActivePath
 * @property {boolean} calmChrome
 * @property {boolean} folderTint
 */

/** @type {PlaweSidebarSettings} */
const DEFAULT_SETTINGS = {
  enabled: true,
  mobileOnly: false,
  density: "comfortable",
  largeTitle: true,
  showActivePath: true,
  showQuickActions: true,
  highlightActivePath: true,
  calmChrome: true,
  folderTint: true,
};

class PlaweNativeSidebarPlugin extends Plugin {
  /** @type {PlaweSidebarSettings} */
  settings = { ...DEFAULT_SETTINGS };

  /** @type {MutationObserver | null} */
  observer = null;

  /** @type {number | null} */
  refreshFrame = null;

  layoutReady = false;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.addSettingTab(new PlaweNativeSidebarSettingTab(this.app, this));

    this.addCommand({
      id: "toggle-native-sidebar",
      name: "Native Sidebar ein-/ausschalten",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.persistSettings();
        new Notice(
          this.settings.enabled
            ? "Plawe Native Sidebar ist aktiv."
            : "Plawe Native Sidebar ist pausiert."
        );
      },
    });

    this.addCommand({
      id: "toggle-sidebar-density",
      name: "Zwischen komfortabler und kompakter Ansicht wechseln",
      callback: async () => {
        this.settings.density =
          this.settings.density === "comfortable" ? "compact" : "comfortable";
        await this.persistSettings();
      },
    });

    this.addCommand({
      id: "reveal-active-file-in-sidebar",
      name: "Aktuelle Notiz in der Seitenleiste zentrieren",
      callback: () => this.revealActiveFile(),
    });

    this.registerEvent(this.app.workspace.on("file-open", () => this.queueRefresh()));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.queueRefresh())
    );
    this.registerEvent(this.app.workspace.on("layout-change", () => this.queueRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.queueRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.queueRefresh()));

    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      this.startObserver();
      this.refresh();
    });
  }

  onunload() {
    this.layoutReady = false;

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    if (this.refreshFrame !== null) {
      window.cancelAnimationFrame(this.refreshFrame);
      this.refreshFrame = null;
    }

    this.clearAppearance();
  }

  async persistSettings() {
    await this.saveData(this.settings);
    this.refresh();
  }

  shouldApply() {
    return (
      this.settings.enabled &&
      (!this.settings.mobileOnly || Platform.isMobileApp)
    );
  }

  startObserver() {
    if (this.observer || !document.body) return;

    this.observer = new MutationObserver((mutations) => {
      const sidebarChanged = mutations.some((mutation) => {
        if (mutation.type !== "childList") return false;

        const target = mutation.target;
        const targetIsSidebar =
          target instanceof Element &&
          Boolean(
            target.closest(
              ".workspace-split.mod-left-split, .workspace-drawer.mod-left"
            )
          );

        const addedSidebar = Array.from(mutation.addedNodes).some(
          (node) =>
            node instanceof Element &&
            (node.matches(
              ".workspace-split.mod-left-split, .workspace-drawer.mod-left"
            ) ||
              Boolean(
                node.querySelector(
                  ".workspace-split.mod-left-split, .workspace-drawer.mod-left"
                )
              ))
        );

        return targetIsSidebar || addedSidebar;
      });

      if (sidebarChanged) this.queueRefresh();
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  queueRefresh() {
    if (!this.layoutReady || this.refreshFrame !== null) return;

    this.refreshFrame = window.requestAnimationFrame(() => {
      this.refreshFrame = null;
      this.refresh();
    });
  }

  refresh() {
    if (!document.body) return;

    this.applyBodyClasses();

    if (!this.shouldApply()) {
      this.removeContextBars();
      this.clearPathMarkers();
      return;
    }

    this.syncContextBars();
    this.syncActivePathMarkers();
  }

  applyBodyClasses() {
    const body = document.body;
    const active = this.shouldApply();

    body.classList.toggle(BODY_CLASS, active);
    body.classList.toggle(
      "plawe-sidebar-compact",
      active && this.settings.density === "compact"
    );
    body.classList.toggle(
      "plawe-sidebar-large-title",
      active && this.settings.largeTitle
    );
    body.classList.toggle(
      "plawe-sidebar-show-path",
      active && this.settings.showActivePath
    );
    body.classList.toggle(
      "plawe-sidebar-calm-chrome",
      active && this.settings.calmChrome
    );
    body.classList.toggle(
      "plawe-sidebar-folder-tint",
      active && this.settings.folderTint
    );
  }

  clearAppearance() {
    if (!document.body) return;

    document.body.classList.remove(
      BODY_CLASS,
      "plawe-sidebar-compact",
      "plawe-sidebar-large-title",
      "plawe-sidebar-show-path",
      "plawe-sidebar-calm-chrome",
      "plawe-sidebar-folder-tint"
    );
    this.removeContextBars();
    this.clearPathMarkers();
  }

  getFileExplorerContainers() {
    return this.app.workspace
      .getLeavesOfType("file-explorer")
      .map((leaf) => leaf.view && leaf.view.containerEl)
      .filter((container) => container instanceof HTMLElement);
  }

  syncContextBars() {
    const activeFile = this.app.workspace.getActiveFile();
    const vaultName = this.app.vault.getName();
    const pathLabel = activeFile
      ? activeFile.parent && activeFile.parent.path
        ? activeFile.parent.path
        : "Start"
      : "Keine Notiz geöffnet";

    for (const container of this.getFileExplorerContainers()) {
      const filesContainer = container.querySelector(".nav-files-container");
      if (!filesContainer || !filesContainer.parentElement) continue;

      let contextBar = container.querySelector(`.${CONTEXT_BAR_CLASS}`);

      if (!contextBar) {
        contextBar = document.createElement("div");
        contextBar.className = CONTEXT_BAR_CLASS;

        const copy = document.createElement("div");
        copy.className = "plawe-sidebar-context-copy";

        const eyebrow = document.createElement("div");
        eyebrow.className = "plawe-sidebar-eyebrow";
        eyebrow.textContent = "Mediathek";

        const title = document.createElement("div");
        title.className = "plawe-sidebar-title";

        const path = document.createElement("div");
        path.className = "plawe-sidebar-path";

        copy.append(eyebrow, title, path);

        const actions = document.createElement("div");
        actions.className = "plawe-sidebar-actions";

        contextBar.append(copy, actions);
        filesContainer.parentElement.insertBefore(contextBar, filesContainer);
      }

      const title = contextBar.querySelector(".plawe-sidebar-title");
      const path = contextBar.querySelector(".plawe-sidebar-path");
      const actions = contextBar.querySelector(".plawe-sidebar-actions");

      if (title) title.textContent = vaultName;
      if (path) {
        path.textContent = pathLabel;
        path.setAttribute("title", pathLabel);
      }

      if (actions instanceof HTMLElement) this.syncQuickActions(actions);
    }
  }

  /** @param {HTMLElement} actions */
  syncQuickActions(actions) {
    const desiredMode = this.settings.showQuickActions ? "visible" : "hidden";
    if (actions.dataset.mode === desiredMode) return;

    actions.dataset.mode = desiredMode;
    actions.replaceChildren();

    if (!this.settings.showQuickActions) return;

    actions.append(
      this.createActionButton("search", "Suchen", () => this.openSearch()),
      this.createActionButton("file-plus-2", "Neue Notiz", () =>
        this.createNewNote()
      )
    );
  }

  /**
   * @param {string} icon
   * @param {string} label
   * @param {() => void | Promise<void>} callback
   * @returns {HTMLButtonElement}
   */
  createActionButton(icon, label, callback) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "clickable-icon plawe-sidebar-action";
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tooltip-position", "top");
    setIcon(button, icon);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve(callback()).catch((error) => {
        console.error("Plawe Native Sidebar:", error);
        new Notice("Die Aktion konnte gerade nicht ausgeführt werden.");
      });
    });

    return button;
  }

  async openSearch() {
    await this.app.workspace.ensureSideLeaf("search", "left", {
      active: true,
      reveal: true,
    });
  }

  async createNewNote() {
    const activeFile = this.app.workspace.getActiveFile();
    const sourcePath = activeFile ? activeFile.path : "";
    const parent = this.app.fileManager.getNewFileParent(
      sourcePath,
      "Unbenannte Notiz.md"
    );
    const baseName = "Unbenannte Notiz";
    let counter = 1;
    let candidate = this.buildNotePath(parent.path, baseName);

    while (this.app.vault.getAbstractFileByPath(candidate)) {
      counter += 1;
      candidate = this.buildNotePath(parent.path, `${baseName} ${counter}`);
    }

    const file = await this.app.vault.create(candidate, "");
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  /**
   * @param {string} parentPath
   * @param {string} name
   */
  buildNotePath(parentPath, name) {
    return normalizePath(parentPath ? `${parentPath}/${name}.md` : `${name}.md`);
  }

  syncActivePathMarkers() {
    const activeFile = this.app.workspace.getActiveFile();
    const activePath = activeFile ? activeFile.path : null;
    const folderPaths = new Set();

    if (activePath) {
      const parts = activePath.split("/");
      parts.pop();
      let current = "";

      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        folderPaths.add(current);
      }
    }

    for (const root of this.getLeftSidebarRoots()) {
      root
        .querySelectorAll(".nav-file-title[data-path]")
        .forEach((element) => {
          if (!(element instanceof HTMLElement)) return;
          element.classList.toggle(
            ACTIVE_FILE_CLASS,
            Boolean(activePath) && element.dataset.path === activePath
          );
        });

      root
        .querySelectorAll(".nav-folder-title[data-path]")
        .forEach((element) => {
          if (!(element instanceof HTMLElement)) return;
          element.classList.toggle(
            ACTIVE_PATH_CLASS,
            this.settings.highlightActivePath &&
              folderPaths.has(element.dataset.path || "")
          );
        });
    }
  }

  getLeftSidebarRoots() {
    return Array.from(
      document.querySelectorAll(
        ".workspace-split.mod-left-split, .workspace-drawer.mod-left"
      )
    );
  }

  clearPathMarkers() {
    document
      .querySelectorAll(`.${ACTIVE_FILE_CLASS}, .${ACTIVE_PATH_CLASS}`)
      .forEach((element) =>
        element.classList.remove(ACTIVE_FILE_CLASS, ACTIVE_PATH_CLASS)
      );
  }

  removeContextBars() {
    document
      .querySelectorAll(`.${CONTEXT_BAR_CLASS}`)
      .forEach((element) => element.remove());
  }

  revealActiveFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("Es ist gerade keine Notiz geöffnet.");
      return;
    }

    const selectorPath = this.escapeAttributeValue(activeFile.path);
    const candidates = Array.from(
      document.querySelectorAll(
        `.workspace-split.mod-left-split .nav-file-title[data-path="${selectorPath}"], ` +
          `.workspace-drawer.mod-left .nav-file-title[data-path="${selectorPath}"]`
      )
    ).filter((element) => element instanceof HTMLElement);
    const target = candidates.find((element) => element.offsetParent !== null) || candidates[0];

    if (!target) {
      new Notice("Öffne zuerst den Datei-Explorer in der linken Seitenleiste.");
      return;
    }

    target.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }

  /** @param {string} value */
  escapeAttributeValue(value) {
    if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {
      return globalThis.CSS.escape(value);
    }

    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
}

class PlaweNativeSidebarSettingTab extends PluginSettingTab {
  /**
   * @param {import("obsidian").App} app
   * @param {PlaweNativeSidebarPlugin} plugin
   */
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Native Sidebar aktiv")
      .setDesc("Schaltet das neue Erscheinungsbild ein oder aus.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.persistSettings();
        })
      );

    new Setting(containerEl)
      .setName("Nur auf Smartphone und Tablet")
      .setDesc("Auf dem Mac bleibt die normale Obsidian-Seitenleiste erhalten.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.mobileOnly).onChange(async (value) => {
          this.plugin.settings.mobileOnly = value;
          await this.plugin.persistSettings();
        })
      );

    new Setting(containerEl)
      .setName("Abstände")
      .setDesc("Komfortabel bietet größere, iOS-taugliche Touch-Flächen.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("comfortable", "Komfortabel")
          .addOption("compact", "Kompakt")
          .setValue(this.plugin.settings.density)
          .onChange(async (value) => {
            if (value !== "comfortable" && value !== "compact") return;
            this.plugin.settings.density = value;
            await this.plugin.persistSettings();
          })
      );

    new Setting(containerEl)
      .setName("Großer iOS-Titel")
      .setDesc("Zeigt den Namen deines Vaults als ruhigen Navigationstitel.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.largeTitle).onChange(async (value) => {
          this.plugin.settings.largeTitle = value;
          await this.plugin.persistSettings();
        })
      );

    new Setting(containerEl)
      .setName("Aktuellen Pfad anzeigen")
      .setDesc("Zeigt unter dem Vault-Namen den Ordner der geöffneten Notiz.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showActivePath)
          .onChange(async (value) => {
            this.plugin.settings.showActivePath = value;
            await this.plugin.persistSettings();
          })
      );

    new Setting(containerEl)
      .setName("Schnellaktionen")
      .setDesc("Zeigt oben Schaltflächen für Suche und neue Notiz.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showQuickActions)
          .onChange(async (value) => {
            this.plugin.settings.showQuickActions = value;
            await this.plugin.persistSettings();
          })
      );

    new Setting(containerEl)
      .setName("Aktiven Ordnerpfad hervorheben")
      .setDesc("Markiert dezent die Ordner, in denen die aktuelle Notiz liegt.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.highlightActivePath)
          .onChange(async (value) => {
            this.plugin.settings.highlightActivePath = value;
            await this.plugin.persistSettings();
          })
      );

    new Setting(containerEl)
      .setName("Ruhige Bedienelemente")
      .setDesc("Reduziert Rahmen und Flächen, ohne Funktionen auszublenden.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.calmChrome).onChange(async (value) => {
          this.plugin.settings.calmChrome = value;
          await this.plugin.persistSettings();
        })
      );

    new Setting(containerEl)
      .setName("Lavendel-Akzent für Ordner")
      .setDesc("Passt die Ordner dezent an den PLAWE-Look an.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.folderTint).onChange(async (value) => {
          this.plugin.settings.folderTint = value;
          await this.plugin.persistSettings();
        })
      );
  }
}

module.exports = PlaweNativeSidebarPlugin;
