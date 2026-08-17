import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_NATIVE_HOST_SELECTORS,
  CodexNativeHost,
  CodexNativeHostContractError,
  buildCodexNativeHostSource,
} from "../lib/codex-native-host.mjs";

class FakeKeyboardEvent {
  constructor(type, init) {
    this.type = type;
    Object.assign(this, init);
  }
}

class FakeElement {
  constructor(tagName = "div", namespaceURI = "http://www.w3.org/1999/xhtml") {
    this.tagName = tagName.toUpperCase();
    this.namespaceURI = namespaceURI;
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.ownerDocument = null;
    this.dataset = {};
    this.hidden = false;
    this.id = "";
    this.type = "";
    this._textContent = "";
    this.listeners = new Map();
    this.clickCount = 0;
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this._textContent = String(value);
    for (const child of this.children) child.parentElement = null;
    this.children = [];
  }

  get isConnected() {
    for (let node = this; node; node = node.parentElement) {
      if (node.tagName === "HTML") return true;
    }
    return false;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      node.setOwnerDocument(this.ownerDocument);
      this.children.push(node);
    }
  }

  after(...nodes) {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    const index = parent.children.indexOf(this);
    for (const node of nodes) {
      node.remove();
      node.parentElement = parent;
      node.setOwnerDocument(parent.ownerDocument);
    }
    parent.children.splice(index + 1, 0, ...nodes);
  }

  replaceWith(node) {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    const index = parent.children.indexOf(this);
    node.remove();
    node.parentElement = parent;
    node.setOwnerDocument(parent.ownerDocument);
    parent.children[index] = node;
    this.parentElement = null;
  }

  cloneNode(deep = false) {
    const clone = new FakeElement(this.tagName, this.namespaceURI);
    clone.attributes = new Map(this.attributes);
    clone.dataset = { ...this.dataset };
    clone.hidden = this.hidden;
    clone.id = this.id;
    clone.type = this.type;
    clone._textContent = this._textContent;
    if (deep) clone.append(...this.children.map((child) => child.cloneNode(true)));
    return clone;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    if (name === "id" && this.id) return this.id;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener, capture = false) {
    const key = `${type}:${capture}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(listener);
  }

  removeEventListener(type, listener, capture = false) {
    this.listeners.get(`${type}:${capture}`)?.delete(listener);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.#matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.#matches(selector)) return node;
    }
    return null;
  }

  click() {
    this.clickCount += 1;
    this.ownerDocument?.dispatchClick(this);
  }

  pointerDown() {
    this.ownerDocument?.dispatchPointerDown(this);
  }

  keyDown(key) {
    this.ownerDocument?.dispatchKeyDown(this, key);
  }

  setOwnerDocument(document) {
    this.ownerDocument = document;
    for (const child of this.children) child.setOwnerDocument(document);
  }

  #matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (/^[a-z]+$/i.test(selector)) return this.tagName === selector.toUpperCase();
    if (selector === CODEX_NATIVE_HOST_SELECTORS.shell) {
      return this.tagName === "MAIN"
        && this.getAttribute("data-app-shell-main-surface") === "default";
    }
    if (selector === CODEX_NATIVE_HOST_SELECTORS.nativeContent) {
      return this.getAttribute("data-app-shell-main-content-layout") === "thread-edge-scroll";
    }
    if (selector === CODEX_NATIVE_HOST_SELECTORS.tabsHost) {
      return this.getAttribute("data-app-shell-tabs") === "true";
    }
    if (selector === CODEX_NATIVE_HOST_SELECTORS.rightTabStrip) {
      return this.getAttribute("data-app-shell-tab-strip-controller") === "right";
    }
    if (selector === CODEX_NATIVE_HOST_SELECTORS.rightTabList) {
      return this.getAttribute("role") === "tablist"
        && this.parentElement?.getAttribute("data-app-shell-tab-strip-controller") === "right";
    }
    if (selector === CODEX_NATIVE_HOST_SELECTORS.rightTabControllers) {
      return this.getAttribute("data-app-shell-tab-controller") === "right";
    }
    if (selector === CODEX_NATIVE_HOST_SELECTORS.rightTabs) {
      return this.getAttribute("role") === "tab"
        && this.closest(CODEX_NATIVE_HOST_SELECTORS.rightTabControllers) !== null;
    }
    if (selector === CODEX_NATIVE_HOST_SELECTORS.rightPanels) {
      return this.getAttribute("role") === "tabpanel"
        && this.getAttribute("data-app-shell-tab-panel-controller") === "right";
    }
    if (selector === CODEX_NATIVE_HOST_SELECTORS.addTabButton) {
      return this.tagName === "BUTTON"
        && this.getAttribute("title") === "打开侧边面板标签页";
    }
    if (selector === CODEX_NATIVE_HOST_SELECTORS.addTabLists) {
      return this.tagName === "UL";
    }
    if (selector === CODEX_NATIVE_HOST_SELECTORS.conversationRows) {
      return this.getAttribute("data-app-action-sidebar-thread-row") !== null
        && this.getAttribute("role") === "button";
    }
    return false;
  }
}

class FakeDocument {
  constructor(documentElement) {
    this.documentElement = documentElement;
    this.activeElement = null;
    this.defaultView = { KeyboardEvent: FakeKeyboardEvent };
    this.listeners = new Map();
    this.dispatchedEvents = [];
    documentElement.setOwnerDocument(this);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return [
      ...(this.documentElement.closest(selector) === this.documentElement
        ? [this.documentElement]
        : []),
      ...this.documentElement.querySelectorAll(selector),
    ];
  }

  createElement(tagName) {
    const element = new FakeElement(tagName);
    element.ownerDocument = this;
    return element;
  }

  createElementNS(namespaceURI, tagName) {
    const element = new FakeElement(tagName, namespaceURI);
    element.ownerDocument = this;
    return element;
  }

  addEventListener(type, listener, capture = false) {
    const key = `${type}:${capture}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(listener);
  }

  removeEventListener(type, listener, capture = false) {
    this.listeners.get(`${type}:${capture}`)?.delete(listener);
  }

  dispatchEvent(event) {
    this.dispatchedEvents.push(event);
    for (const listener of this.listeners.get(`${event.type}:true`) || []) listener(event);
    for (const listener of this.listeners.get(`${event.type}:false`) || []) listener(event);
    return true;
  }

  dispatchClick(target) {
    const event = {
      target,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    for (const listener of this.listeners.get("click:true") || []) listener(event);
    if (event.propagationStopped) return;
    for (const listener of target.listeners.get("click:true") || []) listener(event);
    if (event.propagationStopped) return;
    for (const listener of target.listeners.get("click:false") || []) listener(event);
  }

  dispatchPointerDown(target) {
    const event = {
      target,
      button: 0,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    for (const listener of this.listeners.get("pointerdown:true") || []) listener(event);
    if (event.propagationStopped) return;
    for (const listener of target.listeners.get("pointerdown:true") || []) listener(event);
    if (event.propagationStopped) return;
    for (const listener of target.listeners.get("pointerdown:false") || []) listener(event);
  }

  dispatchContextMenu(target) {
    const event = { target };
    for (const listener of this.listeners.get("contextmenu:true") || []) listener(event);
    for (const listener of target.listeners.get("contextmenu:true") || []) listener(event);
    for (const listener of target.listeners.get("contextmenu:false") || []) listener(event);
  }

  dispatchKeyDown(target, key) {
    const event = {
      target,
      key,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    for (const listener of this.listeners.get("keydown:true") || []) listener(event);
    if (!event.propagationStopped) {
      for (const listener of target.listeners.get("keydown:true") || []) listener(event);
    }
    if (!event.propagationStopped) {
      for (const listener of target.listeners.get("keydown:false") || []) listener(event);
    }
    if (!event.defaultPrevented && target.tagName === "BUTTON" && ["Enter", " "].includes(key)) {
      target.click();
    }
  }
}

class FakeMutationObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    FakeMutationObserver.instances.push(this);
  }

  observe(target, options) {
    this.target = target;
    this.options = options;
  }

  disconnect() {
    this.disconnected = true;
  }

  trigger() {
    this.callback([]);
  }
}

