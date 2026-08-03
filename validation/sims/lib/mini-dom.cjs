/**
 * Deterministic mini-DOM for the feature sims — just enough DOM for the
 * extracted theme-JS functions to run unmodified, and DOCUMENTED where it
 * is narrower than a browser:
 *
 *  - selector engine: comma lists, descendant combinator (space), and
 *    compound parts of tag + .class + [attr] / [attr="v"] / [attr*="v"].
 *    Anything else returns no match — exactly like a selector that finds
 *    nothing (the fail-closed convention the shipped code already obeys).
 *  - setAttribute('checked'/'disabled') also sets the JS property, like
 *    parser-set default state on a fresh element.
 *  - innerHTML assignment stores the string verbatim (no parsing); the
 *    sims never inspect innerHTML-built children.
 *  - addEventListener stores listeners; tests fire them via _fire(type).
 *  - v8 extensions for the proof-library sim (cellexia-proof.js): document
 *    gains createElementNS (returns a plain El tagged with its namespace —
 *    structure only, no real SVG semantics) and a static documentElement
 *    {lang: "en"} for Intl-locale readers (pfPageLocale). Nothing else.
 */
"use strict";

function parseCompound(part) {
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:\.[A-Za-z0-9_-]+|\[[^\]]+\])*)$/.exec(
    part.trim(),
  );
  if (!m) return null;
  const spec = { tag: m[1] ? m[1].toUpperCase() : null, classes: [], attrs: [] };
  const rest = m[2] || "";
  const re = /\.([A-Za-z0-9_-]+)|\[([^\]]+)\]/g;
  let t;
  while ((t = re.exec(rest))) {
    if (t[1]) spec.classes.push(t[1]);
    else {
      const a = t[2];
      const am = /^([A-Za-z0-9_-]+)(?:([*^$]?)=["']?([^"']*)["']?)?$/.exec(a);
      if (!am) return null;
      spec.attrs.push({ name: am[1], op: am[2] || (am[3] !== undefined ? "=" : ""), value: am[3] });
    }
  }
  return spec;
}

function matchesCompound(el, spec) {
  if (!spec) return false;
  if (spec.tag && el.tagName !== spec.tag) return false;
  const classes = (el.attrs.class || "").split(/\s+/);
  for (const c of spec.classes) if (!classes.includes(c)) return false;
  for (const a of spec.attrs) {
    const v = el.attrs[a.name];
    if (v === undefined) return false;
    if (a.value === undefined) continue; // presence-only
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "*" && v.indexOf(a.value) === -1) return false;
    if (a.op === "^" && v.indexOf(a.value) !== 0) return false;
    if (a.op === "$" && !v.endsWith(a.value)) return false;
  }
  return true;
}

function matchesSelector(el, selector) {
  const chains = String(selector).split(",");
  for (const chain of chains) {
    const parts = chain.trim().split(/\s+/).map(parseCompound);
    if (parts.some((p) => p === null)) continue;
    const last = parts[parts.length - 1];
    if (!matchesCompound(el, last)) continue;
    let node = el.parentNode;
    let i = parts.length - 2;
    while (i >= 0 && node) {
      if (node.nodeType === 1 && matchesCompound(node, parts[i])) i--;
      node = node.parentNode;
    }
    if (i < 0) return true;
  }
  return false;
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.attrs = {};
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this._text = "";
    this._innerHTML = null;
    this._listeners = {};
    this.checked = false;
    this.disabled = false;
  }
  get id() { return this.attrs.id || ""; }
  set id(v) { this.attrs.id = String(v); }
  get className() { return this.attrs.class || ""; }
  set className(v) { this.attrs.class = String(v); }
  get innerHTML() { return this._innerHTML || ""; }
  set innerHTML(v) { this._innerHTML = String(v); this.childNodes = []; }
  setAttribute(n, v) {
    this.attrs[n] = String(v);
    if (n === "checked") this.checked = true;
    if (n === "disabled") this.disabled = true;
  }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  removeAttribute(n) {
    delete this.attrs[n];
    if (n === "checked") this.checked = false;
    if (n === "disabled") this.disabled = false;
  }
  hasAttribute(n) { return n in this.attrs; }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    node.parentNode = this;
    if (i === -1) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i !== -1) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const sib = this.parentNode.childNodes;
    return sib[sib.indexOf(this) + 1] || null;
  }
  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v) { this.childNodes = []; this._text = String(v); }
  get classList() {
    const self = this;
    return {
      contains(c) { return (self.attrs.class || "").split(/\s+/).includes(c); },
      add(c) {
        if (!this.contains(c)) {
          self.attrs.class = ((self.attrs.class || "") + " " + c).trim();
        }
      },
      remove(c) {
        self.attrs.class = (self.attrs.class || "")
          .split(/\s+/).filter((x) => x && x !== c).join(" ");
      },
    };
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
  }
  _fire(type, event) {
    for (const fn of this._listeners[type] || []) fn(event || { target: this });
  }
  querySelector(sel) {
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 1) {
          if (matchesSelector(c, sel)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(this);
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 1) {
          if (matchesSelector(c, sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
}

function textNode(s) {
  return { nodeType: 3, parentNode: null, childNodes: [], textContent: String(s) };
}

function makeDocument() {
  const body = new El("body");
  const doc = {
    nodeType: 9,
    body,
    createElement(tag) { return new El(tag); },
    // v8 (proof-library sim): namespace-tagged plain El — the extracted
    // pfSvg only composes structure/attributes, never renders.
    createElementNS(ns, tag) {
      const el = new El(tag);
      el._ns = String(ns);
      return el;
    },
    // v8 (proof-library sim): static page language for pfPageLocale.
    documentElement: { lang: "en" },
    createTextNode(s) { return textNode(s); },
    getElementById(id) {
      const walk = (node) => {
        for (const c of node.childNodes) {
          if (c.nodeType === 1) {
            if (c.attrs.id === id) return c;
            const hit = walk(c);
            if (hit) return hit;
          }
        }
        return null;
      };
      return walk(body);
    },
    querySelector(sel) { return body.querySelector(sel); },
    querySelectorAll(sel) { return body.querySelectorAll(sel); },
  };
  return doc;
}

module.exports = { El, textNode, makeDocument, matchesSelector };
