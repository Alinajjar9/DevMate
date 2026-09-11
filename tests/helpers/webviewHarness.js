const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Small DOM fixture for the APIs used by webview.js. It loads the real markup and
// script, records extension messages and lets tests advance streaming timers.
class Element {
  constructor(tagName, document) {
    this.tagName = tagName;
    this.document = document;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.value = '';
    this.id = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); }
    };
  }

  set textContent(value) {
    this.replaceChildren();
    this.text = String(value);
  }

  get textContent() {
    return (this.text || '') + this.children.map((child) => child.textContent).join('');
  }

  get firstElementChild() { return this.children[0]; }
  get options() { return this.children.filter((child) => child.tagName === 'option'); }

  appendChild(child) {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children) { children.forEach((child) => this.appendChild(child)); }

  replaceChildren(...children) {
    this.children.forEach((child) => { child.parent = undefined; });
    this.children = [];
    this.text = '';
    this.append(...children);
  }

  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = undefined;
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'id' || name === 'value') this[name] = String(value);
    if (name === 'hidden' || name === 'disabled') this[name] = true;
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value);
  }

  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name === 'id') return this.id;
    if (name.startsWith('data-')) return this.dataset[dataKey(name)];
    return this.attributes[name];
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'id') this.id = '';
  }

  addEventListener(type, callback, options = {}) {
    const handlers = this.listeners.get(type) || [];
    handlers.push({ callback, once: options.once });
    this.listeners.set(type, handlers);
  }

  dispatch(type, values = {}) {
    const event = {
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...values
    };
    const handlers = [...(this.listeners.get(type) || [])];
    handlers.forEach(({ callback }) => callback(event));
    this.listeners.set(type, handlers.filter((handler) => !handler.once));
    return event;
  }

  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { this.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  reset() { this.querySelectorAll('input, select, textarea').forEach((input) => { input.value = ''; }); }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  querySelectorAll(selector) {
    const selectors = selector.split(',').map((part) => part.trim().split(/\s+/));
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selectors.some((parts) => matchesPath(child, parts))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

function dataKey(attribute) {
  return attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function matches(element, selector) {
  const tag = selector.match(/^[a-z]+/);
  const id = selector.match(/#([\w-]+)/);
  const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
  const attributes = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
  return (!tag || element.tagName === tag[0])
    && (!id || element.id === id[1])
    && classes.every((name) => element.className.split(' ').includes(name))
    && attributes.every(([, name, value]) => value === undefined
      ? element.getAttribute(name) !== undefined
      : element.getAttribute(name) === value);
}

function matchesPath(element, parts) {
  if (!matches(element, parts.at(-1))) return false;
  let ancestor = element.parent;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matches(ancestor, parts[index])) ancestor = ancestor.parent;
    if (!ancestor) return false;
    ancestor = ancestor.parent;
  }
  return true;
}

function createWebviewHarness() {
  const root = path.join(__dirname, '..', '..');
  const markup = fs.readFileSync(path.join(root, 'src', 'webview.ts'), 'utf8');
  const document = new Element('document');
  document.document = document;
  document.getElementById = (id) => document.querySelector('#' + id);
  document.createElement = (tag) => new Element(tag, document);
  document.createTextNode = (text) => {
    const node = document.createElement('#text');
    node.textContent = text;
    return node;
  };

  const stack = [document];
  const html = markup.slice(markup.indexOf('<body>'), markup.indexOf('</body>') + 7);
  for (const match of html.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>|([^<]+)/g)) {
    const [, tag, attributes, text] = match;
    if (text) {
      stack.at(-1).appendChild(document.createTextNode(text));
    } else if (match[0].startsWith('</')) {
      stack.pop();
    } else {
      const element = document.createElement(tag);
      for (const attribute of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        element.setAttribute(attribute[1], attribute[2] || '');
      }
      stack.at(-1).appendChild(element);
      if (!['input', 'br', 'hr', 'img'].includes(tag) && !attributes.endsWith('/')) stack.push(element);
    }
  }

  const window = new Element('window', document);
  const messages = [];
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    document,
    window,
    URL,
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(structuredClone(message)) }),
    setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++nextTimer,
    clearInterval: () => {}
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'media', 'webview.js'), 'utf8'), context);

  return {
    document,
    messages,
    get: (id) => document.getElementById(id),
    receive: (message) => window.dispatch('message', { data: message }),
    flushTimers() {
      let remaining = 10_000;
      while (timers.size && remaining-- > 0) {
        const [id, callback] = timers.entries().next().value;
        timers.delete(id);
        callback();
      }
      if (timers.size) throw new Error('Webview streaming timers did not settle.');
    }
  };
}

module.exports = { createWebviewHarness };