function buildRightSidebar(document, { nativeTabs = 1, nativePanels = 1, selected = true } = {}) {
  const tabsHost = document.createElement("aside");
  tabsHost.setAttribute("data-app-shell-tabs", "true");
  const strip = document.createElement("header");
  strip.setAttribute("data-app-shell-tab-strip-controller", "right");
  const tabList = document.createElement("div");
  tabList.setAttribute("role", "tablist");
  strip.append(tabList);
  const addButton = document.createElement("button");
  addButton.setAttribute("title", "打开侧边面板标签页");
  addButton.setAttribute("aria-controls", "native-add-tab-menu");
  strip.append(addButton);
  tabsHost.append(strip);

  const menu = document.createElement("ul");
  menu.id = "native-add-tab-menu";
  for (const label of ["审阅", "终端", "浏览器", "文件", "侧边聊天"]) {
    const row = document.createElement("li");
    const item = document.createElement("button");
    const icon = document.createElement("svg");
    const text = document.createElement("span");
    text.textContent = label;
    item.append(icon, text);
    row.append(item);
    menu.append(row);
  }
  tabsHost.append(menu);

  const tabs = [];
  for (let index = 0; index < nativeTabs; index += 1) {
    const controller = document.createElement("div");
    controller.setAttribute("data-app-shell-tab-controller", "right");
    controller.setAttribute("data-tab-id", `native-${index}`);
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(selected && index === 0));
    tab.setAttribute("tabindex", selected && index === 0 ? "0" : "-1");
    tab.textContent = index ? "审阅" : "侧边聊天";
    controller.append(tab);
    tabList.append(controller);
    tabs.push(tab);
  }

  const panels = [];
  for (let index = 0; index < nativePanels; index += 1) {
    const panel = document.createElement("div");
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("data-app-shell-tab-panel-controller", "right");
    panel.setAttribute("data-tab-id", `native-${index}`);
    panel.setAttribute("aria-label", index ? "审阅" : "侧边聊天");
    panel.hidden = index > 0;
    tabsHost.append(panel);
    panels.push(panel);
  }
  return { tabsHost, strip, tabList, addButton, menu, tabs, panels };
}

