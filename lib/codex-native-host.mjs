export const CODEX_NATIVE_HOST_SELECTORS = Object.freeze({
  shell: 'main[data-app-shell-main-surface="default"]',
  nativeContent: '[data-app-shell-main-content-layout="thread-edge-scroll"]',
  tabsHost: '[data-app-shell-tabs="true"]',
  rightTabStrip: '[data-app-shell-tab-strip-controller="right"]',
  rightTabList: '[data-app-shell-tab-strip-controller="right"] [role="tablist"]',
  rightTabControllers: '[data-app-shell-tab-controller="right"]',
  rightTabs: '[data-app-shell-tab-controller="right"] [role="tab"]',
  rightPanels: '[role="tabpanel"][data-app-shell-tab-panel-controller="right"]',
  addTabButton: 'button[title="打开侧边面板标签页"]',
  addTabLists: "ul",
  conversationRows: '[data-app-action-sidebar-thread-row][role="button"]',
});

const TAB_CONTROLLER_CLASS = "@container/app-shell-tab my-auto relative flex shrink-0 items-center overflow-hidden contain-content";
const TAB_CONTROLLER_STYLE = "flex-basis: 114px; flex-grow: 0; max-width: 160px; min-width: 90px;";
const TAB_CONTENT_CLASS = "flex min-w-0 flex-1 items-center pe-1";
const TAB_SHELL_CLASS = "group/tab relative flex h-7 w-full max-w-39 shrink-0 items-center overflow-hidden rounded-lg bg-token-main-surface-primary px-2 py-1";
const TAB_SHELL_STYLE = "--app-shell-tab-background: color-mix(in srgb, var(--color-token-foreground, var(--color-text-foreground)) 5%, var(--color-token-main-surface-primary));";
const TAB_BACKGROUND_CLASS = "pointer-events-none absolute inset-0 z-0 rounded-md group-hover/tab:bg-[var(--app-shell-tab-background)] bg-[var(--app-shell-tab-background)]";
const TAB_BUTTON_CLASS = "no-drag relative flex flex-1 items-center gap-2 z-10 text-sm min-w-0 pe-3.5 text-token-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
const CLOSE_BUTTON_CLASS = "no-drag cursor-interaction items-center gap-1 border whitespace-nowrap select-none focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40 flex rounded-md text-token-text-tertiary enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border-transparent flex size-5 items-center justify-center p-0.5 [&>svg]:icon-2xs absolute end-1 top-1/2 z-30 -translate-y-1/2 @max-[4rem]/app-shell-tab:invisible";
const TAB_SEPARATOR_CLASS = "h-3 w-px shrink-0 end-0 absolute bg-token-border transition-opacity duration-basic opacity-0";
const PANEL_CLASS = "relative min-h-0 flex-1 outline-none";
const SIDEBAR_SHORTCUT_INIT = Object.freeze({
  key: "s",
  code: "KeyS",
  metaKey: true,
  altKey: true,
  bubbles: true,
  cancelable: true,
});

export class CodexNativeHostContractError extends Error {
  constructor(missing) {
    super(`Unsupported Codex renderer: missing ${missing.join(", ")}`);
    this.name = "CodexNativeHostContractError";
    this.missing = missing;
  }
}

