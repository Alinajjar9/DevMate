const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Only the DOM operations used by DevMate are implemented here. This tests event
// behavior, not browser layout; the packaged UI still needs a real-browser check.
class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toLowerCase();
    this.ownerDocument = document;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this.id = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.options = [{ textContent: '' }];
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' ').trim(); }
    };
  }

  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.replaceChildren(); }
  set innerHTML(_value) { throw new Error('The chat must build safe DOM nodes instead of assigning HTML.'); }
  get firstElementChild() { return this.children[0] ?? null; }
  get scrollHeight() { return this.children.length; }
  appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) {
    for (const child of this.children) child.parent = undefined;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = undefined;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id' || name === 'class') this[name === 'class' ? 'className' : name] = String(value);
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value);
  }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[dataKey(name)] ?? null;
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'id') this.id = '';
    if (name.startsWith('data-')) delete this.dataset[dataKey(name)];
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) {
      listener({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  reset() { /* Profile handlers assign all values after resetting the form. */ }
  showModal() { this.open = true; }
  close() { if (this.open) { this.open = false; this.dispatch('close'); } }
  contains(candidate) { return candidate === this || this.children.some((child) => child.contains(candidate)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selector.split(',').some((part) => matchesSelector(child, part.trim()))) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

function dataKey(attribute) {
  return attribute.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function matchesSelector(node, selector) {
  // Spaces inside an attribute value are not descendant separators.
  const parts = selector.match(/(?:\[[^\]]*\]|[^\s\[\]])+/g);
  if (!matchesSimpleSelector(node, parts.pop())) return false;
  while (parts.length) {
    const parentSelector = parts.pop();
    do { node = node.parent; } while (node && !matchesSimpleSelector(node, parentSelector));
    if (!node) return false;
  }
  return true;
}

function matchesSimpleSelector(node, selector) {
  const tag = selector.match(/^[a-z]+/i)?.[0];
  if (tag && node.tagName !== tag) return false;
  const id = selector.match(/#([\w-]+)/)?.[1];
  if (id && node.id !== id) return false;
  for (const [, className] of selector.matchAll(/\.([\w-]+)/g)) {
    if (!node.className.split(/\s+/).includes(className)) return false;
  }
  for (const [, name, value] of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
    const actual = node.getAttribute(name);
    if (value === undefined ? actual === null : actual !== value) return false;
  }
  return true;
}

function createWebviewHarness() {
  const root = path.join(__dirname, '..', '..');
  const document = new Element('document');
  document.ownerDocument = document;
  document.createElement = (tag) => new Element(tag, document);
  document.createTextNode = (text) => {
    const node = document.createElement('#text');
    node.textContent = text;
    return node;
  };
  document.getElementById = (id) => document.querySelector('#' + id);

  // Read the actual shell so removing or renaming an element breaks its handlers.
  // Static elements are flat here: these tests only query their IDs/classes.
  const shell = fs.readFileSync(path.join(root, 'src', 'chat', 'webview.ts'), 'utf8');
  for (const [, tag, attributes] of shell.matchAll(/<([a-z][\w-]*)\b([^>]*?)>/gi)) {
    const element = document.createElement(tag);
    for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
      element.setAttribute(name, value);
      if (name === 'value') element.value = value;
    }
    element.hidden = /(?:^|\s)hidden(?:\s|$)/.test(attributes);
    document.appendChild(element);
  }

  const messages = [];
  const window = new Element('window', document);
  const timeouts = new Map();
  const intervals = new Map();
  let nextTimer = 1;
  const context = vm.createContext({
    document, window, URL, console,
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(JSON.parse(JSON.stringify(message))) }),
    setTimeout: (callback, delay) => { const id = nextTimer++; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (callback) => { const id = nextTimer++; intervals.set(id, callback); return id; },
    clearInterval: (id) => intervals.delete(id)
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'media', 'webview.js'), 'utf8'), context, {
    filename: 'media/webview.js'
  });

  return {
    document,
    messages,
    element: (id) => document.getElementById(id),
    receive: (message) => window.dispatch('message', { data: message }),
    call: (name, ...args) => context[name](...args),
    supportedCommands: () => Array.from(vm.runInContext('Object.keys(extensionMessageHandlers)', context)),
    flushTimeouts() {
      let iterations = 0;
      while (timeouts.size) {
        if (++iterations > 10_000) throw new Error('Webview timers did not settle.');
        const [id, timer] = timeouts.entries().next().value;
        timeouts.delete(id);
        timer.callback();
      }
    },
    pendingTimeouts: () => timeouts.size,
    activeIntervals: () => intervals.size
  };
}

module.exports = { createWebviewHarness };