function appendNativeTabPanel(document, right, { tabId, label, selected = false, hidden = true }) {
  const controller = document.createElement("div");
  controller.setAttribute("data-app-shell-tab-controller", "right");
  controller.setAttribute("data-tab-id", tabId);
  const tab = document.createElement("button");
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", String(selected));
  tab.setAttribute("tabindex", selected ? "0" : "-1");
  tab.textContent = label;
  controller.append(tab);
  right.tabList.append(controller);

  const panel = document.createElement("div");
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("data-app-shell-tab-panel-controller", "right");
  panel.setAttribute("data-tab-id", tabId);
  panel.setAttribute("aria-label", label);
  panel.hidden = hidden;
  right.tabsHost.append(panel);
  right.tabs.push(tab);
  right.panels.push(panel);
  return { controller, tab, panel };
}

function fixture({ sidebar = "native", nativeTabs = 1, nativePanels = 1, selected = true } = {}) {
  FakeMutationObserver.instances = [];
  const documentElement = new FakeElement("html");
  const shell = new FakeElement("main");
  shell.setAttribute("data-app-shell-main-surface", "default");
  const nativeContent = new FakeElement("article");
  nativeContent.setAttribute("data-app-shell-main-content-layout", "thread-edge-scroll");
  shell.append(nativeContent);
  const nav = new FakeElement("nav");
  const threadRow = new FakeElement("div");
  threadRow.setAttribute("data-app-action-sidebar-thread-row", "");
  threadRow.setAttribute("data-app-action-sidebar-thread-id", "local:thread-123");
  threadRow.setAttribute("role", "button");
  nav.append(threadRow);
  documentElement.append(shell, nav);
  const document = new FakeDocument(documentElement);
  let right = null;
  if (sidebar !== "none") {
    right = buildRightSidebar(document, {
      nativeTabs: sidebar === "empty" ? 0 : nativeTabs,
      nativePanels: sidebar === "empty" ? 0 : nativePanels,
      selected,
    });
    shell.append(right.tabsHost);
  }
  const panel = document.createElement("section");
  const createHost = (options = {}) => new CodexNativeHost({
    document,
    MutationObserver: FakeMutationObserver,
    KeyboardEvent: FakeKeyboardEvent,
    panel,
    createIcon: () => document.createElement("svg"),
    ...options,
  });
  return {
    document,
    documentElement,
    shell,
    nativeContent,
    threadRow,
    panel,
    right,
    createHost,
    attachRightSidebar(options = {}) {
      right = buildRightSidebar(document, options);
      shell.append(right.tabsHost);
      this.right = right;
      return right;
    },
  };
}