export class CodexNativeHost {
  constructor(options = {}) {
    this.document = options.document || globalThis.document;
    this.MutationObserver = options.MutationObserver || globalThis.MutationObserver;
    this.KeyboardEvent = options.KeyboardEvent
      || this.document?.defaultView?.KeyboardEvent
      || globalThis.KeyboardEvent;
    this.queueMicrotask = options.queueMicrotask
      || this.document?.defaultView?.queueMicrotask
      || globalThis.queueMicrotask;
    this.selectors = CODEX_NATIVE_HOST_SELECTORS;
    this.panel = options.panel;
    this.entryId = options.entryId || "ninecodex-task-center-tab";
    this.tabShellId = options.tabShellId || "ninecodex-task-center-tab-shell";
    this.menuEntryId = options.menuEntryId || "ninecodex-task-center-menu-entry";
    this.panelId = options.panelId || "ninecodex-session-task-panel";
    this.tabId = options.tabId || "ninecodex-task-center";
    this.label = options.label || "任务中心";
    this.createIcon = options.createIcon || (() => null);
    this.onActivate = options.onActivate || (() => {});
    this.onDeactivate = options.onDeactivate || (() => {});
    this.onDisable = options.onDisable || (() => {});
    this.active = false;
    this.disabled = false;
    this.disposed = false;
    this.awaitingSidebar = false;
    this.sidebarShortcutDispatched = false;
    this.tabClosed = true;
    this.contract = null;
    this.entry = null;
    this.tabShell = null;
    this.closeButton = null;
    this.menuEntry = null;
    this.observer = null;
    this.nativeState = null;
    this.pendingNativeTabId = null;
    this.contextNativeTabId = null;
    this.listening = false;
    this.boundEntryClick = (event) => this.#handleEntryClick(event);
    this.boundClosePointerDown = (event) => this.#handleClosePointerDown(event);
    this.boundCloseClick = (event) => this.#handleCloseClick(event);
    this.boundMenuEntryClick = (event) => this.#handleMenuEntryClick(event);
    this.boundDocumentClick = (event) => this.#handleDocumentClick(event);
    this.boundDocumentContextMenu = (event) => this.#handleDocumentContextMenu(event);
  }