function assertNativeContentVisible(context) {
  assert.equal(context.nativeContent.hidden, false);
}

test("无右栏时仅派发一次 Meta+Alt+S，并等待原生宿主", () => {
  const context = fixture({ sidebar: "none" });
  const host = context.createHost();

  assert.equal(host.mount(), true);
  assert.deepEqual(host.status(), {
    mounted: false,
    menuEntry: false,
    active: false,
    disabled: false,
    disposed: false,
    awaitingSidebar: true,
  });
  assert.deepEqual(context.document.dispatchedEvents.map(({ type, key, code, metaKey, altKey }) => ({
    type, key, code, metaKey, altKey,
  })), [
    { type: "keydown", key: "s", code: "KeyS", metaKey: true, altKey: true },
    { type: "keyup", key: "s", code: "KeyS", metaKey: true, altKey: true },
  ]);
  FakeMutationObserver.instances[0].trigger();
  assert.equal(context.document.dispatchedEvents.length, 2);
  assertNativeContentVisible(context);
});

test("原生快捷键创建宿主后 MutationObserver 挂载任务 Tab 与 Panel", () => {
  const context = fixture({ sidebar: "none" });
  const host = context.createHost();
  host.mount();
  host.activate();

  const right = context.attachRightSidebar();
  FakeMutationObserver.instances[0].trigger();

  assert.equal(host.status().mounted, true);
  assert.equal(host.status().active, true);
  assert.equal(host.status().awaitingSidebar, false);
  assert.equal(host.tabShell.parentElement, right.tabList);
  assert.equal(host.tabShell.getAttribute("data-app-shell-tab-controller"), "right");
  assert.equal(host.tabShell.getAttribute("data-tab-id"), "ninecodex-task-center");
  assert.equal(
    host.tabShell.getAttribute("class"),
    "@container/app-shell-tab my-auto relative flex shrink-0 items-center overflow-hidden contain-content",
  );
  assert.equal(
    host.tabShell.getAttribute("style"),
    "flex-basis: 114px; flex-grow: 0; max-width: 160px; min-width: 90px;",
  );
  assert.equal(host.tabShell.children.length, 2);
  const [content, separator] = host.tabShell.children;
  assert.equal(content.getAttribute("class"), "flex min-w-0 flex-1 items-center pe-1");
  assert.equal(content.children.length, 1);
  const tabBody = content.children[0];
  assert.equal(tabBody.getAttribute("data-tab-id"), "ninecodex-task-center");
  assert.equal(tabBody.getAttribute("role"), null);
  assert.equal(tabBody.getAttribute("tabindex"), null);
  assert.equal(tabBody.getAttribute("aria-disabled"), null);
  assert.equal(
    tabBody.getAttribute("style"),
    "--app-shell-tab-background: color-mix(in srgb, var(--color-token-foreground, var(--color-text-foreground)) 5%, var(--color-token-main-surface-primary));",
  );
  assert.equal(tabBody.children.length, 3);
  const [background, entry, closeButton] = tabBody.children;
  assert.equal(
    background.getAttribute("class"),
    "pointer-events-none absolute inset-0 z-0 rounded-md group-hover/tab:bg-[var(--app-shell-tab-background)] bg-[var(--app-shell-tab-background)]",
  );
  assert.equal(entry, host.entry);
  assert.match(entry.getAttribute("class"), /focus-visible:outline/);
  assert.equal(entry.children.at(-1).getAttribute("class"), "relative min-w-0 flex-1 overflow-hidden");
  assert.equal(entry.children.at(-1).children[0].textContent, "任务中心");
  assert.equal(closeButton, host.closeButton);
  assert.match(closeButton.getAttribute("class"), /focus-visible:outline/);
  assert.equal(closeButton.textContent, "");
  assert.equal(closeButton.children.length, 1);
  assert.equal(closeButton.children[0].tagName, "SVG");
  assert.equal(closeButton.children[0].getAttribute("viewBox"), "0 0 21 21");
  assert.equal(closeButton.children[0].children[0].tagName, "PATH");
  assert.equal(closeButton.children[0].children[0].getAttribute("fill"), "currentColor");
  assert.equal(separator.getAttribute("aria-hidden"), "true");
  assert.equal(separator.getAttribute("data-app-shell-tab-separator"), "ninecodex-task-center");
  assert.equal(
    separator.getAttribute("class"),
    "h-3 w-px shrink-0 end-0 absolute bg-token-border transition-opacity duration-basic opacity-0",
  );
  assert.equal(context.panel.parentElement, right.tabsHost);
  assert.equal(context.panel.getAttribute("data-app-shell-tab-panel-controller"), "right");
  assert.equal(context.panel.getAttribute("data-tab-id"), "ninecodex-task-center");
  assert.equal(context.panel.hidden, false);
  assertNativeContentVisible(context);
});