  #unique(selector, name, missing, { optional = false } = {}) {
    const nodes = [...(this.document?.querySelectorAll(selector) || [])];
    if (nodes.length > 1) missing.push(`unique${name}`);
    else if (!optional && nodes.length === 0) missing.push(name);
    return nodes.length === 1 ? nodes[0] : null;
  }

  #resolveBaseContract() {
    const missing = [];
    const shell = this.#unique(this.selectors.shell, "Shell", missing);
    const nativeContent = this.#unique(this.selectors.nativeContent, "NativeContent", missing);
    if (!this.panel) missing.push("panel");
    if (!this.MutationObserver) missing.push("MutationObserver");
    if (!this.document?.documentElement) missing.push("documentElement");
    if (shell && nativeContent && !shell.contains(nativeContent)) missing.push("nativeContentOwner");
    if (missing.length) throw new CodexNativeHostContractError(missing);
    return { shell, nativeContent };
  }

  #resolveSidebarContract(base) {
    const tabsHosts = [...this.document.querySelectorAll(this.selectors.tabsHost)];
    const rightTabStrips = [...this.document.querySelectorAll(this.selectors.rightTabStrip)];
    const rightTabLists = [...this.document.querySelectorAll(this.selectors.rightTabList)];
    const missing = [];
    if (tabsHosts.length > 1) missing.push("uniqueTabsHost");
    if (rightTabStrips.length > 1) missing.push("uniqueRightTabStrip");
    if (rightTabLists.length > 1) missing.push("uniqueRightTabList");
    if (missing.length) throw new CodexNativeHostContractError(missing);
    if (!tabsHosts.length || !rightTabStrips.length || !rightTabLists.length) return null;

    const panelHost = tabsHosts[0];
    const rightTabStrip = rightTabStrips[0];
    const rightTabList = rightTabLists[0];
    if (!base.shell.contains(panelHost)) missing.push("tabsHostOwner");
    if (!panelHost.contains(rightTabStrip)) missing.push("rightTabStripOwner");
    if (!rightTabStrip.contains(rightTabList)) missing.push("rightTabListOwner");
    if (missing.length) throw new CodexNativeHostContractError(missing);

    const nativeTabs = [...rightTabList.querySelectorAll(this.selectors.rightTabs)]
      .filter((tab) => tab.id !== this.entryId);
    const nativePanels = [...panelHost.querySelectorAll(this.selectors.rightPanels)]
      .filter((candidate) => candidate !== this.panel && candidate.id !== this.panelId);
    return {
      ...base,
      panelHost,
      rightTabStrip,
      rightTabList,
      nativeTabs,
      nativePanels,
    };
  }

  #buildTab() {
    const controller = this.document.createElement("div");
    controller.id = this.tabShellId;
    controller.setAttribute("data-app-shell-tab-controller", "right");
    controller.setAttribute("data-tab-id", this.tabId);
    controller.setAttribute("class", TAB_CONTROLLER_CLASS);
    controller.setAttribute("style", TAB_CONTROLLER_STYLE);

    const content = this.document.createElement("div");
    content.setAttribute("class", TAB_CONTENT_CLASS);

    const shell = this.document.createElement("div");
    shell.setAttribute("data-tab-id", this.tabId);
    shell.setAttribute("class", TAB_SHELL_CLASS);
    shell.setAttribute("style", TAB_SHELL_STYLE);

    const background = this.document.createElement("div");
    background.setAttribute("class", TAB_BACKGROUND_CLASS);

    const entry = this.document.createElement("button");
    entry.id = this.entryId;
    entry.type = "button";
    entry.setAttribute("role", "tab");
    entry.setAttribute("aria-selected", "false");
    entry.setAttribute("class", TAB_BUTTON_CLASS);
    entry.setAttribute("tabindex", "-1");
    entry.setAttribute("aria-controls", this.panelId);
    const icon = this.createIcon();
    if (icon) {
      const iconFrame = this.document.createElement("span");
      iconFrame.setAttribute("aria-hidden", "true");
      iconFrame.setAttribute("class", "icon-xs relative flex shrink-0 items-center justify-center overflow-visible");
      const iconContent = this.document.createElement("span");
      iconContent.setAttribute("class", "flex size-full items-center justify-center");
      iconContent.append(icon);
      iconFrame.append(iconContent);
      entry.append(iconFrame);
    }
    const labelFrame = this.document.createElement("span");
    labelFrame.setAttribute("class", "relative min-w-0 flex-1 overflow-hidden");
    const label = this.document.createElement("span");
    label.setAttribute("class", "block w-full min-w-0 whitespace-nowrap text-start");
    label.setAttribute("dir", "auto");
    label.textContent = this.label;
    labelFrame.append(label);
    entry.append(labelFrame);
    entry.addEventListener("click", this.boundEntryClick, true);

    const closeButton = this.document.createElement("button");
    closeButton.type = "button";
    closeButton.setAttribute("class", CLOSE_BUTTON_CLASS);
    closeButton.setAttribute("data-app-shell-tab-close-button", "true");
    closeButton.setAttribute("aria-label", `关闭${this.label}标签页`);
    const closeIcon = this.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    closeIcon.setAttribute("width", "21");
    closeIcon.setAttribute("height", "21");
    closeIcon.setAttribute("viewBox", "0 0 21 21");
    closeIcon.setAttribute("fill", "none");
    closeIcon.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    closeIcon.setAttribute("aria-hidden", "true");
    const closePath = this.document.createElementNS("http://www.w3.org/2000/svg", "path");
    closePath.setAttribute("d", "M14.6549 5.57307C14.9283 5.2997 15.3718 5.2997 15.6451 5.57307C15.9185 5.84643 15.9185 6.28993 15.6451 6.5633L11.3903 10.8182L15.6451 15.0731L15.735 15.1834C15.9141 15.4551 15.8842 15.8242 15.6451 16.0633C15.4061 16.3024 15.0369 16.3322 14.7653 16.1531L14.6549 16.0633L10.4 11.8084L6.14515 16.0633C5.87178 16.3367 5.42828 16.3367 5.15492 16.0633C4.88155 15.7899 4.88155 15.3464 5.15492 15.0731L9.4098 10.8182L5.15492 6.5633L5.06507 6.45295C4.88597 6.18128 4.91584 5.81214 5.15492 5.57307C5.39399 5.33399 5.76313 5.30413 6.0348 5.48322L6.14515 5.57307L10.4 9.82795L14.6549 5.57307Z");
    closePath.setAttribute("fill", "currentColor");
    closeIcon.append(closePath);
    closeButton.append(closeIcon);
    closeButton.addEventListener("pointerdown", this.boundClosePointerDown, true);
    closeButton.addEventListener("click", this.boundCloseClick, true);

    shell.append(background, entry, closeButton);
    content.append(shell);

    const separator = this.document.createElement("div");
    separator.setAttribute("aria-hidden", "true");
    separator.setAttribute("data-app-shell-tab-separator", this.tabId);
    separator.setAttribute("class", TAB_SEPARATOR_CLASS);

    controller.append(content, separator);
    this.tabShell = controller;
    this.entry = entry;
    this.closeButton = closeButton;
  }

  #preparePanel() {
    this.panel.id = this.panelId;
    this.panel.hidden = true;
    this.panel.dataset.open = "false";
    this.panel.setAttribute("role", "tabpanel");
    this.panel.setAttribute("data-app-shell-tab-panel-controller", "right");
    this.panel.setAttribute("data-tab-id", this.tabId);
    this.panel.setAttribute("class", PANEL_CLASS);
    this.panel.setAttribute("aria-label", this.label);
    this.panel.setAttribute("aria-labelledby", this.entryId);
    this.panel.setAttribute("tabindex", "0");
  }

  #removeDuplicates() {
    for (const node of this.document.querySelectorAll(`#${this.tabShellId}`)) {
      if (node !== this.tabShell) node.remove();
    }
    for (const node of this.document.querySelectorAll(`#${this.panelId}`)) {
      if (node !== this.panel) node.remove();
    }
    for (const node of this.document.querySelectorAll(`#${this.menuEntryId}`)) {
      if (node !== this.menuEntry) node.remove();
    }
  }

  #attach(contract) {
    if (!this.tabShell || !this.entry || !this.closeButton) this.#buildTab();
    this.#preparePanel();
    this.#removeDuplicates();
    if (this.tabShell.parentElement !== contract.rightTabList) {
      contract.rightTabList.append(this.tabShell);
    }
    if (this.panel.parentElement !== contract.panelHost) {
      contract.panelHost.append(this.panel);
    }
    this.contract = contract;
    this.awaitingSidebar = false;
    this.sidebarShortcutDispatched = false;
    if (this.active) this.#show();
    else this.#hide();
  }

  #menuForAddButton() {
    return [...this.document.querySelectorAll(this.selectors.addTabLists)].find((menu) => {
      const labels = [...menu.querySelectorAll("button")]
        .map((item) => item.textContent.trim().replace(/\s.+$/s, ""));
      return labels.includes("侧边聊天")
        && ["审阅", "终端", "浏览器", "文件"].every((label) => labels.includes(label));
    }) || null;
  }

  #syncMenuEntry() {
    const menu = this.#menuForAddButton();
    if (!menu) {
      if (!this.menuEntry?.isConnected) this.menuEntry = null;
      return false;
    }
    const existing = this.document.querySelector(`#${this.menuEntryId}`);
    if (existing?.isConnected) {
      this.menuEntry = existing;
      return true;
    }
    const nativeItems = [...menu.querySelectorAll("button")];
    const templateButton = nativeItems.find((item) => (
      item.textContent.trim().replace(/\s.+$/s, "") === "侧边聊天"
    )) || nativeItems.at(-1);
    const template = templateButton?.closest("li") || templateButton;
    if (!template) return false;
    const item = template.cloneNode(true);
    const button = item.tagName === "BUTTON" ? item : item.querySelector("button");
    if (!button) return false;
    button.id = this.menuEntryId;
    button?.removeAttribute("aria-keyshortcuts");
    for (const node of item.querySelectorAll("kbd")) node.remove();
    const label = [...item.querySelectorAll("span")]
      .find((node) => node.children.length === 0 && node.textContent.trim() === "侧边聊天");
    if (label) label.textContent = this.label;
    else if (button) button.textContent = this.label;
    else item.textContent = this.label;
    const icon = this.createIcon();
    const nativeIcon = item.querySelector("svg");
    if (icon && nativeIcon) nativeIcon.replaceWith(icon);
    button.addEventListener("click", this.boundMenuEntryClick, true);
    template.after(item);
    this.menuEntry = button;
    return true;
  }

  #captureNativeState() {
    const tabs = this.contract.nativeTabs.map((tab) => ({
        tab,
        tabId: this.#nativeTabId(tab),
        selected: tab.getAttribute("aria-selected"),
        tabindex: tab.getAttribute("tabindex"),
      }));
    const panels = this.contract.nativePanels.map((panel) => ({
      panel,
      tabId: panel.getAttribute("data-tab-id"),
      hidden: panel.hidden,
    }));
    const selectedIds = tabs
      .filter(({ selected, tabId }) => selected === "true" && tabId)
      .map(({ tabId }) => tabId);
    const visibleIds = panels
      .filter(({ hidden, tabId }) => !hidden && tabId)
      .map(({ tabId }) => tabId);
    const preferredTabId = selectedIds.find((tabId) => visibleIds.includes(tabId))
      || selectedIds.at(-1)
      || visibleIds.at(-1)
      || null;
    this.nativeState = { tabs, panels, preferredTabId };
    if (preferredTabId) this.#preferNativeTab(preferredTabId);
  }

  #nativeTabId(tab) {
    return tab.closest(this.selectors.rightTabControllers)?.getAttribute("data-tab-id") || null;
  }

  #preferNativeTab(tabId) {
    if (!this.nativeState || !tabId) return;
    this.nativeState.preferredTabId = tabId;
    for (const state of this.nativeState.tabs) {
      if (!state.tabId) continue;
      state.selected = String(state.tabId === tabId);
      state.tabindex = state.tabId === tabId ? "0" : "-1";
    }
    for (const state of this.nativeState.panels) {
      if (state.tabId) state.hidden = state.tabId !== tabId;
    }
  }

  #syncNativeState() {
    if (!this.nativeState) {
      this.#captureNativeState();
      return;
    }
    const knownTabs = new Set(this.nativeState.tabs.map(({ tab }) => tab));
    const knownPanels = new Set(this.nativeState.panels.map(({ panel }) => panel));
    const preferredCandidates = [];
    for (const tab of this.contract.nativeTabs) {
      if (knownTabs.has(tab)) continue;
      const state = {
        tab,
        tabId: this.#nativeTabId(tab),
        selected: tab.getAttribute("aria-selected"),
        tabindex: tab.getAttribute("tabindex"),
      };
      this.nativeState.tabs.push(state);
      if (state.selected === "true" && state.tabId) preferredCandidates.push(state.tabId);
    }
    for (const panel of this.contract.nativePanels) {
      if (knownPanels.has(panel)) continue;
      const state = {
        panel,
        tabId: panel.getAttribute("data-tab-id"),
        hidden: panel.hidden,
      };
      this.nativeState.panels.push(state);
      if (!state.hidden && state.tabId) preferredCandidates.push(state.tabId);
    }
    if (preferredCandidates.length) this.#preferNativeTab(preferredCandidates.at(-1));
  }

  #restoreNativeState() {
    if (!this.nativeState) return;
    const preferredTabId = this.nativeState.preferredTabId;
    for (const { tab, tabId, selected, tabindex } of this.nativeState.tabs) {
      if (!tab.isConnected) continue;
      const restoredSelected = preferredTabId && tabId
        ? String(tabId === preferredTabId)
        : selected;
      const restoredTabindex = preferredTabId && tabId
        ? (tabId === preferredTabId ? "0" : "-1")
        : tabindex;
      if (restoredSelected == null) tab.removeAttribute("aria-selected");
      else tab.setAttribute("aria-selected", restoredSelected);
      if (restoredTabindex == null) tab.removeAttribute("tabindex");
      else tab.setAttribute("tabindex", restoredTabindex);
    }
    for (const { panel, tabId, hidden } of this.nativeState.panels) {
      if (!panel.isConnected) continue;
      panel.hidden = preferredTabId && tabId ? tabId !== preferredTabId : hidden;
    }
    this.nativeState = null;
  }

  #maskNativeState() {
    for (const tab of this.contract.nativeTabs) {
      tab.setAttribute("aria-selected", "false");
      tab.setAttribute("tabindex", "-1");
    }
    for (const panel of this.contract.nativePanels) panel.hidden = true;
  }

  #show() {
    if (!this.contract || !this.entry?.isConnected || !this.panel?.isConnected) return;
    this.#syncNativeState();
    this.#maskNativeState();
    this.entry.setAttribute("aria-selected", "true");
    this.entry.setAttribute("tabindex", "0");
    this.panel.hidden = false;
    this.panel.dataset.open = "true";
  }

  #hide() {
    this.#restoreNativeState();
    if (this.entry) {
      this.entry.setAttribute("aria-selected", "false");
      this.entry.setAttribute("tabindex", "-1");
    }
    if (this.panel) {
      this.panel.hidden = true;
      this.panel.dataset.open = "false";
    }
  }

  #handleEntryClick(event) {
    event.preventDefault();
    event.stopPropagation();
    this.activate();
  }

  #handleClosePointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeTab();
  }

  #handleCloseClick(event) {
    event.preventDefault();
    event.stopPropagation();
    this.closeTab();
  }

  #handleMenuEntryClick(event) {
    event.preventDefault();
    event.stopPropagation();
    this.open();
    this.document.dispatchEvent(new this.KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }));
  }

  #handleDocumentClick(event) {
    const action = event.target?.closest?.("button");
    const actionLabel = action?.textContent?.trim();
    if (
      this.contextNativeTabId
      &&
      this.tabShell?.isConnected
      && ["关闭其他标签页", "关闭右侧标签页", "关闭所有标签页", "关闭全部标签页"].includes(actionLabel)
    ) {
      this.closeTab();
      this.contextNativeTabId = null;
      return;
    }
    const tab = event.target?.closest?.(this.selectors.rightTabs);
    if (!tab || tab === this.entry || !this.contract?.rightTabList.contains(tab)) return;
    if (!this.active) return;
    const tabId = this.#nativeTabId(tab);
    if (!tabId) return;
    this.active = false;
    this.#hide();
    this.pendingNativeTabId = tabId;
    this.onDeactivate();
    this.queueMicrotask?.(() => {
      if (!this.disposed && !this.disabled && this.pendingNativeTabId === tabId) {
        this.#selectNativeTab(tabId);
      }
    });
  }

  #handleDocumentContextMenu(event) {
    const tab = event.target?.closest?.(this.selectors.rightTabs);
    this.contextNativeTabId = tab && tab !== this.entry
      ? this.#nativeTabId(tab)
      : null;
  }

  #selectNativeTab(tabId) {
    if (!this.contract || !tabId) return false;
    this.#refreshMountedContract();
    let matchedTab = false;
    let matchedPanel = false;
    for (const tab of this.contract.nativeTabs) {
      const selected = this.#nativeTabId(tab) === tabId;
      tab.setAttribute("aria-selected", String(selected));
      tab.setAttribute("tabindex", selected ? "0" : "-1");
      matchedTab ||= selected;
    }
    for (const panel of this.contract.nativePanels) {
      const selected = panel.getAttribute("data-tab-id") === tabId;
      panel.hidden = !selected;
      matchedPanel ||= selected;
    }
    if (matchedTab && matchedPanel) this.pendingNativeTabId = null;
    return matchedTab && matchedPanel;
  }

  #refreshMountedContract() {
    if (
      !this.contract
      || !this.contract.panelHost.isConnected
      || !this.contract.rightTabStrip.isConnected
      || !this.contract.rightTabList.isConnected
      || !this.contract.panelHost.contains(this.contract.rightTabStrip)
      || !this.contract.rightTabStrip.contains(this.contract.rightTabList)
    ) return false;
    this.contract.nativeTabs = [...this.contract.rightTabList.querySelectorAll(this.selectors.rightTabs)]
      .filter((tab) => tab.id !== this.entryId);
    this.contract.nativePanels = [...this.contract.panelHost.querySelectorAll(this.selectors.rightPanels)]
      .filter((candidate) => candidate !== this.panel && candidate.id !== this.panelId);
    return true;
  }

  #requestNativeSidebar() {
    this.awaitingSidebar = true;
    if (this.sidebarShortcutDispatched) return true;
    const missing = [];
    if (!this.KeyboardEvent) missing.push("KeyboardEvent");
    if (!this.document?.dispatchEvent) missing.push("documentDispatchEvent");
    if (missing.length) throw new CodexNativeHostContractError(missing);
    this.sidebarShortcutDispatched = true;
    this.document.dispatchEvent(new this.KeyboardEvent("keydown", SIDEBAR_SHORTCUT_INIT));
    this.document.dispatchEvent(new this.KeyboardEvent("keyup", SIDEBAR_SHORTCUT_INIT));
    return true;
  }

  #awaitSidebar() {
    this.#restoreNativeState();
    this.tabShell?.remove();
    this.panel?.remove();
    this.contract = null;
    return this.#requestNativeSidebar();
  }

  #reconcile() {
    this.#restoreNativeState();
    const base = this.#resolveBaseContract();
    const contract = this.#resolveSidebarContract(base);
    if (!contract) return this.#awaitSidebar();
    this.#attach(contract);
    return true;
  }

  #observe() {
    if (this.observer) return;
    this.observer = new this.MutationObserver(() => {
      if (this.disposed || this.disabled) return;
      this.#syncMenuEntry();
      if (this.tabClosed) {
        this.tabShell?.remove();
        this.panel?.remove();
        try {
          const base = this.#resolveBaseContract();
          const contract = this.#resolveSidebarContract(base);
          if (contract) {
            this.contract = contract;
            this.awaitingSidebar = false;
            this.sidebarShortcutDispatched = false;
          } else {
            this.contract = null;
          }
        } catch (error) {
          this.disable(error);
        }
        return;
      }
      try {
        if (this.#refreshMountedContract()) {
          this.#removeDuplicates();
          if (this.active) this.#show();
          else if (this.pendingNativeTabId) this.#selectNativeTab(this.pendingNativeTabId);
          return;
        }
        this.#reconcile();
      } catch (error) {
        this.disable(error);
      }
    });
    this.observer.observe(this.document.documentElement, { childList: true, subtree: true });
  }

  #listen() {
    if (this.listening) return;
    this.document.addEventListener("click", this.boundDocumentClick, true);
    this.document.addEventListener("contextmenu", this.boundDocumentContextMenu, true);
    this.listening = true;
  }

  mount() {
    if (this.disposed) throw new Error("CodexNativeHost is disposed");
    if (this.disabled) return false;
    try {
      const base = this.#resolveBaseContract();
      this.#observe();
      this.#listen();
      const contract = this.#resolveSidebarContract(base);
      if (contract) this.contract = contract;
      else this.#requestNativeSidebar();
      this.#syncMenuEntry();
      return true;
    } catch (error) {
      this.disable(error);
      return false;
    }
  }

  activate() {
    if (this.disposed || this.disabled) return false;
    this.tabClosed = false;
    if (!this.contract || !this.tabShell?.isConnected || !this.panel?.isConnected) {
      try {
        if (!this.#reconcile()) return false;
      } catch (error) {
        this.disable(error);
        return false;
      }
    }
    if (!this.active) {
      this.active = true;
      this.onActivate();
    }
    this.#show();
    return true;
  }

  open() {
    if (this.disposed || this.disabled) return false;
    this.tabClosed = false;
    return this.activate();
  }

  deactivate() {
    if (this.disposed || this.disabled) return false;
    if (!this.active) {
      this.#hide();
      return true;
    }
    this.active = false;
    this.#hide();
    this.onDeactivate();
    return true;
  }

  closeTab() {
    if (this.disposed || this.disabled) return false;
    const wasActive = this.active;
    this.active = false;
    this.tabClosed = true;
    this.#hide();
    this.tabShell?.remove();
    this.panel?.remove();
    this.tabShell = null;
    this.entry = null;
    this.closeButton = null;
    if (wasActive) this.onDeactivate();
    return true;
  }

  openCodexThread(threadId) {
    if (!threadId || this.disposed || this.disabled) return false;
    const row = [...this.document.querySelectorAll(this.selectors.conversationRows)]
      .find((candidate) => (
        candidate.getAttribute("data-app-action-sidebar-thread-id") === `local:${threadId}`
      ));
    if (!row) return false;
    row.click();
    return true;
  }

  disable(error) {
    if (this.disabled || this.disposed) return;
    this.disabled = true;
    this.active = false;
    this.awaitingSidebar = false;
    this.tabClosed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.#hide();
    if (this.listening) {
      this.document?.removeEventListener?.("click", this.boundDocumentClick, true);
      this.document?.removeEventListener?.("contextmenu", this.boundDocumentContextMenu, true);
      this.listening = false;
    }
    this.tabShell?.remove();
    this.panel?.remove();
    this.menuEntry?.removeEventListener("click", this.boundMenuEntryClick, true);
    this.menuEntry?.remove();
    this.contract = null;
    this.onDisable(error);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.awaitingSidebar = false;
    this.tabClosed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.#hide();
    if (this.listening) {
      this.document?.removeEventListener?.("click", this.boundDocumentClick, true);
      this.document?.removeEventListener?.("contextmenu", this.boundDocumentContextMenu, true);
      this.listening = false;
    }
    this.entry?.removeEventListener("click", this.boundEntryClick, true);
    this.closeButton?.removeEventListener("pointerdown", this.boundClosePointerDown, true);
    this.closeButton?.removeEventListener("click", this.boundCloseClick, true);
    this.menuEntry?.removeEventListener("click", this.boundMenuEntryClick, true);
    this.tabShell?.remove();
    this.panel?.remove();
    this.menuEntry?.remove();
    this.contract = null;
  }

  status() {
    return {
      mounted: Boolean(this.tabShell?.isConnected && this.panel?.isConnected),
      menuEntry: Boolean(this.menuEntry?.isConnected),
      active: this.active,
      disabled: this.disabled,
      disposed: this.disposed,
      awaitingSidebar: this.awaitingSidebar,
    };
  }
}

export function buildCodexNativeHostSource() {
  return [
    `const CODEX_NATIVE_HOST_SELECTORS = ${JSON.stringify(CODEX_NATIVE_HOST_SELECTORS)};`,
    `const TAB_CONTROLLER_CLASS = ${JSON.stringify(TAB_CONTROLLER_CLASS)};`,
    `const TAB_CONTROLLER_STYLE = ${JSON.stringify(TAB_CONTROLLER_STYLE)};`,
    `const TAB_CONTENT_CLASS = ${JSON.stringify(TAB_CONTENT_CLASS)};`,
    `const TAB_SHELL_CLASS = ${JSON.stringify(TAB_SHELL_CLASS)};`,
    `const TAB_SHELL_STYLE = ${JSON.stringify(TAB_SHELL_STYLE)};`,
    `const TAB_BACKGROUND_CLASS = ${JSON.stringify(TAB_BACKGROUND_CLASS)};`,
    `const TAB_BUTTON_CLASS = ${JSON.stringify(TAB_BUTTON_CLASS)};`,
    `const CLOSE_BUTTON_CLASS = ${JSON.stringify(CLOSE_BUTTON_CLASS)};`,
    `const TAB_SEPARATOR_CLASS = ${JSON.stringify(TAB_SEPARATOR_CLASS)};`,
    `const PANEL_CLASS = ${JSON.stringify(PANEL_CLASS)};`,
    `const SIDEBAR_SHORTCUT_INIT = Object.freeze(${JSON.stringify(SIDEBAR_SHORTCUT_INIT)});`,
    CodexNativeHostContractError.toString(),
    CodexNativeHost.toString(),
  ].join("\n");
}