test("空原生右栏不要求 nativeTabs、selected tab 或 native panel", () => {
  const context = fixture({ sidebar: "empty" });
  const host = context.createHost();

  assert.equal(host.mount(), true);
  assert.equal(host.status().disabled, false);
  assert.equal(host.status().mounted, false);
  assert.equal(host.status().menuEntry, true);
  assert.equal(host.activate(), true);
  assert.equal(host.tabShell.parentElement, context.right.tabList);
  assert.equal(context.panel.parentElement, context.right.tabsHost);
  assert.equal(context.panel.hidden, false);
  assertNativeContentVisible(context);
});

test("多个原生 Panel、无选中原生 Tab 时仍可挂载并恢复状态", () => {
  const context = fixture({ nativeTabs: 2, nativePanels: 2, selected: false });
  const host = context.createHost();
  host.mount();
  host.activate();

  assert.equal(host.status().disabled, false);
  assert.ok(context.right.tabs.every((tab) => tab.getAttribute("aria-selected") === "false"));
  assert.ok(context.right.panels.every((panel) => panel.hidden));
  host.deactivate();
  assert.deepEqual(context.right.panels.map((panel) => panel.hidden), [false, true]);
  assertNativeContentVisible(context);
});

test("点击原生右侧 Tab 停用任务中心但保留任务 Tab", () => {
  const context = fixture();
  const host = context.createHost();
  host.mount();
  host.activate();

  context.right.tabs[0].click();

  assert.equal(host.status().active, false);
  assert.equal(host.status().mounted, true);
  assert.equal(context.right.tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(context.right.panels[0].hidden, false);
  assert.equal(context.panel.hidden, true);
  assertNativeContentVisible(context);
});

test("任务激活时动态新增审阅，切换侧边聊天与审阅始终保持唯一选中和正确 Panel", async () => {
  const context = fixture();
  const host = context.createHost();
  host.mount();
  host.activate();

  const review = appendNativeTabPanel(context.document, context.right, {
    tabId: "diff",
    label: "审阅",
    selected: true,
    hidden: false,
  });
  FakeMutationObserver.instances[0].trigger();

  assert.equal(host.status().active, true);
  assert.equal(host.entry.getAttribute("aria-selected"), "true");
  assert.equal(context.right.tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").length, 0);
  assert.ok(context.right.panels.every((panel) => panel.hidden));
  assert.equal(context.panel.hidden, false);
  assertNativeContentVisible(context);

  context.right.tabs[0].addEventListener("click", () => {
    context.right.tabs[0].setAttribute("aria-selected", "true");
    context.right.tabs[0].setAttribute("tabindex", "0");
    review.tab.setAttribute("aria-selected", "false");
    review.tab.setAttribute("tabindex", "-1");
    context.right.panels[0].hidden = false;
    review.panel.hidden = true;
  });
  review.tab.addEventListener("click", () => {
    context.right.tabs[0].setAttribute("aria-selected", "false");
    context.right.tabs[0].setAttribute("tabindex", "-1");
    review.tab.setAttribute("aria-selected", "true");
    review.tab.setAttribute("tabindex", "0");
    context.right.panels[0].hidden = true;
    review.panel.hidden = false;
  });

  context.right.tabs[0].click();
  await Promise.resolve();

  assert.equal(host.status().active, false);
  assert.equal([
    host.entry,
    ...context.right.tabs,
  ].filter((tab) => tab.getAttribute("aria-selected") === "true").length, 1);
  assert.equal(context.right.tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(review.tab.getAttribute("aria-selected"), "false");
  assert.equal(context.right.panels[0].hidden, false);
  assert.equal(review.panel.hidden, true);
  assert.equal(context.panel.hidden, true);
  assertNativeContentVisible(context);

  review.tab.click();
  await Promise.resolve();

  assert.equal([
    host.entry,
    ...context.right.tabs,
  ].filter((tab) => tab.getAttribute("aria-selected") === "true").length, 1);
  assert.equal(context.right.tabs[0].getAttribute("aria-selected"), "false");
  assert.equal(review.tab.getAttribute("aria-selected"), "true");
  assert.equal(context.right.panels[0].hidden, true);
  assert.equal(review.panel.hidden, false);
  assert.equal(context.panel.hidden, true);
  assertNativeContentVisible(context);
});

test("capture 先恢复旧选中态，原生 handler 重建目标 Panel 后再归一化", async () => {
  const context = fixture({ nativeTabs: 1, nativePanels: 0, selected: false });
  const review = appendNativeTabPanel(context.document, context.right, {
    tabId: "diff",
    label: "审阅",
    selected: true,
    hidden: false,
  });
  const host = context.createHost();
  host.mount();
  host.activate();

  let sidechatPanel;
  context.right.tabs[0].addEventListener("click", () => {
    assert.equal(context.right.tabs[0].getAttribute("aria-selected"), "false");
    assert.equal(review.tab.getAttribute("aria-selected"), "true");
    assert.equal(review.panel.hidden, false);
    assert.equal(context.panel.hidden, true);

    context.right.tabs[0].setAttribute("aria-selected", "true");
    context.right.tabs[0].setAttribute("tabindex", "0");
    review.tab.setAttribute("aria-selected", "false");
    review.tab.setAttribute("tabindex", "-1");
    review.panel.remove();
    sidechatPanel = context.document.createElement("div");
    sidechatPanel.setAttribute("role", "tabpanel");
    sidechatPanel.setAttribute("data-app-shell-tab-panel-controller", "right");
    sidechatPanel.setAttribute("data-tab-id", "native-0");
    sidechatPanel.setAttribute("aria-label", "侧边聊天");
    sidechatPanel.hidden = false;
    context.right.tabsHost.append(sidechatPanel);
  });

  context.right.tabs[0].click();
  await Promise.resolve();

  assert.equal(host.status().active, false);
  assert.equal([
    host.entry,
    ...context.right.tabs,
  ].filter((tab) => tab.getAttribute("aria-selected") === "true").length, 1);
  assert.equal(context.right.tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(review.tab.getAttribute("aria-selected"), "false");
  assert.equal(sidechatPanel.hidden, false);
  assert.equal(review.panel.isConnected, false);
  assert.equal(context.panel.hidden, true);
  assertNativeContentVisible(context);
});

test("原生关闭按钮关闭任务 Tab；后台同步不重开；菜单入口重新打开", () => {
  const context = fixture();
  const host = context.createHost();
  host.mount();
  host.activate();
  const firstShell = host.tabShell;
  const closeIcon = host.closeButton.children[0];
  const originalOpen = host.open.bind(host);
  let openCalls = 0;
  host.open = () => {
    openCalls += 1;
    return originalOpen();
  };

  assert.equal(closeIcon.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(closeIcon.children[0].namespaceURI, "http://www.w3.org/2000/svg");

  host.closeButton.pointerDown();

  assert.equal(host.closeButton, null);
  assert.equal(firstShell.children[0].children[0].children[2].clickCount, 0);
  assert.equal(host.status().mounted, false);
  assert.equal(firstShell.parentElement, null);
  assert.equal(context.panel.parentElement, null);
  assert.equal(context.right.menu.contains(host.menuEntry), true);
  assert.equal(host.menuEntry.textContent, "任务中心");
  assert.equal(context.document.querySelector("#ninecodex-task-center-restore"), null);
  assert.equal(context.right.tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(context.right.panels[0].hidden, false);
  FakeMutationObserver.instances[0].trigger();
  assert.equal(host.status().mounted, false);
  assert.equal(host.status().active, false);
  assert.equal(host.status().menuEntry, true);
  assert.equal(openCalls, 0);

  host.menuEntry.keyDown("Enter");

  assert.equal(openCalls, 1);
  assert.notEqual(host.tabShell, firstShell);
  assert.equal(host.status().mounted, true);
  assert.equal(host.status().active, true);
  assertNativeContentVisible(context);
});

test("菜单入口、Tab、关闭入口支持键盘操作", () => {
  const context = fixture();
  const host = context.createHost();
  host.mount();

  assert.equal(host.menuEntry.tagName, "BUTTON");
  host.menuEntry.keyDown("Enter");
  assert.equal(host.status().active, true);
  assert.equal(host.entry.tagName, "BUTTON");
  assert.equal(host.entry.getAttribute("role"), "tab");

  host.closeButton.keyDown(" ");
  assert.equal(host.status().mounted, false);
  host.menuEntry.keyDown(" ");
  assert.equal(host.status().mounted, true);
  assert.equal(host.status().active, true);
  assertNativeContentVisible(context);
});

test("原生标签右键关闭其他标签页时同步关闭任务中心", () => {
  const context = fixture();
  const host = context.createHost();
  host.mount();
  host.activate();
  const action = context.document.createElement("button");
  action.textContent = "关闭其他标签页";
  context.documentElement.append(action);

  context.document.dispatchContextMenu(context.right.tabs[0]);
  action.click();

  assert.equal(host.status().mounted, false);
  assert.equal(host.status().active, false);
  assert.equal(context.panel.parentElement, null);
  assert.equal(host.status().menuEntry, true);
});

test("非标签上下文中的同名操作不关闭任务中心", () => {
  const context = fixture();
  const host = context.createHost();
  host.mount();
  host.activate();
  const action = context.document.createElement("button");
  action.textContent = "关闭其他标签页";
  context.documentElement.append(action);

  action.click();

  assert.equal(host.status().mounted, true);
  assert.equal(host.status().active, true);
});

test("关闭后原生右栏重建只恢复菜单入口，不自动打开任务 Panel", () => {
  const context = fixture();
  const host = context.createHost();
  host.mount();
  host.activate();
  host.closeTab();

  context.right.tabsHost.remove();
  FakeMutationObserver.instances[0].trigger();
  assert.equal(host.status().mounted, false);
  assert.equal(host.status().active, false);
  assert.equal(context.document.dispatchedEvents.length, 0);

  const right = context.attachRightSidebar();
  FakeMutationObserver.instances[0].trigger();

  assert.equal(host.status().mounted, false);
  assert.equal(host.status().active, false);
  assert.equal(right.menu.contains(host.menuEntry), true);
  assert.equal(context.panel.parentElement, null);
  assert.equal(context.document.dispatchedEvents.length, 0);
  assertNativeContentVisible(context);
});

test("React 移除宿主后恢复原生状态、重新请求一次并保持单实例", () => {
  const context = fixture();
  const host = context.createHost();
  host.mount();
  host.activate();

  context.right.tabsHost.remove();
  FakeMutationObserver.instances[0].trigger();

  assert.equal(host.status().disabled, false);
  assert.equal(host.status().mounted, false);
  assert.equal(host.status().awaitingSidebar, true);
  assert.equal(context.document.dispatchedEvents.length, 2);

  const right = context.attachRightSidebar();
  FakeMutationObserver.instances[0].trigger();
  const duplicateController = context.document.createElement("div");
  duplicateController.id = "ninecodex-task-center-tab-shell";
  right.tabList.append(duplicateController);
  const duplicatePanel = context.document.createElement("section");
  duplicatePanel.id = "ninecodex-session-task-panel";
  right.tabsHost.append(duplicatePanel);
  FakeMutationObserver.instances[0].trigger();

  assert.equal(context.document.querySelectorAll("#ninecodex-task-center-tab-shell").length, 1);
  assert.equal(context.document.querySelectorAll("#ninecodex-session-task-panel").length, 1);
  assert.equal(host.status().mounted, true);
  assertNativeContentVisible(context);
});

test("重复准确宿主契约 fail closed；合法缺少宿主不 disable", () => {
  const context = fixture();
  const duplicate = buildRightSidebar(context.document);
  context.shell.append(duplicate.tabsHost);
  let failure;
  const host = context.createHost({ onDisable: (error) => { failure = error; } });

  assert.equal(host.mount(), false);
  assert.equal(host.status().disabled, true);
  assert.ok(failure instanceof CodexNativeHostContractError);
  assert.ok(failure.missing.includes("uniqueTabsHost"));
  assert.equal(context.panel.parentElement, null);
  assertNativeContentVisible(context);

  const emptyContext = fixture({ sidebar: "none" });
  const waitingHost = emptyContext.createHost();
  assert.equal(waitingHost.mount(), true);
  assert.equal(waitingHost.status().disabled, false);
  assert.equal(waitingHost.status().awaitingSidebar, true);
});

test("openCodexThread 不改变任务中心激活状态", () => {
  const context = fixture();
  const host = context.createHost();
  host.mount();
  host.activate();

  assert.equal(host.openCodexThread("thread-123"), true);
  assert.equal(context.threadRow.clickCount, 1);
  assert.equal(host.status().active, true);
  assert.equal(context.panel.hidden, false);
  assert.equal(host.openCodexThread("missing"), false);
  assertNativeContentVisible(context);
});

test("中间聊天在 mount、activate、deactivate、close、disable、dispose 全程可见", () => {
  for (const action of ["mount", "activate", "deactivate", "closeTab", "disable", "dispose"]) {
    const context = fixture();
    const host = context.createHost();
    host.mount();
    host.activate();
    if (action === "disable") host.disable(new Error("contract changed"));
    else host[action]();
    assertNativeContentVisible(context);
  }
});

test("源码只包含 2026-08-14 精确 data 契约与 Meta+Alt+S", () => {
  assert.deepEqual(CODEX_NATIVE_HOST_SELECTORS, {
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

  const source = buildCodexNativeHostSource();
  assert.match(source, /data-app-shell-tabs/);
  assert.match(source, /data-app-shell-tab-strip-controller/);
  assert.match(source, /data-app-shell-tab-controller/);
  assert.match(source, /data-app-shell-tab-panel-controller/);
  assert.match(source, /打开侧边面板标签页/);
  assert.match(source, /ninecodex-task-center/);
  assert.match(source, /key:\s*\\?"s\\?"|key.*s/);
  assert.match(source, /code:\s*\\?"KeyS\\?"|code.*KeyS/);
  assert.match(source, /metaKey/);
  assert.match(source, /altKey/);
  assert.match(source, /new this\.KeyboardEvent\("keydown"/);
  assert.match(source, /new this\.KeyboardEvent\("keyup"/);
  assert.match(source, /MutationObserver/);
  assert.doesNotMatch(source, /nativeContent\.hidden\s*=/);
  assert.doesNotMatch(source, /打开任务中心/);
  assert.doesNotMatch(source, /显示\/隐藏侧边栏|展开面板|Meta\+Alt\+B|KeyB/);
  assert.doesNotMatch(source, /getBoundingClientRect|__reactProps|__reactFiber|memoizedProps/);
  assert.doesNotMatch(source, /options\.selectors|setInterval|setTimeout|ShadowRoot|attachShadow|iframe|position\s*:\s*fixed/i);
});
