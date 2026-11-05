import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/yaml/dist/nodes/identity.js"(exports) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias4 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap4 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair3 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar6 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq4 = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar6(node) || isCollection(node)) && !!node.anchor;
    exports.ALIAS = ALIAS;
    exports.DOC = DOC;
    exports.MAP = MAP;
    exports.NODE_TYPE = NODE_TYPE;
    exports.PAIR = PAIR;
    exports.SCALAR = SCALAR;
    exports.SEQ = SEQ;
    exports.hasAnchor = hasAnchor;
    exports.isAlias = isAlias4;
    exports.isCollection = isCollection;
    exports.isDocument = isDocument;
    exports.isMap = isMap4;
    exports.isNode = isNode;
    exports.isPair = isPair3;
    exports.isScalar = isScalar6;
    exports.isSeq = isSeq4;
  }
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/yaml/dist/visit.js"(exports) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit2(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit2.BREAK = BREAK;
    visit2.SKIP = SKIP;
    visit2.REMOVE = REMOVE;
    function visit_(key, node, visitor, path) {
      const ctrl = callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visit_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = visit_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path) {
      const ctrl = await callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visitAsync_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path) {
      if (typeof visitor === "function")
        return visitor(key, node, path);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path);
      return void 0;
    }
    function replaceNode(key, path, node) {
      const parent = path[path.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports.visit = visit2;
    exports.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit2 = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit2.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports.Directives = Directives;
  }
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/yaml/dist/doc/anchors.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit2 = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit2.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports.anchorIsValid = anchorIsValid;
    exports.anchorNames = anchorNames;
    exports.createNodeAnchors = createNodeAnchors;
    exports.findNewAnchor = findNewAnchor;
  }
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/yaml/dist/doc/applyReviver.js"(exports) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports.applyReviver = applyReviver;
  }
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/yaml/dist/nodes/toJS.js"(exports) {
    "use strict";
    var identity = require_identity();
    function toJS2(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS2(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports.toJS = toJS2;
  }
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/yaml/dist/nodes/Node.js"(exports) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS2 = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS2.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports.NodeBase = NodeBase;
  }
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/yaml/dist/nodes/Alias.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var visit2 = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS2 = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit2.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        if (found && ctx) {
          const { anchors: anchors2, doc: doc2, maxAliasCount } = ctx;
          let data = anchors2.get(found);
          if (!data) {
            toJS2.toJS(found, null, ctx);
            data = anchors2.get(found);
          }
          if (data?.res === void 0) {
            const msg = "This should not happen: Alias anchor was not resolved?";
            throw new ReferenceError(msg);
          }
          if (maxAliasCount >= 0) {
            data.count += 1;
            if (data.aliasCount === 0)
              data.aliasCount = getAliasCount(doc2, found, anchors2);
            if (data.count * data.aliasCount > maxAliasCount) {
              const msg = "Excessive alias count indicates a resource exhaustion attack";
              throw new ReferenceError(msg);
            }
          }
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const source = this.resolve(ctx.doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        return ctx.anchors.get(source).res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports.Alias = Alias;
  }
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/yaml/dist/nodes/Scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS2 = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar4 = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS2.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar4.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar4.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar4.PLAIN = "PLAIN";
    Scalar4.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar4.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports.Scalar = Scalar4;
    exports.isScalarValue = isScalarValue;
  }
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/yaml/dist/doc/createNode.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar4 = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match2 = tags.filter((t) => t.tag === tagName);
        const tagObj = match2.find((t) => !t.format) ?? match2[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar4.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar4.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports.createNode = createNode;
  }
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/yaml/dist/nodes/Collection.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path, value) {
      let v = value;
      for (let i = path.length - 1; i >= 0; --i) {
        const k = path[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path, value) {
        if (isEmptyPath(path))
          this.add(value);
        else {
          const [key, ...rest] = path;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        const [key, ...rest] = path;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports.Collection = Collection;
    exports.collectionFromPath = collectionFromPath;
    exports.isEmptyPath = isEmptyPath;
  }
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyComment.js"(exports) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
    exports.indentComment = indentComment;
    exports.lineComment = lineComment;
    exports.stringifyComment = stringifyComment;
  }
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/yaml/dist/stringify/foldFlowLines.js"(exports) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text[start];
        }
      }
      return end;
    }
    exports.FOLD_BLOCK = FOLD_BLOCK;
    exports.FOLD_FLOW = FOLD_FLOW;
    exports.FOLD_QUOTED = FOLD_QUOTED;
    exports.foldFlowLines = foldFlowLines;
  }
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyString.js"(exports) {
    "use strict";
    var Scalar4 = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json2 = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json2;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json2[i]; ch; ch = json2[++i]) {
        if (ch === " " && json2[i + 1] === "\\" && json2[i + 2] === "n") {
          str += json2.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json2[i + 1]) {
            case "u":
              {
                str += json2.slice(start, i);
                const code2 = json2.substr(i + 2, 4);
                switch (code2) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code2.substr(0, 2) === "00")
                      str += "\\x" + code2.substr(2);
                    else
                      str += json2.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json2[i + 2] === '"' || json2.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json2.slice(start, i) + "\n\n";
                while (json2[i + 2] === "\\" && json2[i + 3] === "n" && json2[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json2[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json2.slice(start) : json2;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar4.Scalar.BLOCK_FOLDED ? false : type === Scalar4.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar4.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar4.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar4.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar4.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar4.Scalar.BLOCK_FOLDED:
          case Scalar4.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar4.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar4.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar4.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports.stringifyString = stringifyString;
  }
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/yaml/dist/stringify/stringify.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match2 = tags.filter((t) => t.tag === item.tag);
        if (match2.length > 0)
          return match2.find((t) => t.format === item.format) ?? match2[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match2 = tags.filter((t) => t.identify?.(obj));
        if (match2.length > 1) {
          const testMatch = match2.filter((t) => t.test);
          if (testMatch.length > 0)
            match2 = testMatch;
        }
        tagObj = match2.find((t) => t.format === item.format) ?? match2.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify3(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports.createStringifyContext = createStringifyContext;
    exports.stringify = stringify3;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar4 = require_Scalar();
    var stringify3 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar4.Scalar.BLOCK_FOLDED || key.type === Scalar4.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify3.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify3.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports.stringifyPair = stringifyPair;
  }
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/yaml/dist/log.js"(exports) {
    "use strict";
    var node_process = __require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports.debug = debug;
    exports.warn = warn;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar4 = require_Scalar();
    var MERGE_KEY = "<<";
    var merge3 = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar4.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey2 = (ctx, key) => (merge3.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar4.Scalar.PLAIN) && merge3.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge3.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports.addMergeToJSMap = addMergeToJSMap;
    exports.isMergeKey = isMergeKey2;
    exports.merge = merge3;
  }
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports) {
    "use strict";
    var log = require_log();
    var merge3 = require_merge();
    var stringify3 = require_stringify();
    var identity = require_identity();
    var toJS2 = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge3.isMergeKey(ctx, key))
        merge3.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS2.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS2.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS2.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify3.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/yaml/dist/nodes/Pair.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports.Pair = Pair;
    exports.createPair = createPair;
  }
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyCollection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify3 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify4 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify4(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items: items2 }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items2.length; ++i) {
        const item = items2[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify3.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items: items2 }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items2.length; ++i) {
        const item = items2[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify3.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items2.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports.stringifyCollection = stringifyCollection;
  }
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLMap.js"(exports) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar4 = require_Scalar();
    function findPair(items2, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items2) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar4.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports.YAMLMap = YAMLMap;
    exports.findPair = findPair;
  }
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/yaml/dist/schema/common/map.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports.map = map;
  }
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLSeq.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar4 = require_Scalar();
    var toJS2 = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar4.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS2.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports.YAMLSeq = YAMLSeq;
  }
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/yaml/dist/schema/common/seq.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports.seq = seq;
  }
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/yaml/dist/schema/common/string.js"(exports) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports.string = string;
  }
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/yaml/dist/schema/common/null.js"(exports) {
    "use strict";
    var Scalar4 = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar4.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar4.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports.nullTag = nullTag;
  }
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/yaml/dist/schema/core/bool.js"(exports) {
    "use strict";
    var Scalar4 = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar4.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports.boolTag = boolTag;
  }
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyNumber.js"(exports) {
    "use strict";
    function stringifyNumber({ format: format3, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num2 = typeof value === "number" ? value : Number(value);
      if (!isFinite(num2))
        return isNaN(num2) ? ".nan" : num2 < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format3 && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports.stringifyNumber = stringifyNumber;
  }
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/yaml/dist/schema/core/float.js"(exports) {
    "use strict";
    var Scalar4 = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num2 = Number(node.value);
        return isFinite(num2) ? num2.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar4.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/yaml/dist/schema/core/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/yaml/dist/schema/core/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/yaml/dist/schema/json/schema.js"(exports) {
    "use strict";
    var Scalar4 = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar4.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports) {
    "use strict";
    var node_buffer = __require("buffer");
    var Scalar4 = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar4.Scalar.BLOCK_LITERAL);
        if (type !== Scalar4.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar4.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports.binary = binary;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar4 = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar4.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports.createPairs = createPairs;
    exports.pairs = pairs;
    exports.resolvePairs = resolvePairs;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports) {
    "use strict";
    var identity = require_identity();
    var toJS2 = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS2.toJS(pair.key, "", ctx);
            value = toJS2.toJS(pair.value, key, ctx);
          } else {
            key = toJS2.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports.YAMLOMap = YAMLOMap;
    exports.omap = omap;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports) {
    "use strict";
    var Scalar4 = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar4.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar4.Scalar(false),
      stringify: boolStringify
    };
    exports.falseTag = falseTag;
    exports.trueTag = trueTag;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports) {
    "use strict";
    var Scalar4 = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num2 = Number(node.value);
        return isFinite(num2) ? num2.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar4.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intBin = intBin;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports.YAMLSet = YAMLSet;
    exports.set = set;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num2 = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num2(60) + num2(p), num2(0));
      return sign === "-" ? num2(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num2 = (n) => n;
      if (typeof value === "bigint")
        num2 = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num2(-1);
      }
      const _60 = num2(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match2 = str.match(timestamp.test);
        if (!match2)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match2.map(Number);
        const millisec = match2[7] ? Number((match2[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match2[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports.floatTime = floatTime;
    exports.intTime = intTime;
    exports.timestamp = timestamp;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge3 = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge3.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/yaml/dist/schema/tags.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge3 = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge3.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge3.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge3.merge) ? schemaTags.concat(merge3.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge3.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports.coreKnownTags = coreKnownTags;
    exports.getTags = getTags;
  }
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/yaml/dist/schema/Schema.js"(exports) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge: merge3, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge3);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports.Schema = Schema;
  }
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyDocument.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify3 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify3.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify3.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify3.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports.stringifyDocument = stringifyDocument;
  }
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/yaml/dist/doc/Document.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS2 = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        if (Collection.isEmptyPath(path)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        if (Collection.isEmptyPath(path))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path) {
        if (Collection.isEmptyPath(path))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        if (Collection.isEmptyPath(path)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json: json2, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json2,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS2.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports.Document = Document;
  }
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/yaml/dist/errors.js"(exports) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code2, message) {
        super();
        this.name = name;
        this.code = code2;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code2, message) {
        super("YAMLParseError", pos, code2, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code2, message) {
        super("YAMLWarning", pos, code2, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports.YAMLError = YAMLError;
    exports.YAMLParseError = YAMLParseError;
    exports.YAMLWarning = YAMLWarning;
    exports.prettifyError = prettifyError;
  }
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/yaml/dist/compose/resolve-props.js"(exports) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token of tokens) {
        if (reqSpace) {
          if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
            onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token.type !== "comment" && token.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
              tab = token;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token.source.endsWith(":"))
              onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
            if (found)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports.resolveProps = resolveProps;
  }
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/yaml/dist/compose/util-contains-newline.js"(exports) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports.containsNewline = containsNewline;
  }
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/yaml/dist/compose/util-map-includes.js"(exports) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items2, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items2.some((pair) => isEqual(pair.key, search));
    }
    exports.mapIncludes = mapIncludes;
  }
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-map.js"(exports) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep: sep3, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep3?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep3) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep3 ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep3, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-seq.js"(exports) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/yaml/dist/compose/resolve-end.js"(exports) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep3 = "";
        for (const token of end) {
          const { source, type } = token;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep3 + cb;
              sep3 = "";
              break;
            }
            case "newline":
              if (comment)
                sep3 += source;
              hasSpace = true;
              break;
            default:
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports.resolveEnd = resolveEnd;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap4 = fc.start.source === "{";
      const fcName = isMap4 ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap4 ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep: sep3, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep3?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep3 && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap4 && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap4 && !sep3 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep3, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep3 ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap4 && !props.found && ctx.options.strict) {
              if (sep3)
                for (const st of sep3) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep3, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap4) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap4 ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/yaml/dist/compose/compose-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar4 = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token, onError, tagName, tag) {
      const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar4.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports.composeCollection = composeCollection;
  }
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports) {
    "use strict";
    var Scalar4 = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar4.Scalar.BLOCK_FOLDED : Scalar4.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep3 = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar4.Scalar.BLOCK_LITERAL) {
          value += sep3 + indent.slice(trimIndent) + content;
          sep3 = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep3 === " ")
            sep3 = "\n";
          else if (!prevMoreIndented && sep3 === "\n")
            sep3 = "\n\n";
          value += sep3 + indent.slice(trimIndent) + content;
          sep3 = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep3 === "\n")
            value += "\n";
          else
            sep3 = "\n";
        } else {
          value += sep3 + content;
          sep3 = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token = props[i];
        switch (token.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message);
            }
            length += token.source.length;
            comment = token.source.substring(1);
            break;
          case "error":
            onError(token, "UNEXPECTED_TOKEN", token.message);
            length += token.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports) {
    "use strict";
    var Scalar4 = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code2, msg) => onError(offset + rel, code2, msg);
      switch (type) {
        case "scalar":
          _type = Scalar4.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar4.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar4.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return unfoldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return unfoldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function unfoldLines(source) {
      const line = /(.*?)\r?\n/sy;
      let match2 = line.exec(source);
      if (!match2)
        return source;
      let trimEnd, trimBoth;
      try {
        trimEnd = new RegExp("(?<![ 	])[ 	]+$");
        trimBoth = new RegExp("^[ 	]+|(?<![ 	])[ 	]+$", "g");
      } catch {
        trimEnd = /[ \t]+$/;
        trimBoth = /^[ \t]+|[ \t]+$/g;
      }
      let res = match2[1].replace(trimEnd, "");
      let sep3 = " ";
      let pos = line.lastIndex;
      while (match2 = line.exec(source)) {
        const lm = match2[1].replace(trimBoth, "");
        if (lm === "") {
          if (sep3 === "\n")
            res += sep3;
          else
            sep3 = "\n";
        } else {
          res += sep3 + lm;
          sep3 = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match2 = last.exec(source);
      return res + sep3 + (match2?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code2 = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code2);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/yaml/dist/compose/compose-scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar4 = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token, tagToken, onError) {
      const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar4.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar4.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports.composeScalar = composeScalar;
  }
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/yaml/dist/compose/compose-node.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node = composeAlias(ctx, token, onError);
          if (anchor || tag)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports.composeEmptyNode = composeEmptyNode;
    exports.composeNode = composeNode;
  }
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/yaml/dist/compose/compose-doc.js"(exports) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports.composeDoc = composeDoc;
  }
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/yaml/dist/compose/composer.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code2, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code2, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code2, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token of tokens)
          yield* this.next(token);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token) {
        if (node_process.env.LOG_STREAM)
          console.dir(token, { depth: null });
        switch (token.type) {
          case "directive":
            this.directives.add(token.source, (offset, message, warning) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token.source);
            break;
          case "error": {
            const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
            const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports.Composer = Composer;
  }
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/yaml/dist/parse/cst-scalar.js"(exports) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token, strict = true, onError) {
      if (token) {
        const _onError = (pos, code2, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code2, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code2, message);
        };
        switch (token.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token, source);
          break;
        case '"':
          setFlowScalarValue(token, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token, source, "scalar");
      }
    }
    function setBlockScalarValue(token, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token.source = body;
      } else {
        const { offset } = token;
        const indent = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token, source, type) {
      switch (token.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token.type = type;
          token.source = source;
          break;
        case "block-scalar": {
          const end = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token.offset + source.length;
          const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
          delete token.items;
          Object.assign(token, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token ? token.indent : -1;
          const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent, source, end });
        }
      }
    }
    exports.createScalarToken = createScalarToken;
    exports.resolveAsScalar = resolveAsScalar;
    exports.setScalarValue = setScalarValue;
  }
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/yaml/dist/parse/cst-stringify.js"(exports) {
    "use strict";
    var stringify3 = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token) {
      switch (token.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token.props)
            res += stringifyToken(tok);
          return res + token.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token.start.source;
          for (const item of token.items)
            res += stringifyItem(item);
          for (const st of token.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token);
          if (token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token.source;
          if ("end" in token && token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep: sep3, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep3)
        for (const st of sep3)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports.stringify = stringify3;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit2(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit2.BREAK = BREAK;
    visit2.SKIP = SKIP;
    visit2.REMOVE = REMOVE;
    visit2.itemAtPath = (cst, path) => {
      let item = cst;
      for (const [field2, index] of path) {
        const tok = item?.[field2];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit2.parentCollection = (cst, path) => {
      const parent = visit2.itemAtPath(cst, path.slice(0, -1));
      const field2 = path[path.length - 1][0];
      const coll = parent?.[field2];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path, item, visitor) {
      let ctrl = visitor(item, path);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field2 of ["key", "value"]) {
        const token = item[field2];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci = _visit(Object.freeze(path.concat([[field2, i]])), token.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field2 === "key")
            ctrl = ctrl(item, path);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
    }
    exports.visit = visit2;
  }
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/yaml/dist/parse/cst.js"(exports) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token) => !!token && "items" in token;
    var isScalar6 = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
    function prettyToken(token) {
      switch (token) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports.createScalarToken = cstScalar.createScalarToken;
    exports.resolveAsScalar = cstScalar.resolveAsScalar;
    exports.setScalarValue = cstScalar.setScalarValue;
    exports.stringify = cstStringify.stringify;
    exports.visit = cstVisit.visit;
    exports.BOM = BOM;
    exports.DOCUMENT = DOCUMENT;
    exports.FLOW_END = FLOW_END;
    exports.SCALAR = SCALAR;
    exports.isCollection = isCollection;
    exports.isScalar = isScalar6;
    exports.prettyToken = prettyToken;
    exports.tokenType = tokenType;
  }
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/yaml/dist/parse/lexer.js"(exports) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote2 = this.charAt(0);
        let end = this.buffer.indexOf(quote2, this.pos + 1);
        if (quote2 === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports.Lexer = Lexer;
  }
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/yaml/dist/parse/line-counter.js"(exports) {
    "use strict";
    var LineCounter2 = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports.LineCounter = LineCounter2;
  }
});

// node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "node_modules/yaml/dist/parse/parser.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list3, type) {
      for (let i = 0; i < list3.length; ++i)
        if (list3[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list3) {
      for (let i = 0; i < list3.length; ++i) {
        switch (list3[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token) {
      switch (token?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token = error ?? this.stack.pop();
        if (!token) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token;
        } else {
          const top = this.peek(1);
          if (token.type === "block-scalar") {
            token.indent = "indent" in top ? top.indent : 0;
          } else if (token.type === "flow-collection" && top.type === "document") {
            token.indent = 0;
          }
          if (token.type === "flow-collection")
            fixFlowSeqItems(token);
          switch (top.type) {
            case "document":
              top.value = token;
              break;
            case "block-scalar":
              top.props.push(token);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token;
              } else {
                Object.assign(it, { key: token, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token });
              else
                it.value = token;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token, sep: [] });
              else if (it.sep)
                it.value = token;
              else
                Object.assign(it, { key: token, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
            const last = token.items[token.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep3;
          if (scalar.end) {
            sep3 = scalar.end;
            sep3.push(this.sourceToken);
            delete scalar.end;
          } else
            sep3 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep: sep3 }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep3 = it.sep;
                  sep3.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep: sep3 }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep3 = fc.end.splice(1, fc.end.length);
            sep3.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep: sep3 }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token.end)
              token.end.push(this.sourceToken);
            else
              token.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports.Parser = Parser;
  }
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/yaml/dist/public-api.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument2(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse9(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument2(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify3(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports.parse = parse9;
    exports.parseAllDocuments = parseAllDocuments;
    exports.parseDocument = parseDocument2;
    exports.stringify = stringify3;
  }
});

// node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/yaml/dist/index.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar4 = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit2 = require_visit();
    exports.Composer = composer.Composer;
    exports.Document = Document.Document;
    exports.Schema = Schema.Schema;
    exports.YAMLError = errors.YAMLError;
    exports.YAMLParseError = errors.YAMLParseError;
    exports.YAMLWarning = errors.YAMLWarning;
    exports.Alias = Alias.Alias;
    exports.isAlias = identity.isAlias;
    exports.isCollection = identity.isCollection;
    exports.isDocument = identity.isDocument;
    exports.isMap = identity.isMap;
    exports.isNode = identity.isNode;
    exports.isPair = identity.isPair;
    exports.isScalar = identity.isScalar;
    exports.isSeq = identity.isSeq;
    exports.Pair = Pair.Pair;
    exports.Scalar = Scalar4.Scalar;
    exports.YAMLMap = YAMLMap.YAMLMap;
    exports.YAMLSeq = YAMLSeq.YAMLSeq;
    exports.CST = cst;
    exports.Lexer = lexer.Lexer;
    exports.LineCounter = lineCounter.LineCounter;
    exports.Parser = parser.Parser;
    exports.parse = publicApi.parse;
    exports.parseAllDocuments = publicApi.parseAllDocuments;
    exports.parseDocument = publicApi.parseDocument;
    exports.stringify = publicApi.stringify;
    exports.visit = visit2.visit;
    exports.visitAsync = visit2.visitAsync;
  }
});

// src/action.ts
import { appendFile as appendFile3 } from "node:fs/promises";

// src/cli/action.ts
import { isAbsolute as isAbsolute2, resolve as resolve2 } from "node:path";

// src/cli/io.ts
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

// src/github/rest.ts
var RequestError = class extends Error {
  constructor(message, status, response) {
    super(message);
    this.status = status;
    this.response = response;
    this.name = "RequestError";
  }
  status;
  response;
};
function restClient(options = {}) {
  const baseUrl = (options.baseUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  return {
    async request(route, parameters = {}) {
      const [method = "GET", template = "/"] = route.split(" ");
      const remaining = { ...parameters };
      const path = template.replace(/\{([^}]+)\}/g, (_, name) => {
        const value = remaining[name];
        delete remaining[name];
        if (value === void 0) throw new Error(`Missing route parameter "${name}" for ${route}`);
        return name === "ref" || name === "path" || name === "basehead" ? String(value).split("/").map(encodeURIComponent).join("/") : encodeURIComponent(String(value));
      });
      const url = new URL(path.startsWith("/graphql") && baseUrl.endsWith("/api/v3") ? `${baseUrl.replace(/\/v3$/, "")}/graphql` : `${baseUrl}${path}`);
      const hasBody = !["GET", "HEAD", "DELETE"].includes(method);
      if (!hasBody) {
        for (const [key, value] of Object.entries(remaining)) {
          if (value !== void 0) url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
        }
      }
      const headers = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": options.userAgent ?? "ci-cd-optimizer"
      };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      if (hasBody) headers["content-type"] = "application/json";
      const response = await doFetch(url, { method, headers, ...hasBody ? { body: JSON.stringify(remaining) } : {} });
      const text = await response.text();
      let data = text;
      try {
        data = text ? JSON.parse(text) : void 0;
      } catch {
      }
      if (!response.ok) {
        const message = data?.message ?? response.statusText;
        throw new RequestError(`${method} ${path} \u2192 ${response.status}: ${message}`, response.status, data);
      }
      return { status: response.status, data };
    }
  };
}
function parseRepo(value) {
  const match2 = /^([^/\s]+)\/([^/\s]+)$/.exec(value ?? "");
  if (!match2) throw new Error(`Expected a repository as owner/name (got "${value ?? ""}"). Pass --repo or set GITHUB_REPOSITORY.`);
  return { owner: match2[1], repo: match2[2] };
}

// src/cli/io.ts
var UsageError = class extends Error {
  name = "UsageError";
};
function githubClient(io) {
  if (io.github) return io.github();
  const token = io.env.GITHUB_TOKEN ?? io.env.GH_TOKEN;
  return restClient({ ...token ? { token } : {}, ...io.env.GITHUB_API_URL ? { baseUrl: io.env.GITHUB_API_URL } : {} });
}
function copilotClient(io) {
  const token = io.env.COPILOT_ASSIGN_TOKEN;
  if (!token) return void 0;
  return githubClient({ ...io, env: { ...io.env, GITHUB_TOKEN: token, GH_TOKEN: token } });
}
function repoFrom(value, io) {
  try {
    return parseRepo(value ?? io.env.GITHUB_REPOSITORY);
  } catch (error) {
    throw new UsageError(error.message);
  }
}
var resolvePath = (io, path) => isAbsolute(path) ? path : resolve(io.cwd, path);
async function writeText(io, path, text) {
  if (!path || path === "-") {
    io.stdout(text);
    return;
  }
  const target = resolvePath(io, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text.endsWith("\n") ? text : `${text}
`, "utf8");
}
var MAX_OUTPUT = 64 * 1024;
var shellExec = (command, options) => new Promise((resolveResult) => {
  const child = spawn(command, { cwd: options.cwd, shell: true, env: { ...process.env, CI: "true" } });
  let output2 = "";
  const append = (chunk2) => {
    output2 = (output2 + chunk2.toString("utf8")).slice(-MAX_OUTPUT);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => resolveResult({ code: 127, output: `${output2}${error.message}` }));
  child.on("close", (code2) => resolveResult({ code: code2 ?? 1, output: output2 }));
});

// src/cli/action.ts
function splitArgs(input2) {
  const args = [];
  let current = "";
  let inArg = false;
  let quote2;
  for (let i = 0; i < input2.length; i++) {
    const ch = input2[i];
    if (quote2 === "'") {
      if (ch === "'") quote2 = void 0;
      else current += ch;
    } else if (quote2 === '"') {
      if (ch === '"') quote2 = void 0;
      else if (ch === "\\" && (input2[i + 1] === '"' || input2[i + 1] === "\\")) current += input2[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote2 = ch;
      inArg = true;
    } else if (/\s/.test(ch)) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
    } else {
      current += ch;
      inArg = true;
    }
  }
  if (quote2) throw new UsageError(`Unterminated ${quote2} quote in args input.`);
  if (inArg) args.push(current);
  return args;
}
var input = (env, name) => (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
function actionInvocation(argv, env, processCwd) {
  if (argv.length > 0) return { argv, cwd: processCwd, env };
  const workspace = env.GITHUB_WORKSPACE || processCwd;
  const dir = input(env, "working-directory");
  const token = input(env, "token");
  return {
    argv: [input(env, "command") || "lint", ...splitArgs(env.INPUT_ARGS ?? "")],
    cwd: dir ? isAbsolute2(dir) ? dir : resolve2(workspace, dir) : workspace,
    env: token ? { ...env, GITHUB_TOKEN: token } : env
  };
}

// src/cli/index.ts
import { parseArgs as parseArgs6 } from "node:util";

// src/lint/parsers/workflow.ts
var import_yaml2 = __toESM(require_dist(), 1);

// src/lint/parsers/yaml.ts
var import_yaml = __toESM(require_dist(), 1);
var MAX_ALIAS_DEPTH = 16;
function parseYaml(path, content) {
  const lineCounter = new import_yaml.LineCounter();
  const doc = (0, import_yaml.parseDocument)(content, {
    lineCounter,
    merge: true,
    uniqueKeys: false,
    prettyErrors: true,
    strict: false
  });
  const blockScalarLines = [];
  (0, import_yaml.visit)(doc, {
    Scalar(_key, node) {
      if ((node.type === import_yaml.Scalar.BLOCK_LITERAL || node.type === import_yaml.Scalar.BLOCK_FOLDED) && node.range) {
        const start = lineCounter.linePos(node.range[0]).line;
        const end = lineCounter.linePos(Math.max(node.range[0], node.range[1] - 1)).line;
        blockScalarLines.push([start, end]);
      }
    }
  });
  return { path, doc, lineCounter, blockScalarLines };
}
function lineOfNode(source, node) {
  if (!node?.range) return 1;
  return source.lineCounter.linePos(node.range[0]).line;
}
function resolveNode(source, node) {
  let current = node;
  let viaAlias = false;
  for (let depth = 0; depth < MAX_ALIAS_DEPTH && (0, import_yaml.isAlias)(current); depth += 1) {
    viaAlias = true;
    current = current.resolve(source.doc) ?? null;
  }
  if ((0, import_yaml.isAlias)(current)) return { node: null, viaAlias };
  return { node: current ?? null, viaAlias };
}
function isMergeKey(key) {
  if ((0, import_yaml.isScalar)(key)) return key.value === "<<" || key.source === "<<";
  return key === "<<";
}
function keyName(key) {
  if ((0, import_yaml.isScalar)(key)) {
    const value = key.value;
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : void 0;
  }
  return typeof key === "string" ? key : void 0;
}
function entries(source, node) {
  const { node: mapNode } = resolveNode(source, node);
  if (!(0, import_yaml.isMap)(mapNode)) return [];
  const direct = [];
  const merged = [];
  for (const pair of mapNode.items) {
    if (!(0, import_yaml.isPair)(pair)) continue;
    if (isMergeKey(pair.key)) {
      const sources = (0, import_yaml.isSeq)(pair.value) ? pair.value.items : [pair.value];
      for (const item of sources) {
        for (const field2 of entries(source, item)) {
          merged.push({ ...field2, origin: "merge" });
        }
      }
      continue;
    }
    const name = keyName(pair.key);
    if (name === void 0) continue;
    const resolved = resolveNode(source, pair.value);
    direct.push({
      key: name,
      value: resolved.node,
      line: lineOfNode(source, pair.key),
      origin: resolved.viaAlias ? "alias" : "direct"
    });
  }
  const seen = new Set(direct.map((field2) => field2.key));
  for (const field2 of merged) {
    if (!seen.has(field2.key)) {
      seen.add(field2.key);
      direct.push(field2);
    }
  }
  return direct;
}
function field(source, node, key) {
  return entries(source, node).find((entry) => entry.key === key);
}
function items(source, node) {
  const { node: seqNode } = resolveNode(source, node);
  if (!(0, import_yaml.isSeq)(seqNode)) return [];
  return seqNode.items.map((item) => resolveNode(source, item).node).filter((item) => item !== null);
}
function scalarValue(node) {
  if (!(0, import_yaml.isScalar)(node)) return void 0;
  const value = node.value;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}
function stringValue(node) {
  const value = scalarValue(node);
  if (value === void 0 || value === null) return void 0;
  return String(value);
}
function toJS(source, node) {
  if (!node) return void 0;
  return node.toJS(source.doc, { maxAliasCount: 100 });
}
function classify(value) {
  if (typeof value !== "string") return "literal";
  const trimmed = value.trim();
  if (/^\$\{\{[\s\S]*\}\}$/.test(trimmed) && trimmed.indexOf("${{", 3) === -1) return "expression";
  return trimmed.includes("${{") ? "interpolated" : "literal";
}
function parseErrors(source) {
  return source.doc.errors.map((error) => ({
    line: error.linePos?.[0]?.line ?? 1,
    message: error.message.split("\n")[0] ?? error.message
  }));
}

// src/lint/parsers/workflow.ts
var SHA_PATTERN = /^[0-9a-f]{40}$/i;
function parseActionRef(raw) {
  const value = raw.trim();
  if (value.includes("${{")) return { raw: value, kind: "expression", shaPinned: false };
  if (value.startsWith("./") || value.startsWith("../")) {
    return { raw: value, kind: "local", shaPinned: true };
  }
  if (value.startsWith("docker://")) {
    return { raw: value, kind: "docker", shaPinned: /@sha256:[0-9a-f]{64}$/i.test(value) };
  }
  const at = value.lastIndexOf("@");
  const path = at >= 0 ? value.slice(0, at) : value;
  const ref = at >= 0 ? value.slice(at + 1) : void 0;
  const [owner, repo] = path.split("/");
  return {
    raw: value,
    kind: "remote",
    ...owner ? { owner: owner.toLowerCase() } : {},
    ...repo ? { repo: repo.toLowerCase() } : {},
    name: path.toLowerCase(),
    ...ref !== void 0 ? { ref } : {},
    shaPinned: ref !== void 0 && SHA_PATTERN.test(ref)
  };
}
function sourced(source, entry) {
  if (!entry) return void 0;
  const value = toJS(source, entry.value);
  return { value, kind: classify(value), line: entry.line, origin: entry.origin };
}
function sourcedString(source, entry) {
  const result = sourced(source, entry);
  if (!result || result.value === void 0 || result.value === null) return void 0;
  return { ...result, value: String(result.value) };
}
function stringList(source, node) {
  if (!node) return void 0;
  const value = toJS(source, node);
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  return void 0;
}
function record(source, node) {
  const value = toJS(source, node);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function parseSteps(source, stepsNode, keyPrefix) {
  return items(source, stepsNode).map((stepNode, index) => {
    const usesField = field(source, stepNode, "uses");
    const runField = field(source, stepNode, "run");
    const withField = field(source, stepNode, "with");
    const withMap = /* @__PURE__ */ new Map();
    for (const entry of entries(source, withField?.value)) {
      const value = sourced(source, entry);
      if (value) withMap.set(entry.key, value);
    }
    const uses = sourcedString(source, usesField);
    const run3 = sourcedString(source, runField);
    const runNode = runField?.value;
    const isBlock = (0, import_yaml2.isScalar)(runNode) && (runNode.type === import_yaml2.Scalar.BLOCK_LITERAL || runNode.type === import_yaml2.Scalar.BLOCK_FOLDED);
    const contentLine = runNode ? lineOfNode(source, runNode) + (isBlock ? 1 : 0) : 0;
    const id = stringValue(field(source, stepNode, "id")?.value);
    const name = stringValue(field(source, stepNode, "name")?.value);
    const workingDirectory = stringValue(field(source, stepNode, "working-directory")?.value);
    const condition = stringValue(field(source, stepNode, "if")?.value);
    return {
      index,
      line: lineOfNode(source, stepNode),
      key: `${keyPrefix}.steps[${index}]`,
      ...id !== void 0 ? { id } : {},
      ...name !== void 0 ? { name } : {},
      ...uses ? { uses: { ...uses, action: parseActionRef(uses.value) } } : {},
      with: withMap,
      ...run3 ? { run: { ...run3, contentLine } } : {},
      ...workingDirectory !== void 0 ? { workingDirectory } : {},
      ...condition !== void 0 ? { if: condition } : {},
      env: record(source, field(source, stepNode, "env")?.value)
    };
  });
}
function defaultsWorkingDirectory(source, node) {
  const run3 = field(source, field(source, node, "defaults")?.value, "run");
  return stringValue(field(source, run3?.value, "working-directory")?.value);
}
function parseTriggers(source, onField) {
  if (!onField) return [];
  const value = toJS(source, onField.value);
  if (typeof value === "string") return [{ event: value, line: onField.line }];
  if (Array.isArray(value)) return value.map((event) => ({ event: String(event), line: onField.line }));
  return entries(source, onField.value).map((entry) => {
    const paths = stringList(source, field(source, entry.value, "paths")?.value);
    const pathsIgnore = stringList(source, field(source, entry.value, "paths-ignore")?.value);
    const branches = stringList(source, field(source, entry.value, "branches")?.value);
    const types = stringList(source, field(source, entry.value, "types")?.value);
    return {
      event: entry.key,
      line: entry.line,
      ...paths ? { paths } : {},
      ...pathsIgnore ? { pathsIgnore } : {},
      ...branches ? { branches } : {},
      ...types ? { types } : {}
    };
  });
}
function parseJob(source, entry) {
  const node = entry.value;
  const key = `jobs.${entry.key}`;
  const needsValue = toJS(source, field(source, node, "needs")?.value);
  const needs = typeof needsValue === "string" ? [needsValue] : Array.isArray(needsValue) ? needsValue.map(String) : [];
  const containerField = field(source, node, "container");
  const containerImage = containerField && stringValue(containerField.value) !== void 0 ? sourcedString(source, containerField) : sourcedString(source, field(source, containerField?.value, "image"));
  const services = entries(source, field(source, node, "services")?.value).map((service) => {
    const image = sourcedString(source, field(source, service.value, "image"));
    return image ? { name: service.key, image } : void 0;
  }).filter((service) => service !== void 0);
  const strategy = field(source, node, "strategy");
  const matrix = toJS(source, field(source, strategy?.value, "matrix")?.value);
  const name = stringValue(field(source, node, "name")?.value);
  const condition = stringValue(field(source, node, "if")?.value);
  const workingDirectory = defaultsWorkingDirectory(source, node);
  const runsOn = sourced(source, field(source, node, "runs-on"));
  const timeoutMinutes = sourced(source, field(source, node, "timeout-minutes"));
  const uses = sourcedString(source, field(source, node, "uses"));
  const concurrency = sourced(source, field(source, node, "concurrency"));
  const environment = sourced(source, field(source, node, "environment"));
  return {
    id: entry.key,
    line: entry.line,
    key,
    ...name !== void 0 ? { name } : {},
    ...runsOn ? { runsOn } : {},
    needs,
    ...timeoutMinutes ? { timeoutMinutes } : {},
    ...uses ? { uses } : {},
    ...containerImage ? { containerImage } : {},
    services,
    ...concurrency ? { concurrency } : {},
    ...environment ? { environment } : {},
    ...condition !== void 0 ? { if: condition } : {},
    ...matrix && typeof matrix === "object" && !Array.isArray(matrix) ? { matrix } : typeof matrix === "string" ? { matrix: { __expression: matrix } } : {},
    steps: parseSteps(source, field(source, node, "steps")?.value, key),
    ...workingDirectory !== void 0 ? { workingDirectory } : {},
    env: record(source, field(source, node, "env")?.value)
  };
}
function isWorkflowPath(path) {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path);
}
function isActionPath(path) {
  return /(^|\/)action\.ya?ml$/i.test(path);
}
function parseWorkflow(path, content) {
  const source = parseYaml(path, content);
  const root = source.doc.contents;
  const name = stringValue(field(source, root, "name")?.value);
  if (isActionPath(path) && !isWorkflowPath(path)) {
    const runs = field(source, root, "runs");
    const using = stringValue(field(source, runs?.value, "using")?.value);
    const composite = using === "composite";
    const steps2 = composite ? parseSteps(source, field(source, runs?.value, "steps")?.value, "runs") : [];
    return {
      kind: composite ? "composite-action" : "action",
      path,
      source,
      ...name !== void 0 ? { name } : {},
      triggers: [],
      triggersLine: 1,
      env: {},
      jobs: composite ? [
        {
          id: "(composite)",
          line: runs?.line ?? 1,
          key: "runs",
          needs: [],
          services: [],
          steps: steps2,
          env: {}
        }
      ] : []
    };
  }
  const onField = field(source, root, "on");
  const concurrency = sourced(source, field(source, root, "concurrency"));
  const workingDirectory = defaultsWorkingDirectory(source, root);
  return {
    kind: "workflow",
    path,
    source,
    ...name !== void 0 ? { name } : {},
    triggers: parseTriggers(source, onField),
    triggersLine: onField?.line ?? 1,
    ...concurrency ? { concurrency } : {},
    ...workingDirectory !== void 0 ? { workingDirectory } : {},
    env: record(source, field(source, root, "env")?.value),
    jobs: entries(source, field(source, root, "jobs")?.value).map((entry) => parseJob(source, entry))
  };
}
function runLine(step, offset) {
  if (!step.run) return step.line;
  const before = step.run.value.slice(0, Math.max(0, offset));
  return step.run.contentLine + (before.match(/\n/g)?.length ?? 0);
}
function hasTrigger(workflow, ...events) {
  return workflow.triggers.some((trigger2) => events.includes(trigger2.event));
}
function trigger(workflow, event) {
  return workflow.triggers.find((candidate) => candidate.event === event);
}
function withString(step, key) {
  const value = step.with.get(key)?.value;
  return value === void 0 || value === null ? void 0 : String(value);
}

// src/lint/rules/helpers.ts
var import_yaml4 = __toESM(require_dist(), 1);

// src/lint/fix.ts
function lineStart(content, line) {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = content.indexOf("\n", offset);
    if (next < 0) return content.length;
    offset = next + 1;
  }
  return offset;
}
function lineText(content, line) {
  const start = lineStart(content, line);
  const end = content.indexOf("\n", start);
  return content.slice(start, end < 0 ? content.length : end).replace(/\r$/, "");
}
function indentOf(content, line) {
  return /^\s*/.exec(lineText(content, line))?.[0] ?? "";
}
function newline(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}
function replaceOnLine(file, line, search, replacement) {
  const start = lineStart(file.content, line);
  const text = lineText(file.content, line);
  const match2 = typeof search === "string" ? { index: text.indexOf(search), 0: search } : search.exec(text);
  if (!match2 || match2.index < 0) return void 0;
  return { path: file.path, start: start + match2.index, end: start + match2.index + match2[0].length, text: replacement };
}
function insertLinesAfter(file, line, lines) {
  const eol = newline(file.content);
  if (line <= 0) return { path: file.path, start: 0, end: 0, text: lines.map((entry) => entry + eol).join("") };
  const start = lineStart(file.content, line + 1);
  const atEnd = start >= file.content.length && !file.content.endsWith("\n");
  const text = (atEnd ? eol : "") + lines.map((entry) => entry + eol).join("");
  return { path: file.path, start, end: start, text };
}
function fix(description, ...edits) {
  const defined = edits.filter((edit) => edit !== void 0);
  return defined.length === edits.length && defined.length > 0 ? { description, edits: defined } : void 0;
}
function applyFixes(files, diagnostics) {
  const contents = new Map(files.map((file) => [file.path, file.content]));
  const accepted = [];
  const applied = [];
  const conflicts = [];
  const overlaps = (a, b) => a.path === b.path && (a.start < b.end && b.start < a.end || a.start === a.end && a.start === b.start);
  for (const diagnostic of diagnostics) {
    const edits = diagnostic.fix?.edits;
    if (!edits || edits.length === 0) continue;
    if (edits.some((edit) => !contents.has(edit.path) || accepted.some((other) => overlaps(edit, other)))) {
      conflicts.push(diagnostic);
      continue;
    }
    accepted.push(...edits);
    applied.push(diagnostic);
  }
  const byPath = /* @__PURE__ */ new Map();
  for (const edit of accepted) byPath.set(edit.path, [...byPath.get(edit.path) ?? [], edit]);
  const output2 = /* @__PURE__ */ new Map();
  for (const [path, edits] of byPath) {
    let content = contents.get(path) ?? "";
    for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
      content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
    }
    output2.set(path, content);
  }
  return { files: output2, applied, conflicts };
}

// src/lint/rules/helpers.ts
function defineRule(rule) {
  return rule;
}
function commandsOf(step) {
  const script = step.run?.value;
  if (!script) return [];
  const result = [];
  let offset = 0;
  let buffer = "";
  let bufferStart = 0;
  for (const rawLine of script.split("\n")) {
    const lineOffset = offset;
    offset += rawLine.length + 1;
    const text = rawLine.replace(/\r$/, "");
    if (buffer === "") bufferStart = lineOffset;
    if (/\\\s*$/.test(text)) {
      buffer += text.replace(/\\\s*$/, " ");
      continue;
    }
    buffer += text;
    const line = runLine(step, bufferStart);
    for (const part of buffer.split(/&&|\|\||;/)) {
      const command = part.trim();
      if (command && !command.startsWith("#")) result.push({ command, line });
    }
    buffer = "";
  }
  return result;
}
function* steps(workflows) {
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      for (const step of job.steps) yield { workflow, job, step };
    }
  }
}
function* stepsUsing(workflows, ...names) {
  const wanted = names.map((name) => name.toLowerCase());
  for (const entry of steps(workflows)) {
    const action = entry.step.uses?.action;
    if (action?.kind === "remote" && action.name !== void 0 && wanted.includes(action.name)) yield entry;
  }
}
function isPullRequestWorkflow(workflow) {
  return hasTrigger(workflow, "pull_request", "pull_request_target", "merge_group");
}
function isDeployLike(workflow) {
  if (/deploy|release|publish|promote|rollout/i.test(`${workflow.path} ${workflow.name ?? ""}`)) return true;
  if (workflow.jobs.some((job) => job.environment !== void 0)) return true;
  return hasTrigger(workflow, "release", "deployment", "registry_package");
}
function stepLine(step) {
  return step.uses?.line ?? step.run?.line ?? step.line;
}
function directChild(node, key) {
  if (!(0, import_yaml4.isMap)(node)) return void 0;
  const pair = node.items.find((item) => (0, import_yaml4.isPair)(item) && (0, import_yaml4.isScalar)(item.key) && String(item.key.value) === key);
  return pair && !(0, import_yaml4.isAlias)(pair.value) ? pair.value : void 0;
}
function directWith(workflow, step) {
  const match2 = /^(?:jobs\.([^.]+)\.steps|runs\.steps)\[(\d+)\]$/.exec(step.key);
  if (!match2) return void 0;
  const root = workflow.source.doc.contents;
  const parent = match2[1] !== void 0 ? directChild(directChild(root, "jobs"), match2[1]) : directChild(root, "runs");
  const stepsNode = directChild(parent, "steps");
  if (!(0, import_yaml4.isSeq)(stepsNode)) return void 0;
  const stepNode = stepsNode.items[Number(match2[2])];
  if (!(0, import_yaml4.isMap)(stepNode) || stepNode.flow || lineOfNode(workflow.source, stepNode) !== step.line) return void 0;
  const withNode = directChild(stepNode, "with");
  return (0, import_yaml4.isMap)(withNode) && !withNode.flow ? withNode : void 0;
}
function expandedJobSteps(project, workflow, job) {
  return job.steps.flatMap(
    (owner) => project.expandedSteps({ ...job, steps: [owner] }).map((step) => {
      const direct = step === owner;
      const action = direct ? void 0 : project.actions.find((candidate) => candidate.jobs[0]?.steps.includes(step));
      return { step, owner, path: action?.path ?? workflow.path, direct };
    })
  );
}
function jobCommands(project, workflow, job) {
  return expandedJobSteps(project, workflow, job).flatMap(
    (entry) => commandsOf(entry.step).map(({ command, line }) => ({ ...entry, command, line }))
  );
}
function isKnownMonorepo(project) {
  const { isMonorepo, monorepoTools } = project.facts;
  return isMonorepo.status === "known" && isMonorepo.value || monorepoTools.status === "known" && monorepoTools.value.some((tool2) => tool2 !== "gradle");
}
var DIFF_BASE_REF = /\borigin\/|\$\{\{\s*github\.(?:event\.pull_request\.base\.(?:sha|ref)|base_ref|event\.before)\s*\}\}|\bHEAD[~^]/;
function affectedTooling(command) {
  const text = command.replace(/["']/g, "");
  if (/^(?:echo|printf)\b/.test(text)) return void 0;
  if (/\bnx\s+affected\b/.test(text)) return "nx affected";
  if (/\bturbo\b.*\s--affected\b/.test(text)) return "turbo --affected";
  if (/\bturbo\b.*\s(?:--filter|-F)(?:=|\s+)\S*\[[^\]\s]+\]/.test(text)) return "turbo --filter=...[ref]";
  if (/\bpnpm\b.*\s(?:--filter|-F)(?:=|\s+)\S*\[[^\]\s]+\]/.test(text)) return "pnpm --filter ...[ref]";
  if (/\s--(?:changedSince|changed-since)\b/.test(text)) return "jest --changedSince";
  if (/\s--lastCommit\b/.test(text)) return "jest --lastCommit";
  if (/\s--(?:onlyChanged|only-changed)\b/.test(text)) return "jest --onlyChanged";
  if (/\bvitest\b.*\s--changed\b/.test(text)) return "vitest --changed";
  if (/\blerna\b.*\s--since\b/.test(text)) return "lerna --since";
  if (/\byarn\b.*\bworkspaces\s+foreach\b.*\s--since\b/.test(text)) return "yarn workspaces foreach --since";
  if (/\bgit\s+merge-base\b/.test(text)) return "git merge-base";
  if (/\bgit\s+diff\b/.test(text) && DIFF_BASE_REF.test(command)) return "git diff against the base";
  return void 0;
}
function parseActionVersion(text, source) {
  const match2 = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text);
  if (!match2) return void 0;
  return {
    major: Number(match2[1]),
    minor: match2[2] !== void 0 ? Number(match2[2]) : void 0,
    patch: match2[3] !== void 0 ? Number(match2[3]) : void 0,
    text,
    source
  };
}
function actionVersion(step, file) {
  const uses = step.uses;
  const ref = uses?.action.ref;
  if (!uses || uses.kind !== "literal" || uses.action.kind !== "remote" || ref === void 0) return void 0;
  if (!uses.action.shaPinned) return parseActionVersion(ref, "ref");
  if (!file) return void 0;
  const comment = /\s#(.*)$/.exec(lineText(file.content, uses.line))?.[1] ?? "";
  const match2 = /(?:^|[\s=@:])(v\d+(?:\.\d+){0,2})(?![\w.-])/.exec(comment);
  return match2?.[1] !== void 0 ? parseActionVersion(match2[1], "comment") : void 0;
}

// src/lint/rules/affected/change-detection.ts
var CHANGE_ACTIONS = /* @__PURE__ */ new Set([
  "dorny/paths-filter",
  "tj-actions/changed-files",
  "step-security/changed-files",
  "nrwl/nx-set-shas",
  "technote-space/get-diff-action",
  "jitterbit/get-changed-files",
  "ana06/get-changed-files",
  "trilom/file-changes-action",
  "marceloprado/has-changed-path",
  "yumemi-inc/changed-files"
]);
var DIFF_COMMAND = /\bgit\s+diff\b.*\s--name-(?:only|status)\b|\bgit\s+diff\b.*\s--(?:quiet|exit-code)\b.*\s--\s|\bgh\s+pr\s+diff\b|\bgh\s+api\b.*\/pulls\/\S+\/files\b/;
var NEEDS_OUTPUT = /needs\.([\w-]+)\.outputs\.([\w-]+)/g;
var CHANGE_NAME = /chang|affect|filter|path|diff|modif|touch|dirty|skip|should|run[-_]/i;
function collectJobs(project, workflow, seen) {
  if (seen.has(workflow.path)) return [];
  seen.add(workflow.path);
  const result = [];
  for (const job of workflow.jobs) {
    if (job.uses === void 0) {
      result.push({ workflow, job });
      continue;
    }
    const target = /^\.\/([^@]+)$/.exec(job.uses.value.trim())?.[1];
    const called = target !== void 0 ? project.workflows.find((candidate) => candidate.path === target) : void 0;
    const nested = called ? collectJobs(project, called, seen) : void 0;
    if (!nested) return void 0;
    result.push({ workflow, job }, ...nested);
  }
  return result;
}
function consumesChangeOutput(job) {
  const text = `${job.if ?? ""} ${job.matrix ? JSON.stringify(job.matrix) : ""}`;
  return [...text.matchAll(NEEDS_OUTPUT)].some((match2) => CHANGE_NAME.test(match2[1] ?? "") || CHANGE_NAME.test(match2[2] ?? ""));
}
function detectsChanges(project, { workflow, job }) {
  if (consumesChangeOutput(job)) return true;
  const usesChangeAction = expandedJobSteps(project, workflow, job).some(({ step }) => {
    const action = step.uses?.action;
    return action?.kind === "remote" && action.name !== void 0 && CHANGE_ACTIONS.has(action.name);
  });
  if (usesChangeAction) return true;
  return jobCommands(project, workflow, job).some(
    ({ command }) => affectedTooling(command) !== void 0 || DIFF_COMMAND.test(command.replace(/["']/g, ""))
  );
}
function runnerHint(project) {
  const tools = project.facts.monorepoTools.value;
  if (tools.includes("nx")) return " Inside each job, `nx affected` (with `nrwl/nx-set-shas@v5`) narrows the work further.";
  if (tools.includes("turbo")) return " Inside each job, `turbo run <task> --affected` narrows the work further.";
  return "";
}
var change_detection_default = defineRule({
  meta: {
    id: "affected/change-detection",
    ruleset: "affected",
    description: "Multi-job pull request workflows in a monorepo should skip jobs whose area did not change.",
    rationale: "In a monorepo most pull requests touch one area, yet every job still provisions a runner, restores caches, and installs dependencies. A small change-detection job that feeds job-level `if:` conditions skips the unrelated jobs entirely. Agent-driven repositories open many narrow pull requests, so the savings compound, and an always-run gate job keeps branch protection simple because skipped jobs report success.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: ["repository"],
    defaultOptions: {},
    references: [
      "https://github.com/dorny/paths-filter",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idif",
      "https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#handling-skipped-but-required-checks"
    ],
    impact: "medium",
    example: {
      bad: "on: pull_request\njobs:\n  web: ...\n  api: ...",
      good: "on: pull_request\njobs:\n  changes:\n    permissions: { pull-requests: read }\n    outputs: { web: ${{ steps.filter.outputs.web }}, api: ${{ steps.filter.outputs.api }} }\n    steps:\n      - id: filter\n        uses: dorny/paths-filter@v4\n        with:\n          filters: |\n            web: [apps/web/**, packages/ui/**]\n            api: [apps/api/**]\n  web:\n    needs: changes\n    if: needs.changes.outputs.web == 'true'\n  api:\n    needs: changes\n    if: needs.changes.outputs.api == 'true'\n  ci-ok:\n    needs: [web, api]\n    if: always()\n    steps:\n      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')\n        run: exit 1"
    }
  },
  check({ project, report }) {
    if (!isKnownMonorepo(project)) return;
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || !hasTrigger(workflow, "pull_request", "pull_request_target")) continue;
      if (workflow.jobs.length < 2 || isDeployLike(workflow)) continue;
      const pathFiltered = workflow.triggers.some(
        (trigger2) => (trigger2.event === "pull_request" || trigger2.event === "pull_request_target") && (trigger2.paths !== void 0 || trigger2.pathsIgnore !== void 0)
      );
      if (pathFiltered) continue;
      const jobs = collectJobs(project, workflow, /* @__PURE__ */ new Set());
      if (!jobs || jobs.some((entry) => detectsChanges(project, entry))) continue;
      report({
        path: workflow.path,
        line: workflow.triggersLine,
        key: "change-detection",
        message: `This pull request workflow runs all ${workflow.jobs.length} jobs on every change; none of them checks which part of the monorepo changed.`,
        suggestion: `Add a \`changes\` job using \`dorny/paths-filter@v4\` (it reads the pull request diff through the API, so grant \`pull-requests: read\`; no checkout needed) that exposes one output per area, make the other jobs \`needs: changes\` with \`if: needs.changes.outputs.<area> == 'true'\`, and add an always-run gate job (\`if: always()\`, \`needs:\` every job, failing when any result is \`failure\` or \`cancelled\`) as the single required check.${runnerHint(project)}`,
        confidence: "medium"
      });
    }
  }
});

// src/lint/rules/affected/path-filter-required-checks.ts
var PR_EVENTS = ["pull_request", "pull_request_target"];
function filterLine(workflow, trigger2, key) {
  const { source } = workflow;
  const onNode = field(source, source.doc.contents, "on")?.value;
  return field(source, field(source, onNode, trigger2.event)?.value, key)?.line ?? trigger2.line;
}
var path_filter_required_checks_default = defineRule({
  meta: {
    id: "affected/path-filter-required-checks",
    ruleset: "affected",
    description: "Pull request workflows should not skip themselves with trigger-level `paths` filters if they provide required checks.",
    rationale: "When `paths`/`paths-ignore` skips a pull request workflow, its checks never report and stay Pending, so a pull request that requires them cannot merge. Agents then stall or someone adds a bypass. Running the workflow on every pull request and skipping work with job-level `if:` conditions keeps the speed benefit: skipped jobs report success, and an always-run gate job gives branch protection one stable check.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore",
      "https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#handling-skipped-but-required-checks",
      "https://github.com/dorny/paths-filter"
    ],
    impact: "medium",
    example: {
      bad: "on:\n  pull_request:\n    paths: ['api/**']",
      good: "on: pull_request\njobs:\n  changes:\n    permissions: { pull-requests: read }\n    outputs: { api: ${{ steps.filter.outputs.api }} }\n    steps:\n      - id: filter\n        uses: dorny/paths-filter@v4\n        with: { filters: 'api: [api/**]' }\n  test:\n    needs: changes\n    if: needs.changes.outputs.api == 'true'\n  ci-ok:\n    needs: [changes, test]\n    if: always()\n    steps:\n      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')\n        run: exit 1"
    }
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || isDeployLike(workflow)) continue;
      for (const trigger2 of workflow.triggers) {
        if (!PR_EVENTS.includes(trigger2.event)) continue;
        for (const [key, values] of [
          ["paths", trigger2.paths],
          ["paths-ignore", trigger2.pathsIgnore]
        ]) {
          if (values === void 0) continue;
          report({
            path: workflow.path,
            line: filterLine(workflow, trigger2, key),
            key: `on.${trigger2.event}.${key}`,
            message: `\`${trigger2.event}\` runs are filtered by \`${key}\`; if this workflow provides a required status check, pull requests that skip it leave the check Pending and cannot merge.`,
            suggestion: "Trigger on every pull request and move the filter into the workflow: a `changes` job (`dorny/paths-filter@v4` with `pull-requests: read`, or `git diff --name-only`) exposes outputs that gate the expensive jobs through job-level `if:`, and an always-run gate job (`if: always()`, `needs:` every job, failing when any result is `failure` or `cancelled`) is the single required check. Skipped jobs count as successful, so the gate passes when nothing relevant changed.",
            confidence: "medium"
          });
        }
      }
    }
  }
});

// src/lint/rules/affected/test-selection.ts
var NON_PR_CONDITION = /github\.event_name\s*==\s*['"](?:push|schedule|workflow_dispatch|release|merge_group)['"]|github\.ref\s*==\s*['"]refs\/(?:heads|tags)\//;
var isTestTarget = (target) => /^(?:tests?|e2e|integration|unit|test[:-][\w:-]+|[\w-]+[:-](?:tests?|e2e))$/i.test(target);
var isFlag = (token) => token.startsWith("-");
var targetList = (targets) => `the ${targets.map((target) => `\`${target}\``).join(", ")} target${targets.length === 1 ? "" : "s"}`;
function operands(tokens, start) {
  const result = [];
  for (let index = start; index < tokens.length && !isFlag(tokens[index] ?? "-"); index++) result.push(tokens[index] ?? "");
  return result;
}
function flagValues(tokens, ...flags) {
  return tokens.flatMap((token, index) => {
    const flag = flags.find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
    if (!flag) return [];
    if (token.startsWith(`${flag}=`)) return [token.slice(flag.length + 1)];
    return operands(tokens, index + 1);
  });
}
var has = (tokens, ...flags) => tokens.some((token) => flags.some((flag) => token === flag || token.startsWith(`${flag}=`)));
function scriptName(tokens, toolIndex) {
  const rest = tokens.slice(toolIndex + 1).filter((token) => !isFlag(token) && !/^\d+$/.test(token));
  const run3 = rest.findIndex((token) => token === "run" || token === "run-script");
  return run3 >= 0 ? rest[run3 + 1] : rest[0];
}
function npmAlternative(project, script) {
  const tools = project.facts.monorepoTools.value;
  if (tools.includes("nx")) return `Use \`nx affected -t ${script}\` so only projects affected by the change run.`;
  if (tools.includes("turbo")) return `Use \`turbo run ${script} --affected\` so only packages affected by the change run.`;
  return `Compute the changed workspaces (for example from \`git diff --name-only origin/\${{ github.base_ref }}...HEAD\`) and pass them with \`-w <workspace>\`, or adopt a task runner with affected detection (Nx, Turborepo).`;
}
function detect(project, command) {
  if (/^(?:echo|printf)\b/.test(command)) return void 0;
  const tokens = command.replace(/["']/g, "").split(/\s+/).filter(Boolean);
  const at = (name) => tokens.findIndex((token) => name.test(token));
  const nx = at(/^(?:.*\/)?nx$/);
  if (nx >= 0 && tokens[nx + 1] === "run-many") {
    const targets = flagValues(tokens, "-t", "--target", "--targets").flatMap((value) => value.split(","));
    if (!targets.some(isTestTarget) || has(tokens, "-p", "--projects")) return void 0;
    return {
      tool: "nx run-many",
      what: `${targetList(targets)} for every project`,
      suggestion: `Use \`nx affected -t ${targets.join(" ")}\` with the base set by \`nrwl/nx-set-shas@v5\` (or \`--base=origin/\${{ github.base_ref }}\`) so only affected projects run.`
    };
  }
  const turbo = at(/^(?:.*\/)?turbo$/);
  if (turbo >= 0) {
    const tasks = operands(tokens, tokens[turbo + 1] === "run" ? turbo + 2 : turbo + 1);
    if (!tasks.some(isTestTarget) || has(tokens, "--affected", "--filter", "-F")) return void 0;
    return {
      tool: "turbo run",
      what: `${targetList(tasks)} for every package`,
      suggestion: `Use \`turbo run ${tasks.join(" ")} --affected\` (it compares against \`GITHUB_BASE_REF\` on pull requests; fetch the base first) so only changed packages and their dependents run.`
    };
  }
  const lerna = at(/^(?:.*\/)?lerna$/);
  if (lerna >= 0 && tokens[lerna + 1] === "run") {
    const script = tokens.slice(lerna + 2).find((token) => !isFlag(token));
    if (!script || !isTestTarget(script) || has(tokens, "--since", "--scope")) return void 0;
    return {
      tool: "lerna run",
      what: `the \`${script}\` script in every package`,
      suggestion: `Use \`lerna run ${script} --since origin/\${{ github.base_ref }}\` so only packages changed since the base and their dependents run (fetch the base first).`
    };
  }
  const yarn = at(/^yarn$/);
  if (yarn >= 0 && tokens[yarn + 1] === "workspaces" && (tokens[yarn + 2] === "foreach" || tokens[yarn + 2] === "run")) {
    const script = scriptName(tokens, yarn + 2);
    if (!script || !isTestTarget(script) || has(tokens, "--since", "--from", "--include")) return void 0;
    return {
      tool: "yarn workspaces",
      what: `the \`${script}\` script in every workspace`,
      suggestion: `Use \`yarn workspaces foreach -A --since=origin/\${{ github.base_ref }} run ${script}\` (Yarn 2+) so only workspaces changed since the base run, or a task runner with dependency-aware affected detection (Nx, Turborepo).`
    };
  }
  const pnpm = at(/^pnpm$/);
  if (pnpm >= 0 && has(tokens, "-r", "--recursive") && !has(tokens, "--filter", "-F")) {
    const script = scriptName(tokens, pnpm);
    if (!script || !isTestTarget(script)) return void 0;
    return {
      tool: "pnpm -r",
      what: `the \`${script}\` script in every package`,
      suggestion: `Use \`pnpm --filter "...[origin/\${{ github.base_ref }}]" ${script}\` so only packages changed since the base and their dependents run (fetch the base first).`
    };
  }
  const npm = at(/^npm$/);
  if (npm >= 0 && has(tokens, "--workspaces", "-ws") && !has(tokens, "--workspace", "-w")) {
    const script = scriptName(tokens, npm);
    if (!script || !isTestTarget(script)) return void 0;
    return { tool: "npm --workspaces", what: `the \`${script}\` script in every workspace`, suggestion: npmAlternative(project, script) };
  }
  const bazel = at(/^(?:.*\/)?bazel(?:isk)?$/);
  if (bazel >= 0 && tokens[bazel + 1] === "test" && tokens.includes("//...")) {
    return {
      tool: "bazel test //...",
      what: "every test target in the workspace",
      suggestion: "Compute affected targets from the diff (for example with bazel-diff or target-determinator) and pass only those to `bazel test`; a remote cache avoids re-running unchanged tests but still analyzes the whole graph."
    };
  }
  return void 0;
}
var skipsPullRequests = (subject) => subject.if !== void 0 && NON_PR_CONDITION.test(subject.if);
var test_selection_default = defineRule({
  meta: {
    id: "affected/test-selection",
    ruleset: "affected",
    description: "Pull request CI in a monorepo should test only the projects affected by the change.",
    rationale: "Running every project's tests on every pull request makes CI time grow with the size of the repository instead of the size of the change. Agents open many small pull requests, so affected-only selection (nx affected, turbo --affected, pnpm `[ref]` filters, lerna --since) is the biggest lever for keeping feedback fast and runner minutes bounded.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nx.dev/docs/features/ci-features/affected",
      "https://turborepo.com/docs/reference/run#--affected",
      "https://pnpm.io/filtering#--filter-since",
      "https://lerna.js.org/docs/api-reference/commands#--since-ref",
      "https://yarnpkg.com/cli/workspaces/foreach"
    ],
    impact: "high",
    example: {
      bad: "on: pull_request\n...\n- run: npx nx run-many -t test",
      good: "on: pull_request\n...\n- uses: nrwl/nx-set-shas@v5\n- run: npx nx affected -t test"
    }
  },
  check({ project, report }) {
    if (!isKnownMonorepo(project)) return;
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || !hasTrigger(workflow, "pull_request", "pull_request_target")) continue;
      for (const job of workflow.jobs) {
        if (skipsPullRequests(job)) continue;
        for (const entry of jobCommands(project, workflow, job)) {
          if (skipsPullRequests(entry.owner) || skipsPullRequests(entry.step)) continue;
          const finding = detect(project, entry.command);
          if (!finding) continue;
          report({
            path: entry.path,
            line: entry.line,
            key: `${entry.owner.key}:${finding.tool}`,
            message: `\`${finding.tool}\` runs ${finding.what} on every pull request instead of only what the change affects.`,
            suggestion: finding.suggestion
          });
        }
      }
    }
  }
});

// src/lint/rules/affected/trusted-change-detection.ts
var ACTION = "tj-actions/changed-files";
var MALICIOUS_SHA = "0e58ed8671d6b60d0890c21b07f8835ace038e67";
var ADVISORY = "CVE-2025-30066 (GHSA-mrrh-fwg8-r2c3)";
var SUGGESTION = "Pin `tj-actions/changed-files` to the full commit SHA of v46.0.1 or later (with a `# v46.x.y` comment), or replace it with `dorny/paths-filter@v4` or a plain `git diff --name-only` step. If this workflow ran on 2025-03-14 or 2025-03-15, review those run logs and rotate every secret the job could read.";
var trusted_change_detection_default = defineRule({
  meta: {
    id: "affected/trusted-change-detection",
    ruleset: "affected",
    description: "Change-detection steps must not use tj-actions/changed-files versions affected by CVE-2025-30066.",
    rationale: "Change detection runs on every pull request, often with secrets in scope. In March 2025 the tags of tj-actions/changed-files were repointed to a malicious commit that dumped runner memory, including secrets, into workflow logs (CVE-2025-30066). Versions before v46.0.1 are in the advisory's affected range; agents copying an old snippet reintroduce it.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/advisories/GHSA-mrrh-fwg8-r2c3",
      "https://nvd.nist.gov/vuln/detail/CVE-2025-30066",
      "https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions",
      "https://github.com/dorny/paths-filter"
    ],
    impact: "high",
    example: {
      bad: "- uses: tj-actions/changed-files@v45",
      good: "- uses: dorny/paths-filter@v4"
    }
  },
  check({ project, report }) {
    for (const { workflow, step } of steps([...project.workflows, ...project.actions])) {
      const uses = step.uses;
      if (!uses || uses.action.kind !== "remote" || uses.action.name !== ACTION) continue;
      const ref = uses.action.ref?.toLowerCase();
      const location = { path: workflow.path, line: uses.line, key: `${step.key}.uses`, suggestion: SUGGESTION };
      if (ref === MALICIOUS_SHA) {
        report({
          ...location,
          message: `${ACTION} is pinned to ${MALICIOUS_SHA.slice(0, 7)}, the malicious commit from ${ADVISORY} that dumps runner memory, including secrets, into the workflow log.`
        });
        continue;
      }
      const version = actionVersion(step, project.files.get(workflow.path));
      if (!version) continue;
      const vulnerable = version.major < 46 || version.major === 46 && version.minor === 0 && version.patch === 0;
      if (!vulnerable) continue;
      const shown = version.source === "comment" ? `${ACTION}@${ref?.slice(0, 7) ?? ""} (${version.text})` : `${ACTION}@${version.text}`;
      report({
        ...location,
        message: `${shown} is in the range affected by ${ADVISORY}, the March 2025 compromise that leaked CI secrets; the fix is v46.0.1.`,
        ...version.source === "comment" ? { confidence: "medium" } : {}
      });
    }
  }
});

// src/lint/rules/affected/index.ts
var rules = [change_detection_default, path_filter_required_checks_default, test_selection_default, trusted_change_detection_default];

// src/lint/rules/caching/shared.ts
var CACHE_RESTORE_ACTIONS = [
  "actions/cache",
  "actions/cache/restore",
  "buildjet/cache",
  "buildjet/cache/restore",
  "useblacksmith/cache",
  "useblacksmith/cache/restore",
  "runs-on/cache",
  "runs-on/cache/restore"
];
function usesAction(step, ...names) {
  const action = step.uses?.action;
  return action?.kind === "remote" && action.name !== void 0 && names.includes(action.name);
}
function anyUses(steps2, ...names) {
  return steps2.some((step) => usesAction(step, ...names));
}
function listOf(value) {
  return value.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry !== "" && !entry.startsWith("#"));
}
function isFalse(value) {
  return value === false || typeof value === "string" && value.trim().toLowerCase() === "false";
}
function isTrue(value) {
  return value === true || typeof value === "string" && value.trim().toLowerCase() === "true";
}
function cacheCovers(steps2, path, key) {
  return steps2.some((step) => {
    if (!usesAction(step, ...CACHE_RESTORE_ACTIONS)) return false;
    const pathEntry = step.with.get("path");
    if (pathEntry && pathEntry.kind !== "literal") return true;
    const paths = pathEntry && typeof pathEntry.value === "string" ? listOf(pathEntry.value) : [];
    if (paths.some((entry) => !entry.startsWith("!") && path.test(entry))) return true;
    const keyValue = step.with.get("key")?.value;
    return key !== void 0 && typeof keyValue === "string" && key.test(keyValue);
  });
}
function basename(path) {
  return path.split("/").pop() ?? path;
}
function commandWords(command) {
  const words2 = command.split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < words2.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words2[index] ?? "") || ["sudo", "time", "env", "exec", "command"].includes(words2[index] ?? ""))) {
    index += 1;
  }
  return words2.slice(index);
}

// src/lint/rules/caching/build-tool-cache.ts
var TURBO_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "bin",
  "boundaries",
  "completion",
  "daemon",
  "devtools",
  "gen",
  "generate",
  "info",
  "link",
  "login",
  "logout",
  "ls",
  "prune",
  "query",
  "scan",
  "telemetry",
  "unlink",
  "watch"
]);
var CARGO_VERBS = /* @__PURE__ */ new Set(["build", "b", "test", "t", "check", "c", "clippy", "nextest", "bench"]);
var BAZEL_VERBS = /* @__PURE__ */ new Set(["build", "test", "coverage"]);
var BAZEL_CACHE_FLAG = /^--(remote_cache|disk_cache|remote_executor)\b/;
var HELP = /* @__PURE__ */ new Set(["--version", "-v", "--help", "-h", "version", "help"]);
var MESSAGES = {
  gradle: {
    message: "Gradle runs without caching dependencies or build outputs.",
    suggestion: "Add `gradle/actions/setup-gradle` before the build (caches dependencies, wrappers and the build cache), or set `cache: gradle` on actions/setup-java."
  },
  maven: {
    message: "Maven runs without caching the local repository (~/.m2/repository).",
    suggestion: "Set `cache: maven` on actions/setup-java, or cache ~/.m2/repository with actions/cache."
  },
  cargo: {
    message: "Cargo builds without caching ~/.cargo and target/.",
    suggestion: "Add `Swatinem/rust-cache` after installing the toolchain (or cache ~/.cargo and target/ with actions/cache)."
  },
  bazel: {
    message: "Bazel runs without a remote or disk cache.",
    suggestion: "Configure `--remote_cache` (or `--disk_cache` persisted with actions/cache), ideally in .bazelrc under a `ci` config; bazel-contrib/setup-bazel can persist disk and repository caches."
  },
  turbo: {
    message: "Turborepo runs without remote caching (no TURBO_TOKEN/TURBO_TEAM) or a cached .turbo directory.",
    suggestion: "Set `TURBO_TOKEN` (from a secret) and `TURBO_TEAM` in env to use Remote Cache, or cache the `.turbo` directory with actions/cache."
  },
  nx: {
    message: "Nx runs without a remote cache (Nx Cloud or self-hosted) or a cached .nx/cache directory.",
    suggestion: "Connect Nx Cloud (`NX_CLOUD_ACCESS_TOKEN`), configure a self-hosted remote cache, or cache `.nx/cache` with actions/cache."
  }
};
function normalize(words2) {
  let rest = words2;
  for (let guard = 0; guard < 3; guard += 1) {
    const [first, second] = rest;
    if (first === "npx" || first === "bunx") {
      rest = rest.slice(1);
      while (rest[0]?.startsWith("-")) rest = rest.slice(1);
    } else if ((first === "pnpm" || first === "yarn" || first === "bun") && (second === "exec" || second === "dlx" || second === "x")) {
      rest = rest.slice(2);
    } else if (first === "npm" && second === "exec") {
      rest = rest.slice(2);
      if (rest[0] === "--") rest = rest.slice(1);
    } else if ((first === "pnpm" || first === "yarn") && (second === "nx" || second === "turbo")) {
      rest = rest.slice(1);
    } else {
      break;
    }
  }
  return rest;
}
function detect2(words2) {
  const [first = "", second = "", ...rest] = normalize(words2);
  const name = basename(first);
  const args = [second, ...rest].filter(Boolean);
  if (args.length > 0 && args.every((arg) => HELP.has(arg))) return void 0;
  if (["gradlew", "gradlew.bat", "gradle"].includes(name)) return "gradle";
  if (["mvn", "mvnw", "mvnw.cmd"].includes(name)) return "maven";
  if (name === "cargo") {
    const verb = args.find((arg) => !arg.startsWith("+"));
    return verb !== void 0 && CARGO_VERBS.has(verb) ? "cargo" : void 0;
  }
  if (name === "bazel" || name === "bazelisk") {
    const verb = args.find((arg) => !arg.startsWith("-"));
    return verb !== void 0 && BAZEL_VERBS.has(verb) ? "bazel" : void 0;
  }
  if (name === "turbo") return second === "run" || second !== "" && !second.startsWith("-") && !TURBO_SUBCOMMANDS.has(second) ? "turbo" : void 0;
  if (name === "nx") return ["affected", "run-many", "run"].includes(second) || second.startsWith("affected:") ? "nx" : void 0;
  return void 0;
}
function envNames(workflow, job, all) {
  return new Set([workflow.env, job.env, ...all.map((step) => step.env)].flatMap((env) => Object.keys(env)));
}
function scriptsMention(all, pattern) {
  return all.some((step) => pattern.test(step.run?.value ?? ""));
}
function setupJavaCaches(all, manager) {
  return all.some((step) => {
    if (!usesAction(step, "actions/setup-java")) return false;
    const cache = step.with.get("cache");
    return cache !== void 0 && (cache.kind !== "literal" || String(cache.value).toLowerCase() === manager);
  });
}
function covered(tool2, context) {
  const { project, workflow, job, all, commands } = context;
  switch (tool2) {
    case "gradle":
      return anyUses(all, "gradle/actions/setup-gradle", "gradle/gradle-build-action") || setupJavaCaches(all, "gradle") || cacheCovers(all, /gradle/i);
    case "maven":
      return setupJavaCaches(all, "maven") || cacheCovers(all, /\.m2|maven/i);
    case "cargo":
      return anyUses(all, "swatinem/rust-cache", "mozilla-actions/sccache-action") || all.some((step) => usesAction(step, "actions-rust-lang/setup-rust-toolchain", "moonrepo/setup-rust") && !isFalse(step.with.get("cache")?.value)) || cacheCovers(all, /\.cargo|(^|\/)target(\/|$)/i);
    case "bazel":
      return commands.some((words2) => words2.some((word) => BAZEL_CACHE_FLAG.test(word))) || [...project.files.values()].some((file) => /bazelrc/i.test(basename(file.path)) && /remote_cache|disk_cache|remote_executor/.test(file.content)) || cacheCovers(all, /./) || all.some(
        (step) => usesAction(step, "bazel-contrib/setup-bazel") && ["disk-cache", "remote-cache"].some((input2) => step.with.has(input2) && !isFalse(step.with.get(input2)?.value))
      );
    case "turbo": {
      const env = envNames(workflow, job, all);
      return ["TURBO_TOKEN", "TURBO_TEAM", "TURBO_API"].some((name) => env.has(name)) || scriptsMention(all, /TURBO_(TOKEN|TEAM|API)/) || commands.some((words2) => words2.some((word) => /^--(token|team|api)(=|$)/.test(word))) || cacheCovers(all, /turbo/i) || all.some((step) => step.uses?.action.kind === "remote" && /turbo/i.test(step.uses.action.name ?? ""));
    }
    case "nx": {
      const env = envNames(workflow, job, all);
      return ["NX_CLOUD_ACCESS_TOKEN", "NX_CLOUD_AUTH_TOKEN"].some((name) => env.has(name)) || scriptsMention(all, /NX_CLOUD_(ACCESS|AUTH)_TOKEN|nx-cloud\s+start-ci-run/) || [...project.files.values()].some(
        (file) => basename(file.path) === "nx.json" && /nxCloud|nx-cloud|remote[-_]?cache|s3-cache|gcs-cache|azure-cache|shared-fs-cache|accessToken/i.test(file.content)
      ) || cacheCovers(all, /(^|\/)\.?nx(\/|$)|nx[-_]?cache/i);
    }
  }
}
var build_tool_cache_default = defineRule({
  meta: {
    id: "caching/build-tool-cache",
    ruleset: "caching",
    description: "Build tools with their own caches (Gradle, Maven, Cargo, Bazel, Turborepo, Nx) should persist them between runs.",
    rationale: "Gradle, Maven, Cargo, Bazel, Turborepo and Nx skip downloads and unchanged work when their caches are warm, but hosted runners start empty. Without a cache action or a remote cache, every run (and every agent iteration) rebuilds from scratch.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/gradle/actions/blob/main/docs/setup-gradle.md",
      "https://github.com/actions/setup-java#caching-packages-dependencies",
      "https://github.com/Swatinem/rust-cache",
      "https://bazel.build/remote/caching",
      "https://turborepo.com/docs/core-concepts/remote-caching",
      "https://nx.dev/ci/features/remote-cache"
    ],
    impact: "medium",
    example: {
      bad: "- uses: actions/checkout@v6\n- run: ./gradlew build",
      good: "- uses: actions/checkout@v6\n- uses: gradle/actions/setup-gradle@v5\n- run: ./gradlew build"
    }
  },
  check({ project, input: input2, report }) {
    const completeInventory = input2.mode === "repository" && input2.inventoryComplete;
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        const all = project.expandedSteps(job);
        const commands = all.flatMap((step) => commandsOf(step).map(({ command }) => commandWords(command)));
        const found = /* @__PURE__ */ new Map();
        for (const top of job.steps) {
          for (const step of project.expandedSteps({ ...job, steps: [top] })) {
            for (const { command, line } of commandsOf(step)) {
              const tool2 = detect2(commandWords(command));
              if (!tool2 || found.has(tool2)) continue;
              found.set(tool2, step === top ? line : top.uses?.line ?? top.line);
            }
          }
        }
        for (const [tool2, line] of found) {
          if ((tool2 === "bazel" || tool2 === "nx") && !completeInventory) continue;
          if (covered(tool2, { project, workflow, job, all, commands })) continue;
          report({ path: workflow.path, line, key: `${job.key}:${tool2}`, ...MESSAGES[tool2] });
        }
      }
    }
  }
});

// src/lint/rules/caching/cache-key.ts
var VOLATILE = /github\.(sha|run_id|run_number|run_attempt)\b/;
var NPM_CI_VERBS = /* @__PURE__ */ new Set(["ci", "clean-install", "ic", "install-clean", "isntall-clean"]);
function runsNpmCi(step) {
  if (/cache-hit/.test(step.if ?? "")) return false;
  return commandsOf(step).some(({ command }) => {
    const [tool2, verb] = commandWords(command);
    return tool2 === "npm" && verb !== void 0 && NPM_CI_VERBS.has(verb);
  });
}
var cache_key_default = defineRule({
  meta: {
    id: "caching/cache-key",
    ruleset: "caching",
    description: "actions/cache keys must invalidate when inputs change and still hit between runs.",
    rationale: "A static key never changes, so the cache goes stale forever (caches are immutable once saved). A key containing the commit SHA or run id without `restore-keys` misses on every run, paying the upload cost with no benefit. Caching node_modules for `npm ci` is wasted work because `npm ci` deletes node_modules before installing.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/cache#creating-a-cache-key",
      "https://github.com/actions/cache/blob/main/tips-and-workarounds.md#update-a-cache",
      "https://docs.npmjs.com/cli/v11/commands/npm-ci"
    ],
    impact: "medium",
    example: {
      bad: "- uses: actions/cache@v6\n  with:\n    path: node_modules\n    key: deps",
      good: "- uses: actions/cache@v6\n  with:\n    path: ~/.npm\n    key: npm-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}\n    restore-keys: npm-${{ runner.os }}-"
    }
  },
  check({ project, report }) {
    for (const workflow of [...project.workflows, ...project.actions]) {
      for (const job of workflow.jobs) {
        const all = project.expandedSteps(job);
        for (const step of job.steps) {
          const save = usesAction(step, "actions/cache/save");
          if (!save && !usesAction(step, "actions/cache", "actions/cache/restore")) continue;
          const key = step.with.get("key");
          if (key && key.kind === "literal" && key.value !== null && key.value !== void 0 && String(key.value).trim() !== "") {
            const text = String(key.value);
            report({
              path: workflow.path,
              line: key.line,
              key: `${step.key}:static-key`,
              message: `Cache key \`${text}\` is static, so the cache is never invalidated when dependencies change.`,
              suggestion: "Include a hash of the inputs, e.g. `key: deps-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}`, plus `restore-keys` for partial hits.",
              confidence: /\d/.test(text) ? "medium" : "high"
            });
          } else if (key && typeof key.value === "string" && VOLATILE.test(key.value) && !save && !step.with.has("restore-keys")) {
            const match2 = VOLATILE.exec(key.value)?.[0] ?? "github.sha";
            report({
              path: workflow.path,
              line: key.line,
              key: `${step.key}:volatile-key`,
              message: `Cache key includes \`${match2}\` but has no \`restore-keys\`, so every run misses the cache.`,
              suggestion: "Add `restore-keys` with the key's stable prefix, or key on a hash of the inputs (`hashFiles(...)`) instead."
            });
          }
          if (save) continue;
          const path = step.with.get("path");
          if (!path || path.kind !== "literal" || typeof path.value !== "string") continue;
          const cachesNodeModules = listOf(path.value).some((entry) => !entry.startsWith("!") && /(^|\/)node_modules\/?$/.test(entry));
          if (!cachesNodeModules) continue;
          const later = all.slice(all.indexOf(step) + 1);
          if (!later.some(runsNpmCi)) continue;
          report({
            path: workflow.path,
            line: path.line,
            key: `${step.key}:node-modules`,
            message: "Caching `node_modules` is wasted because `npm ci` deletes node_modules before installing.",
            suggestion: "Cache `~/.npm` instead (or use `actions/setup-node` with `cache: npm`) and keep `npm ci`."
          });
        }
      }
    }
  }
});

// src/lint/rules/caching/docker-layer-cache.ts
function cacheEntries(entry) {
  if (!entry || entry.kind === "expression" || typeof entry.value !== "string") return [];
  return listOf(entry.value).map((text) => {
    const attributes = /* @__PURE__ */ new Map();
    for (const part of text.split(",")) {
      const eq = part.indexOf("=");
      if (eq > 0) attributes.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
    }
    const type = attributes.get("type") ?? (text.includes("=") ? "" : "registry");
    return { type: type.toLowerCase(), attributes, line: entry.line };
  });
}
function dockerBuildIndex(words2) {
  if (words2[0] !== "docker") return -1;
  if (words2[1] === "build") return 1;
  if ((words2[1] === "image" || words2[1] === "buildx") && words2[2] === "build") return 2;
  return -1;
}
function isBuildPush(step) {
  return usesAction(step, "docker/build-push-action");
}
var docker_layer_cache_default = defineRule({
  meta: {
    id: "caching/docker-layer-cache",
    ruleset: "caching",
    description: "Docker image builds in CI should import and export a layer cache.",
    rationale: "Hosted runners start with an empty BuildKit cache, so without `cache-from`/`cache-to` every layer (including dependency installs) is rebuilt on every run. The GitHub Actions cache backend defaults every build to the same `buildkit` scope, so multiple images overwrite each other's cache unless each gets a unique `scope`. Inline cache only supports `mode=min` (final-stage layers); a registry cache with `mode=max` also caches intermediate stages.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/ci/github-actions/cache/",
      "https://docs.docker.com/build/cache/backends/gha/",
      "https://docs.docker.com/build/cache/backends/registry/"
    ],
    impact: "high",
    example: {
      bad: "- uses: docker/build-push-action@v7\n  with:\n    push: true\n    tags: user/app:latest",
      good: "- uses: docker/build-push-action@v7\n  with:\n    push: true\n    tags: user/app:latest\n    cache-from: type=gha,scope=app\n    cache-to: type=gha,mode=max,scope=app"
    }
  },
  check({ project, report }) {
    const workflows = [...project.workflows, ...project.actions];
    const buildPushCount = [...steps(workflows)].filter(({ step }) => isBuildPush(step)).length;
    for (const { workflow, step } of steps(workflows)) {
      if (isBuildPush(step)) {
        const cacheFrom = step.with.get("cache-from");
        const cacheTo = step.with.get("cache-to");
        if (!cacheFrom && !cacheTo) {
          if (isTrue(step.with.get("no-cache")?.value)) continue;
          report({
            path: workflow.path,
            line: step.uses?.line ?? step.line,
            key: `${step.key}:no-cache`,
            message: "`docker/build-push-action` builds without a layer cache (`cache-from`/`cache-to`), so every layer is rebuilt.",
            suggestion: "Add `cache-from: type=gha,scope=<image>` and `cache-to: type=gha,mode=max,scope=<image>` (or a registry cache with `mode=max`)."
          });
          continue;
        }
        const entries2 = [...cacheEntries(cacheTo), ...cacheEntries(cacheFrom)];
        const unscoped = entries2.find((entry) => entry.type === "gha" && !entry.attributes.has("scope"));
        if (unscoped && buildPushCount >= 2) {
          report({
            path: workflow.path,
            line: unscoped.line,
            key: `${step.key}:gha-scope`,
            message: `\`type=gha\` cache has no \`scope\` while the repository builds ${buildPushCount} images, so they overwrite each other's cache.`,
            suggestion: "Give each image a unique scope, e.g. `cache-from: type=gha,scope=<image>` and `cache-to: type=gha,mode=max,scope=<image>`."
          });
        }
        const inline = entries2.find((entry) => entry.type === "inline");
        if (inline) {
          report({
            path: workflow.path,
            line: inline.line,
            key: `${step.key}:inline`,
            message: "Inline cache only stores final-stage layers (`mode=min`), so multi-stage builds miss most of the cache.",
            suggestion: "Use a registry cache with `mode=max`, e.g. `cache-to: type=registry,ref=<image>:buildcache,mode=max`, or `type=gha,mode=max`."
          });
        }
        continue;
      }
      let count = 0;
      for (const { command, line } of commandsOf(step)) {
        const words2 = commandWords(command);
        const index = dockerBuildIndex(words2);
        if (index < 0) continue;
        const args = words2.slice(index + 1);
        if (args.some((arg) => /^--(cache-from|no-cache|help)(=|$)/.test(arg) || arg === "-h")) continue;
        report({
          path: workflow.path,
          line,
          key: `${step.key}:docker-build:${count}`,
          message: `\`${words2.slice(0, index + 1).join(" ")}\` runs without \`--cache-from\`, so every layer is rebuilt on a fresh runner.`,
          suggestion: "Use `docker/build-push-action` with `cache-from`/`cache-to`, or pass `--cache-from type=registry,ref=<image>:buildcache` (with `--cache-to ...,mode=max`) to `docker buildx build`."
        });
        count += 1;
      }
    }
  }
});

// src/lint/rules/caching/setup-cache.ts
var LABEL = {
  npm: "npm",
  pnpm: "pnpm",
  yarn: "Yarn",
  pip: "pip",
  poetry: "Poetry",
  pipenv: "Pipenv",
  uv: "uv",
  maven: "Maven",
  gradle: "Gradle",
  sbt: "sbt",
  go: "Go module",
  nuget: "NuGet"
};
var COVERAGE = {
  npm: { path: /(^|\/)\.npm(\/|$)|npm-cache|node_modules/i, key: /package-lock|npm-shrinkwrap/i },
  pnpm: { path: /pnpm|node_modules/i, key: /pnpm-lock/i },
  yarn: { path: /yarn|node_modules/i, key: /yarn\.lock/i },
  pip: { path: /pip|venv/i, key: /requirements/i },
  poetry: { path: /poetry|venv/i, key: /poetry\.lock/i },
  pipenv: { path: /pipenv|virtualenvs|venv/i, key: /pipfile/i },
  uv: { path: /(^|\/)uv(\/|$)|venv/i, key: /uv\.lock/i },
  maven: { path: /\.m2|maven/i, key: /pom\.xml/i },
  gradle: { path: /gradle/i, key: /gradle/i },
  sbt: { path: /ivy|sbt|coursier/i, key: /build\.sbt/i },
  go: { path: /go-build|go\/pkg\/mod|(^|\/)go(\/|$)/i, key: /go\.(sum|mod)/i },
  nuget: { path: /nuget/i, key: /packages\.lock\.json|csproj/i }
};
var NODE_LOCKFILES = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn"
};
function covered2(steps2, manager) {
  if (manager === "gradle" && anyUses(steps2, "gradle/actions/setup-gradle", "gradle/gradle-build-action")) return true;
  if (manager === "uv" && anyUses(steps2, "astral-sh/setup-uv")) return true;
  if (["npm", "pnpm", "yarn"].includes(manager) && anyUses(steps2, "bahmutov/npm-install")) return true;
  return cacheCovers(steps2, COVERAGE[manager].path, COVERAGE[manager].key);
}
function actionMajor(step, file) {
  const uses = step.uses;
  if (!uses) return void 0;
  if (uses.action.shaPinned) {
    const comment = file ? /#\s*v?(\d+)/.exec(lineText(file.content, uses.line)) : null;
    return comment?.[1] ? Number(comment[1]) : void 0;
  }
  const match2 = /^v?(\d+)(\.\d+)*$/.exec(uses.action.ref ?? "");
  return match2?.[1] ? Number(match2[1]) : void 0;
}
function filePaths(project) {
  return [...project.files.keys()].filter((path) => !/(^|\/)node_modules\//.test(path));
}
function declaredNodeManager(project) {
  const json2 = project.rootManifest?.json;
  if (!json2) return void 0;
  if (typeof json2.packageManager === "string") return json2.packageManager;
  const devEngines = json2.devEngines;
  return typeof devEngines?.packageManager?.name === "string" ? `${devEngines.packageManager.name}@` : void 0;
}
var MAY_INSTALL = /(^|[\s;&|(`])(npm|pnpm|yarn|npx|bun|bunx|corepack|make|just|task|turbo|nx|lerna|rush)(\s|$)|(^|\s)(\.{1,2}\/|bash\s|sh\s|source\s)|\.(sh|bash)\b/;
function mayInstallNodePackages(after) {
  const commands = after.flatMap((step) => commandsOf(step).map((entry) => entry.command));
  return commands.length === 0 || commands.some((command) => MAY_INSTALL.test(command));
}
function earlierCommands(before) {
  return before.flatMap((step) => commandsOf(step).map((entry) => entry.command));
}
function literalWith(step, key) {
  const entry = step.with.get(key);
  return entry && entry.kind === "literal" && entry.value !== null && entry.value !== void 0 ? String(entry.value) : void 0;
}
function checkNode(project, step, before, all, file) {
  if (step.with.has("cache")) return void 0;
  const lockfiles = project.facts.lockfiles.filter((path) => basename(path) in NODE_LOCKFILES && !path.includes("node_modules/"));
  if (lockfiles.length === 0) return void 0;
  const dependencyPathEntry = step.with.get("cache-dependency-path");
  const dependencyPath = literalWith(step, "cache-dependency-path");
  const fromDependencyPath = dependencyPath ? NODE_LOCKFILES[basename(listOf(dependencyPath)[0] ?? "")] : void 0;
  const rootLock = lockfiles.find((path) => !path.includes("/"));
  const nestedManagers = new Set(lockfiles.map((path) => NODE_LOCKFILES[basename(path)]));
  const manager = fromDependencyPath ?? (rootLock ? NODE_LOCKFILES[rootLock] : nestedManagers.size === 1 ? [...nestedManagers][0] : void 0);
  if (!manager) {
    if (dependencyPathEntry && dependencyPathEntry.kind !== "literal") return void 0;
    return {
      managers: ["npm", "pnpm", "yarn"],
      message: "`actions/setup-node` does not cache dependencies although lockfiles exist.",
      suggestion: "Add `cache: <npm|pnpm|yarn>` with a `cache-dependency-path` pointing at the lockfile(s)."
    };
  }
  if (covered2(all, manager) || !mayInstallNodePackages(all.slice(all.indexOf(step) + 1))) return void 0;
  const declared = declaredNodeManager(project);
  const major = actionMajor(step, file);
  if (manager === "npm" && declared?.startsWith("npm@") && (major === void 0 || major >= 6)) return void 0;
  if (isFalse(step.with.get("package-manager-cache")?.value)) return void 0;
  const hasDependencyPath = dependencyPathEntry !== void 0;
  const commands = earlierCommands(before);
  let fixable = hasDependencyPath || rootLock !== void 0;
  if (manager === "pnpm") {
    fixable &&= anyUses(before, "pnpm/action-setup") || commands.some((command) => /^corepack\s+enable\b/.test(command) || /^npm\s+(i|install)\s+(-g|--global)\b.*\bpnpm\b/.test(command));
  } else if (manager === "yarn") {
    fixable &&= declared === void 0 || declared.startsWith("yarn@1") || commands.some((command) => /^corepack\s+enable\b/.test(command));
  }
  const location = rootLock ?? lockfiles.find((path) => NODE_LOCKFILES[basename(path)] === manager) ?? "";
  const extra = hasDependencyPath || rootLock ? "" : ` and \`cache-dependency-path: ${location}\``;
  const order = manager === "pnpm" && !fixable ? " (pnpm must be installed before setup-node, e.g. with pnpm/action-setup)" : "";
  return {
    managers: [manager],
    ...fixable ? { fixValue: manager } : {},
    message: `\`actions/setup-node\` does not cache ${LABEL[manager]} dependencies (${basename(location)} found).`,
    suggestion: `Add \`cache: ${manager}\`${extra} to the step's \`with:\`${order} so the package download cache is restored between runs.`
  };
}
function checkPython(project, step, before, all) {
  if (step.with.has("cache")) return void 0;
  const paths = filePaths(project);
  const names = paths.map(basename);
  const managers = /* @__PURE__ */ new Set();
  if (names.includes("poetry.lock")) managers.add("poetry");
  if (names.includes("Pipfile.lock")) managers.add("pipenv");
  if (names.includes("uv.lock") && !anyUses(all, "astral-sh/setup-uv")) managers.add("uv");
  if (paths.some((path) => /^requirements.*\.txt$/i.test(basename(path)) || /(^|\/)requirements\/[^/]+\.txt$/i.test(path))) managers.add("pip");
  const list3 = [...managers];
  if (list3.length === 0 || list3.some((manager2) => covered2(all, manager2))) return void 0;
  if (list3.length > 1) {
    return {
      managers: list3,
      message: "`actions/setup-python` does not cache dependencies (caching is off by default).",
      suggestion: `Set \`cache:\` to the installer this job uses (${list3.join(", ")}).`
    };
  }
  const manager = list3[0];
  if (manager === "uv") {
    return {
      managers: list3,
      message: "`actions/setup-python` does not cache dependencies, and uv.lock is present.",
      suggestion: "Use `astral-sh/setup-uv` (with `enable-cache: true`) to install uv and cache its downloads."
    };
  }
  const hasDependencyPath = step.with.has("cache-dependency-path");
  let fixable = false;
  if (manager === "pip") fixable = hasDependencyPath || names.includes("requirements.txt");
  if (manager === "poetry") {
    fixable = anyUses(before, "snok/install-poetry", "abatilo/actions-poetry") || earlierCommands(before).some((command) => /^(pipx|pip3?|python3?\s+-m\s+pip)\s+install\b.*\bpoetry\b/.test(command));
  }
  const order = manager === "poetry" && !fixable ? " (Poetry must be installed before setup-python, e.g. `pipx install poetry`)" : "";
  return {
    managers: list3,
    ...fixable ? { fixValue: manager } : {},
    message: `\`actions/setup-python\` does not cache ${LABEL[manager]} dependencies (caching is off by default).`,
    suggestion: `Add \`cache: ${manager}\` to the step's \`with:\`${order}.`
  };
}
function checkJava(project, step, all) {
  if (step.with.has("cache")) return void 0;
  const names = new Set(filePaths(project).map(basename));
  const managers = [];
  if (names.has("pom.xml")) managers.push("maven");
  if (["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].some((name) => names.has(name))) managers.push("gradle");
  if (names.has("build.sbt")) managers.push("sbt");
  if (managers.length === 0 || managers.some((manager2) => covered2(all, manager2))) return void 0;
  const manager = managers.length === 1 ? managers[0] : void 0;
  return {
    managers,
    ...manager ? { fixValue: manager } : {},
    message: `\`actions/setup-java\` does not cache ${manager ? LABEL[manager] : "build tool"} dependencies.`,
    suggestion: manager === "gradle" ? "Add `cache: gradle`, or use `gradle/actions/setup-gradle`, which also caches the Gradle build cache." : `Add \`cache: ${manager ?? managers.join("|")}\` to the step's \`with:\`.`
  };
}
function checkGo(step, all) {
  const cache = step.with.get("cache");
  if (!cache || !isFalse(cache.value) || covered2(all, "go")) return void 0;
  return {
    managers: ["go"],
    line: cache.line,
    impact: "low",
    message: "`actions/setup-go` caching is explicitly disabled with `cache: false`.",
    suggestion: "Remove `cache: false` (setup-go caches modules and build outputs by default) unless another step caches them."
  };
}
function checkDotnet(project, step, all) {
  if (step.with.has("cache")) return void 0;
  if (!filePaths(project).some((path) => basename(path) === "packages.lock.json") || covered2(all, "nuget")) return void 0;
  return {
    managers: ["nuget"],
    message: "`actions/setup-dotnet` does not cache NuGet packages although packages.lock.json exists.",
    suggestion: "Add `cache: true` (and `cache-dependency-path` if the lock files are not found by the default glob)."
  };
}
function cacheFix(file, step, value) {
  if (!file) return void 0;
  const direct = [...step.with.values()].filter((entry) => entry.origin === "direct" && entry.line > step.line);
  if (direct.length === 0 || direct.length !== step.with.size) return void 0;
  const first = Math.min(...direct.map((entry) => entry.line));
  const text = lineText(file.content, first);
  if (!/^\s*[A-Za-z0-9_-]+\s*:/.test(text) || /[{}]/.test(text)) return void 0;
  let withLine;
  for (let line = first - 1; line >= step.line; line -= 1) {
    const candidate = lineText(file.content, line);
    if (/^\s*(-\s+)?with\s*:\s*(#.*)?$/.test(candidate)) {
      withLine = line;
      break;
    }
    if (candidate.trim() !== "" && !candidate.trim().startsWith("#")) return void 0;
  }
  if (withLine === void 0) return void 0;
  return fix(`Add \`cache: ${value}\``, insertLinesAfter(file, first - 1, [`${indentOf(file.content, first)}cache: ${value}`]));
}
var setup_cache_default = defineRule({
  meta: {
    id: "caching/setup-cache",
    ruleset: "caching",
    description: "Language setup actions should cache downloaded dependencies.",
    rationale: "Without caching, every run re-downloads all dependencies from the registry, which is often the slowest part of a job and is repeated on every agent iteration. setup-node, setup-python, setup-java and setup-dotnet only cache when `cache` is set (setup-node v6+ auto-caches npm only when package.json `packageManager` names npm); setup-go caches by default.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/setup-node#caching-global-packages-data",
      "https://github.com/actions/setup-python#caching-packages-dependencies",
      "https://github.com/actions/setup-java#caching-packages-dependencies",
      "https://github.com/actions/setup-go#caching-dependency-files-and-build-outputs",
      "https://github.com/actions/setup-dotnet#caching-nuget-packages"
    ],
    impact: "high",
    fixable: true,
    example: {
      bad: "- uses: actions/setup-node@v7\n  with:\n    node-version: 22",
      good: "- uses: actions/setup-node@v7\n  with:\n    cache: npm\n    node-version: 22"
    }
  },
  check({ project, report }) {
    const scan = (workflow) => {
      const file = project.files.get(workflow.path);
      for (const job of workflow.jobs) {
        const all = project.expandedSteps(job);
        for (const step of job.steps) {
          const before = all.slice(0, Math.max(0, all.indexOf(step)));
          let finding;
          if (usesAction(step, "actions/setup-node")) finding = checkNode(project, step, before, all, file);
          else if (usesAction(step, "actions/setup-python")) finding = checkPython(project, step, before, all);
          else if (usesAction(step, "actions/setup-java")) finding = checkJava(project, step, all);
          else if (usesAction(step, "actions/setup-go")) finding = checkGo(step, all);
          else if (usesAction(step, "actions/setup-dotnet")) finding = checkDotnet(project, step, all);
          if (!finding) continue;
          const autofix = finding.fixValue ? cacheFix(file, step, finding.fixValue) : void 0;
          report({
            path: workflow.path,
            line: finding.line ?? step.uses?.line ?? step.line,
            key: `${step.key}:no-cache`,
            message: finding.message,
            suggestion: finding.suggestion,
            ...finding.impact ? { impact: finding.impact } : {},
            ...autofix ? { fix: autofix } : {}
          });
        }
      }
    };
    for (const workflow of [...project.workflows, ...project.actions]) scan(workflow);
  }
});

// src/lint/rules/caching/index.ts
var rules2 = [build_tool_cache_default, cache_key_default, docker_layer_cache_default, setup_cache_default];

// src/lint/rules/checkout/affected-base-ref.ts
var GIT_FETCH = /\bgit\s+(?:fetch|pull)\b/;
function isSelfCheckout(step) {
  if (step.uses?.action.name !== "actions/checkout") return false;
  const repository = step.with.get("repository");
  return !repository || repository.kind !== "literal" && /github\.repository\b/.test(String(repository.value));
}
function isShallow(step) {
  const depth = step.with.get("fetch-depth");
  return !depth || depth.kind === "literal" && (depth.value === 1 || depth.value === "1");
}
function hasNoBase(command, tool2) {
  const text = command.replace(/["']/g, "");
  if (tool2 === "jest --onlyChanged") return true;
  if (tool2 === "vitest --changed") return !/\s--changed(?:=\S+|\s+(?!-)\S+)/.test(text);
  return false;
}
var affected_base_ref_default = defineRule({
  meta: {
    id: "checkout/affected-base-ref",
    ruleset: "checkout",
    description: "Affected/changed-only commands need the base commit, which a default shallow checkout does not fetch.",
    rationale: "`actions/checkout` fetches a single commit by default. Affected-only tooling (nx affected, turbo --affected, pnpm/turbo `[ref]` filters, jest --changedSince, git diff against the base) then either fails with an unknown revision or silently falls back to running everything, which defeats the selection that makes agent-scale CI affordable.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/checkout#fetch-all-history-for-all-tags-and-branches",
      "https://nx.dev/docs/features/ci-features/affected",
      "https://github.com/nrwl/nx-set-shas",
      "https://turborepo.com/docs/reference/run#--affected"
    ],
    impact: "high",
    example: {
      bad: "- uses: actions/checkout@v7\n- run: npx nx affected -t test",
      good: "- uses: actions/checkout@v7\n  with:\n    fetch-depth: 0\n    filter: blob:none\n- uses: nrwl/nx-set-shas@v5\n- run: npx nx affected -t test"
    }
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      for (const job of workflow.jobs) {
        if (job.uses) continue;
        const expanded = expandedJobSteps(project, workflow, job);
        if (expanded.some(({ step }) => step.uses?.action.name === "nrwl/nx-set-shas")) continue;
        let checkout;
        let fetched = false;
        for (const entry of expanded) {
          if (isSelfCheckout(entry.step)) {
            checkout = entry;
            fetched = false;
          }
          for (const { command, line } of commandsOf(entry.step)) {
            if (GIT_FETCH.test(command)) fetched = true;
            const tool2 = affectedTooling(command);
            if (!tool2 || !checkout || fetched || !isShallow(checkout.step)) continue;
            const noBase = hasNoBase(command, tool2);
            const nxHint = tool2 === "nx affected" ? " For Nx, also add `nrwl/nx-set-shas@v5` after checkout so NX_BASE is the last successful default-branch commit." : "";
            report({
              path: entry.path,
              line,
              key: `${entry.owner.key}:${tool2}`,
              message: noBase ? `\`${tool2}\` without a base ref compares against uncommitted changes, so in a shallow CI checkout it selects nothing.` : `\`${tool2}\` needs the base commit, but actions/checkout only fetched one commit (default fetch-depth: 1), so it fails or treats everything as changed.`,
              suggestion: noBase ? "Pass an explicit base (for example `--changedSince=origin/${{ github.base_ref }}` or `--changed origin/${{ github.base_ref }}`) and fetch it first with `git fetch --no-tags --depth=<n> origin ${{ github.base_ref }}`, or set `fetch-depth: 0` with `filter: blob:none` on checkout." : `Fetch the base before this command: set \`fetch-depth: 0\` and \`filter: blob:none\` on actions/checkout (full history, file contents on demand), or run \`git fetch --no-tags --depth=<n> origin \${{ github.base_ref }}\` first.${nxHint}`,
              related: [{ path: checkout.path, line: checkout.step.uses?.line ?? checkout.step.line }],
              ...noBase ? { confidence: "medium" } : {}
            });
          }
        }
      }
    }
  }
});

// src/lint/rules/checkout/partial-clone.ts
var partial_clone_default = defineRule({
  meta: {
    id: "checkout/partial-clone",
    ruleset: "checkout",
    description: "Full-history checkouts (`fetch-depth: 0`) should use a blobless partial clone (`filter: blob:none`).",
    rationale: "`fetch-depth: 0` downloads every version of every file ever committed, which dominates checkout time in large or long-lived repositories. A blobless partial clone keeps the full commit graph that history-aware tools (affected detection, changelogs, versioning) need, and fetches file contents lazily only when a command reads them. Agent-driven repositories run many more jobs, so the saving compounds.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/checkout#usage",
      "https://github.blog/open-source/git/get-up-to-speed-with-partial-clone-and-shallow-clone/"
    ],
    impact: "medium",
    fixable: true,
    example: {
      bad: "- uses: actions/checkout@v7\n  with:\n    fetch-depth: 0",
      good: "- uses: actions/checkout@v7\n  with:\n    fetch-depth: 0\n    filter: blob:none"
    }
  },
  check({ project, report }) {
    for (const { workflow, step } of stepsUsing([...project.workflows, ...project.actions], "actions/checkout")) {
      const depth = step.with.get("fetch-depth");
      if (!depth || depth.kind !== "literal" || !(depth.value === 0 || depth.value === "0")) continue;
      if (step.with.has("filter") || step.with.has("sparse-checkout")) continue;
      const file = project.files.get(workflow.path);
      const version = actionVersion(step, file);
      const supportsFilter = !version || version.major > 4 || version.major === 4 && version.minor !== 0;
      const directLine = file && supportsFilter && depth.origin === "direct" && directWith(workflow, step) !== void 0 && /^\s*fetch-depth\s*:/.test(lineText(file.content, depth.line));
      report({
        path: workflow.path,
        line: depth.line,
        key: `${step.key}.with.filter`,
        message: "Checkout fetches the full history including every historical file version (fetch-depth: 0 without a filter).",
        suggestion: supportsFilter ? "Add `filter: blob:none` to keep the full commit history but download file contents only when a command needs them (for example `git diff` or `git blame` on old revisions)." : "Upgrade to a current actions/checkout major, which supports `filter: blob:none`, then add it to keep the full commit history while downloading file contents on demand.",
        ...directLine ? {
          fix: fix(
            "Add filter: blob:none",
            insertLinesAfter(file, depth.line, [`${indentOf(file.content, depth.line)}filter: blob:none`])
          )
        } : {}
      });
    }
  }
});

// src/lint/rules/checkout/sparse-checkout.ts
import { posix } from "node:path";
var SHARED_DIRS = [".yarn", "patches", "config", "configs", "tools"];
var INSTALL = /^(?:(?:npm\s+(?:ci|install|i)|pnpm\s+(?:install|i)|bun\s+install|yarn\s+install)(?:\s|$)|yarn(?:\s+--?[\w-]+(?:=\S+)?)*$)/;
var TRIVIAL = /^(?:echo|printf|cd|pushd|popd|export|set|unset|true|false|exit|sleep|ls|pwd|cat|mkdir|rm|cp|mv|touch|chmod|which|env|date|corepack|nvm|git\s+(?:config|status|log|rev-parse)|(?:npm|pnpm|yarn)\s+config|pnpm\s+store|[A-Za-z_][A-Za-z0-9_]*=)(?:\s|$)/;
var NEUTRAL_ACTION = /^(?:actions\/(?:setup-|cache|upload-artifact|download-artifact|github-script)|pnpm\/action-setup|oven-sh\/setup-bun|nrwl\/nx-set-shas|denoland\/setup-deno|astral-sh\/setup-uv|docker\/(?:setup-|login-action))/;
var WHOLE_REPO_ACTION = /codeql-action|super-linter|megalinter|gitleaks|trufflehog|sonarsource|sonarqube/;
var PATH_INPUTS = ["working-directory", "working_directory", "workdir", "path", "context", "directory", "project", "root", "cwd"];
function cleanPath(path) {
  if (path.includes("$") || path.startsWith("/") || path.startsWith("~")) return void 0;
  const normalized = posix.normalize(path).replace(/\/+$/, "");
  return normalized === ".." || normalized.startsWith("../") ? void 0 : normalized || ".";
}
function joinPath(cwd, path) {
  return cwd === void 0 ? void 0 : cleanPath(posix.join(cwd, path));
}
function packageAt(packages, path) {
  if (path === void 0) return void 0;
  return packages.filter((pkg) => path === pkg.dir || path.startsWith(`${pkg.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
}
function resolveSelector(packages, raw) {
  if (/^(?:\^?\.\.\.|!)/.test(raw) || /[[\]*?]/.test(raw)) return void 0;
  const selector = raw.replace(/\^?\.\.\.$/, "").replace(/^\{(.*)\}$/, "$1");
  const byName = packages.filter((pkg) => pkg.name === selector);
  if (byName.length === 1) return byName[0];
  const dir = cleanPath(selector);
  const byDir = packages.find((pkg) => pkg.dir === dir);
  if (byDir || selector.includes("/")) return byDir;
  const byBase = packages.filter((pkg) => posix.basename(pkg.dir) === selector);
  return byBase.length === 1 ? byBase[0] : void 0;
}
function selectorsOf(text) {
  const found = [];
  const collect = (pattern) => {
    for (const match2 of text.matchAll(pattern)) if (match2[1]) found.push(match2[1]);
  };
  if (/\b(?:pnpm|turbo)\b/.test(text)) collect(/(?:^|\s)(?:--filter|-F)(?:=|\s+)(\S+)/g);
  if (/^(?:npm|npx)\s/.test(text)) collect(/(?:^|\s)(?:--workspace|-w)(?:=|\s+)(\S+)/g);
  if (/\blerna\b/.test(text)) collect(/(?:^|\s)--scope(?:=|\s+)(\S+)/g);
  collect(/\byarn\s+workspace\s+(\S+)/g);
  collect(/\bnx\s+run\s+([^\s:]+):/g);
  return found.length > 0 ? found : void 0;
}
function commandScope(packages, text, cwd) {
  if (TRIVIAL.test(text) || INSTALL.test(text) || /\s--version$/.test(text)) return { kind: "neutral" };
  const selectors = selectorsOf(text);
  if (selectors) {
    const resolved = selectors.map((selector) => resolveSelector(packages, selector));
    const [first] = resolved;
    return first && resolved.every((pkg2) => pkg2 === first) ? { kind: "package", pkg: first } : { kind: "unscoped" };
  }
  const pkg = packageAt(packages, cwd);
  return pkg ? { kind: "package", pkg } : { kind: "unscoped" };
}
function actionScope(packages, step) {
  const name = step.uses?.action.name ?? "";
  if (NEUTRAL_ACTION.test(name)) return { kind: "neutral" };
  if (WHOLE_REPO_ACTION.test(name)) return { kind: "unscoped" };
  const inputs = PATH_INPUTS.flatMap((key) => {
    const input2 = step.with.get(key);
    return input2 ? [input2] : [];
  });
  if (inputs.length === 0) return { kind: "neutral" };
  const pkgs = inputs.map(
    (input2) => input2.kind === "literal" && typeof input2.value === "string" ? packageAt(packages, cleanPath(input2.value)) : void 0
  );
  const [first] = pkgs;
  return first && pkgs.every((pkg) => pkg === first) ? { kind: "package", pkg: first } : { kind: "unscoped" };
}
function withDependencies(packages, root) {
  const byName = new Map(packages.flatMap((pkg) => pkg.name ? [[pkg.name, pkg]] : []));
  const seen = /* @__PURE__ */ new Set([root]);
  const queue = [root];
  for (let pkg = queue.shift(); pkg; pkg = queue.shift()) {
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const dependency = byName.get(name);
      if (dependency && !seen.has(dependency)) {
        seen.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return [...seen].map((pkg) => pkg.dir);
}
var sparse_checkout_default = defineRule({
  meta: {
    id: "checkout/sparse-checkout",
    ruleset: "checkout",
    description: "Jobs that only work inside one workspace package of a large monorepo can use a sparse checkout.",
    rationale: "In large monorepos most of the checkout is files a package-scoped job never reads. A cone-mode sparse checkout of the package, its workspace dependencies, and shared config keeps checkout and disk usage proportional to the job, which adds up when agents trigger many small package-level runs.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: ["repository"],
    defaultOptions: { minWorkspacePackages: 3 },
    validateOptions: (options) => Object.entries(options).filter(([, value]) => typeof value !== "number" || !Number.isInteger(value) || value < 2).map(([key]) => `${key} must be an integer of at least 2`),
    references: [
      "https://github.com/actions/checkout#fetch-only-a-single-file",
      "https://git-scm.com/docs/git-sparse-checkout#_internalscone_mode_handling"
    ],
    impact: "medium",
    example: {
      bad: "- uses: actions/checkout@v7\n- run: pnpm --filter web test",
      good: "- uses: actions/checkout@v7\n  with:\n    sparse-checkout: |\n      packages/web\n      packages/ui\n- run: pnpm --filter web test"
    }
  },
  check({ project, options, report }) {
    const { isMonorepo, workspacePackages } = project.facts;
    if (isMonorepo.status !== "known" || !isMonorepo.value || workspacePackages.status !== "known") return;
    const packages = workspacePackages.value;
    if (packages.length < options.minWorkspacePackages) return;
    const repoPaths = [...project.files.keys()];
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      for (const job of workflow.jobs) {
        const expanded = expandedJobSteps(project, workflow, job);
        const checkouts = expanded.filter(({ step }) => step.uses?.action.name === "actions/checkout");
        const checkout = checkouts[0];
        if (checkouts.length !== 1 || !checkout?.direct || !checkout.step.uses) continue;
        if (["repository", "path", "sparse-checkout", "filter"].some((key) => checkout.step.with.has(key))) continue;
        const targets = /* @__PURE__ */ new Set();
        const actionDirs = /* @__PURE__ */ new Set();
        let unscoped = false;
        let wholeInstall = false;
        for (const { step, direct } of expanded) {
          if (step === checkout.step) continue;
          const action = step.uses?.action;
          if (action?.kind === "local") {
            const dir = cleanPath(action.raw);
            if (dir === void 0) unscoped = true;
            else actionDirs.add(dir);
            continue;
          }
          if (action) {
            const scope2 = actionScope(packages, step);
            if (scope2.kind === "unscoped") unscoped = true;
            if (scope2.kind === "package") targets.add(scope2.pkg);
            continue;
          }
          const base2 = direct ? step.workingDirectory ?? job.workingDirectory ?? workflow.workingDirectory : step.workingDirectory;
          let cwd = cleanPath(base2 ?? ".");
          for (const { command } of commandsOf(step)) {
            const text = command.replace(/["']/g, "");
            if (text.startsWith("(")) unscoped = true;
            const cd = /^cd\s+(\S+)$/.exec(text);
            if (cd?.[1] !== void 0) cwd = cd[1] === "-" ? void 0 : joinPath(cwd, cd[1]);
            if (INSTALL.test(text) && !/\s(?:--filter|-F|--workspace|-w)\b|\bfocus\b/.test(text)) wholeInstall = true;
            const scope2 = commandScope(packages, text, cwd);
            if (scope2.kind === "unscoped") unscoped = true;
            if (scope2.kind === "package") targets.add(scope2.pkg);
          }
        }
        const [target] = targets;
        if (unscoped || !target || targets.size !== 1) continue;
        const dirs = [
          ...withDependencies(packages, target),
          ...actionDirs,
          ...SHARED_DIRS.filter((dir) => repoPaths.some((path) => path.startsWith(`${dir}/`)))
        ];
        const list3 = [...new Set(dirs)].map((dir) => `      ${dir}`).join("\n");
        const installNote = wholeInstall ? "\nThe job installs dependencies for the whole workspace, so scope the install too (for example `pnpm install --filter <name>...` or `yarn workspaces focus <name>`); other packages' manifests will be missing." : "";
        report({
          path: workflow.path,
          line: checkout.step.uses.line,
          key: `${checkout.step.key}.with.sparse-checkout`,
          message: `Job "${job.id}" checks out the whole monorepo but only works in ${target.dir}${target.name ? ` (${target.name})` : ""}.`,
          suggestion: `Check out only what the job needs; cone mode always includes root-level files such as package.json, lockfiles and tool configs:
  with:
    sparse-checkout: |
${list3}${installNote}`,
          confidence: "medium"
        });
      }
    }
  }
});

// src/lint/rules/checkout/index.ts
var rules3 = [affected_base_ref_default, partial_clone_default, sparse_checkout_default];

// src/lint/rules/containers/docker.ts
var WRAPPERS = /* @__PURE__ */ new Set(["sudo", "then", "do", "else", "elif", "if", "while", "until", "!", "exec", "time", "command", "nohup", "{", "env"]);
var ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*/;
function lineAt(content, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}
function blank(text) {
  return text.replace(/[^\r\n]/g, " ");
}
function escapeOf(content) {
  const directive = /^#\s*escape\s*=\s*(`|\\)/im.exec(content.split(/\r?\n/).slice(0, 5).join("\n"));
  return directive?.[1] ?? "\\";
}
function unquote(word) {
  return word.replace(/^(["'])(.*)\1$/, "$2");
}
function splitShell(script, base2) {
  const result = [];
  let quote2;
  let start = 0;
  const push = (end) => {
    const piece = script.slice(start, end);
    const lead = piece.length - piece.trimStart().length;
    const text = piece.trim();
    if (text) result.push({ text, offset: base2 + start + lead });
  };
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index] ?? "";
    if (quote2) {
      if (char === quote2) quote2 = void 0;
      else if (char === "\\" && quote2 === '"') index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote2 = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(script[index - 1] ?? ""))) {
      push(index);
      const newline2 = script.indexOf("\n", index);
      index = newline2 < 0 ? script.length : newline2;
      start = index + 1;
      continue;
    }
    if ("&|;\n()".includes(char)) {
      push(index);
      const next = script[index + 1];
      if ((char === "&" || char === "|") && next === char) index += 1;
      start = index + 1;
    }
  }
  push(script.length);
  return result;
}
function toCommand(content, piece, fallbackLine) {
  let text = piece.text;
  let offset = piece.offset;
  for (; ; ) {
    const assignment = ASSIGNMENT.exec(text);
    if (assignment && assignment[0].length < text.length) {
      text = text.slice(assignment[0].length);
      offset += assignment[0].length;
      continue;
    }
    const first = /^(\S+)\s+/.exec(text);
    if (first?.[1] && WRAPPERS.has(first[1])) {
      text = text.slice(first[0].length);
      offset += first[0].length;
      continue;
    }
    break;
  }
  const words2 = text.split(/\s+/).filter(Boolean).map(unquote);
  if (words2.length === 0) return void 0;
  const known2 = content !== void 0 && offset >= 0;
  return { text, words: words2, line: known2 ? lineAt(content, offset) : fallbackLine, offset: known2 ? offset : -1 };
}
function shellCommands(file, instruction) {
  if (instruction.keyword !== "RUN") return [];
  if (!file) {
    return splitShell(instruction.args, 0).map((piece) => toCommand(void 0, { ...piece, offset: -1 }, instruction.line)).filter((command) => command !== void 0);
  }
  const content = file.content;
  const start = lineStart(content, instruction.line);
  const end = lineStart(content, instruction.endLine + 1);
  const escape = escapeOf(content);
  let raw = content.slice(start, end);
  const rawLines = raw.split("\n");
  raw = rawLines.map((line, index) => {
    const eol = index === rawLines.length - 1 ? "" : "\n";
    return index > 0 && line.trim().startsWith("#") ? blank(line) + (eol ? " " : "") : line + eol;
  }).join("");
  const continuation = new RegExp(`${escape === "\\" ? "\\\\" : "`"}[ \\t]*\\r?\\n`, "g");
  raw = raw.replace(continuation, (match2) => " ".repeat(match2.length));
  let cursor = /^\s*RUN\s+/i.exec(raw)?.[0].length ?? 0;
  for (; ; ) {
    const flag = /^--[a-z-]+(?:=(?:"[^"]*"|\S+))?\s*/i.exec(raw.slice(cursor));
    if (!flag) break;
    cursor += flag[0].length;
  }
  const rest = raw.slice(cursor);
  if (rest.trimStart().startsWith("[")) {
    try {
      const parsed = JSON.parse(rest.trim());
      if (Array.isArray(parsed) && parsed.every((word) => typeof word === "string")) {
        const words2 = parsed;
        if (/^(ba|da)?sh$/.test(words2[0]?.split("/").pop() ?? "") && words2[1] === "-c" && words2[2] !== void 0) {
          return splitShell(words2[2], 0).map((piece) => toCommand(void 0, { ...piece, offset: -1 }, instruction.line)).filter((command) => command !== void 0);
        }
        return words2.length > 0 ? [{ text: words2.join(" "), words: words2, line: instruction.line, offset: -1 }] : [];
      }
    } catch {
    }
  }
  const segments = [];
  const heredoc = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/.exec(rest);
  if (heredoc?.[1]) {
    const prefix = rest.slice(0, heredoc.index);
    const bodyStart = rest.indexOf("\n", heredoc.index);
    if (bodyStart >= 0) {
      const lines = rest.slice(bodyStart + 1).split("\n");
      let length = 0;
      for (const line of lines) {
        if (line.trim() === heredoc[1]) break;
        length += line.length + 1;
      }
      const body = rest.slice(bodyStart + 1, bodyStart + 1 + length);
      if (prefix.trim() === "" || /^(ba|da)?sh(\s+-\S+)*$/.test(prefix.trim())) {
        segments.push({ text: body, offset: start + cursor + bodyStart + 1 });
      } else {
        segments.push({ text: prefix, offset: start + cursor });
      }
    } else {
      segments.push({ text: prefix, offset: start + cursor });
    }
  } else {
    segments.push({ text: rest, offset: start + cursor });
  }
  return segments.flatMap(
    (segment) => splitShell(segment.text, segment.offset).map((piece) => toCommand(content, piece, instruction.line)).filter((command) => command !== void 0)
  );
}
var VALUE_FLAGS = /* @__PURE__ */ new Set(["--omit", "--include", "--workspace", "-w", "--prefix", "--cache", "--registry", "--loglevel", "--install-strategy"]);
function positionals(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg.startsWith("-")) {
      if (VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}
function normalizePython(words2) {
  if (/^python[\d.]*$/.test(words2[0] ?? "") && words2[1] === "-m" && /^pip[\d.]*$/.test(words2[2] ?? "")) {
    return ["pip", ...words2.slice(3)];
  }
  if (/^pip[\d.]*$/.test(words2[0] ?? "")) return ["pip", ...words2.slice(1)];
  return words2;
}
function hasRequirementFile(args) {
  return args.some((arg) => arg === "-r" || arg === "--requirement" || /^-r\S/.test(arg) || arg.startsWith("--requirement="));
}
function tool(word) {
  return (word ?? "").split("/").pop() ?? "";
}
function dependencyInstall(input2) {
  const words2 = normalizePython(input2);
  const [head, verb, ...rest] = words2;
  const name = tool(head);
  switch (name) {
    case "npm":
      if (verb === "ci") return "npm";
      if ((verb === "install" || verb === "i") && !rest.some((arg) => arg === "-g" || arg === "--global")) {
        return positionals(rest).length === 0 ? "npm" : void 0;
      }
      return void 0;
    case "pnpm":
      if (verb === "fetch") return "pnpm";
      if ((verb === "install" || verb === "i") && !rest.some((arg) => arg === "-g" || arg === "--global")) return "pnpm";
      return void 0;
    case "yarn":
      if (verb === void 0 || verb === "install" || verb.startsWith("-")) return "yarn";
      return void 0;
    case "bun":
      return (verb === "install" || verb === "i") && positionals(rest).length === 0 && !rest.includes("-g") ? "bun" : void 0;
    case "pip":
      return verb === "install" && hasRequirementFile(rest) ? "pip" : void 0;
    case "poetry":
      return verb === "install" ? "poetry" : void 0;
    case "uv":
      if (verb === "sync") return "uv";
      if (verb === "pip" && (rest[0] === "sync" || rest[0] === "install" && hasRequirementFile(rest.slice(1)))) return "uv";
      return void 0;
    case "go":
      return verb === "mod" && rest[0] === "download" ? "go" : void 0;
    case "bundle":
      return verb === "install" ? "bundler" : void 0;
    case "cargo":
      return verb === "fetch" || verb === "build" ? "cargo" : void 0;
    case "mvn":
    case "mvnw":
      return [verb, ...rest].some((arg) => /^(dependency:(go-offline|resolve)|package|install|verify)$/.test(arg ?? "")) ? "maven" : void 0;
    case "gradle":
    case "gradlew":
      return [verb, ...rest].includes("dependencies") ? "gradle" : void 0;
    case "dotnet":
      return verb === "restore" ? "dotnet" : void 0;
    case "composer":
      return verb === "install" ? "composer" : void 0;
    default:
      return void 0;
  }
}
function toolchainBuild(words2) {
  const [head, verb, ...rest] = words2;
  const name = tool(head);
  if (name === "go" && verb === "build") return "go build";
  if (name === "cargo" && verb === "build") return "cargo build";
  if ((name === "mvn" || name === "mvnw") && [verb, ...rest].some((arg) => arg === "package" || arg === "install" || arg === "verify")) {
    return "mvn package";
  }
  if ((name === "gradle" || name === "gradlew") && [verb, ...rest].some((arg) => /^(:?[\w-]+:)*(build|assemble|bootJar|shadowJar|installDist)$/.test(arg ?? ""))) {
    return "gradle build";
  }
  if (name === "dotnet" && (verb === "publish" || verb === "build")) return `dotnet ${verb}`;
  return void 0;
}
function systemInstall(words2) {
  const name = tool(words2[0]);
  let verbIndex = -1;
  for (let index = 1; index < words2.length; index += 1) {
    const word = words2[index] ?? "";
    if (word === "-o" || word === "-c" || word === "-t" || word === "-X" || word === "--repository") {
      index += 1;
      continue;
    }
    if (!word.startsWith("-")) {
      verbIndex = index;
      break;
    }
  }
  const verb = words2[verbIndex];
  if ((name === "apt-get" || name === "apt") && verb === "install") {
    return { installer: "apt", verbIndex, packages: words2.slice(verbIndex + 1).filter((word) => !word.startsWith("-")) };
  }
  if (name === "apk" && verb === "add") {
    const packages = [];
    const rest = words2.slice(verbIndex + 1);
    for (let index = 0; index < rest.length; index += 1) {
      const word = rest[index] ?? "";
      if (word === "-t" || word === "--virtual" || word === "-X" || word === "--repository") {
        index += 1;
        continue;
      }
      if (!word.startsWith("-")) packages.push(word);
    }
    return { installer: "apk", verbIndex, packages };
  }
  return void 0;
}
function cacheMounts(instruction) {
  const mounts = [];
  for (const value of instruction.flags.get("mount") ?? []) {
    const options = /* @__PURE__ */ new Map();
    for (const part of value.split(",")) {
      const [key, ...rest] = part.split("=");
      if (key) options.set(key.trim().toLowerCase(), rest.join("=").trim());
    }
    if (options.get("type") !== "cache") continue;
    const target = options.get("target") ?? options.get("dst") ?? options.get("destination");
    if (target === void 0) continue;
    const sharing = options.get("sharing");
    const id = options.get("id");
    mounts.push({ target, ...sharing !== void 0 ? { sharing } : {}, ...id !== void 0 ? { id } : {} });
  }
  return mounts;
}
function contextSources(instruction) {
  if (instruction.keyword !== "COPY" && instruction.keyword !== "ADD") return void 0;
  if (instruction.flags.has("from")) return void 0;
  const args = instruction.args.trim();
  if (args.startsWith("<<")) return void 0;
  let parts = [];
  if (args.startsWith("[")) {
    try {
      const parsed = JSON.parse(args);
      if (Array.isArray(parsed)) parts = parsed.map(String);
    } catch {
      parts = args.split(/\s+/);
    }
  } else {
    parts = args.split(/\s+/).filter(Boolean);
  }
  return parts.length >= 2 ? parts.slice(0, -1).map(unquote) : void 0;
}
function isBroadCopy(instruction) {
  const sources = contextSources(instruction);
  return sources !== void 0 && sources.some((source) => /^(\.\/?|\.\/\*|\*)$/.test(source));
}
function stageLabel(stage) {
  return stage.name ?? String(stage.index);
}
function hasSyntaxDirective(file) {
  if (!file) return true;
  for (const line of file.content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("#")) return false;
    if (/^#\s*syntax\s*=/i.test(trimmed)) return true;
  }
  return false;
}
function registryHost(reference) {
  const first = reference.split("/")[0] ?? "";
  if (reference.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")) {
    return first.toLowerCase();
  }
  return "docker.io";
}
function isDockerHub(host) {
  return ["docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com"].includes(host);
}
function isInternalBase(model, stage) {
  if (stage.image === "scratch" || stage.image.includes("$")) return true;
  return model.stages.some((other) => other.index < stage.index && other.name !== void 0 && other.name.toLowerCase() === stage.image.toLowerCase());
}
function fileOf(project, model) {
  return project.files.get(model.path);
}
function workdirBefore(stage, instruction) {
  let workdir;
  for (const candidate of stage.instructions) {
    if (candidate === instruction) break;
    if (candidate.keyword === "WORKDIR") {
      const value = candidate.args.trim().replace(/^"|"$/g, "");
      if (value.includes("$")) workdir = void 0;
      else if (value.startsWith("/")) workdir = value;
      else workdir = workdir !== void 0 ? `${workdir.replace(/\/$/, "")}/${value}` : void 0;
    }
  }
  return workdir;
}

// src/lint/rules/containers/apt-hygiene.ts
function isApt(command) {
  const name = command.words[0]?.split("/").pop();
  return name === "apt-get" || name === "apt";
}
function aptVerb(command) {
  if (!isApt(command)) return void 0;
  for (let index = 1; index < command.words.length; index += 1) {
    const word = command.words[index] ?? "";
    if (word === "-o" || word === "-c" || word === "-t") {
      index += 1;
      continue;
    }
    if (!word.startsWith("-")) return word;
  }
  return void 0;
}
function removes(command, prefix) {
  return command.words[0] === "rm" && command.words.some((word) => word.startsWith(prefix));
}
function runsScript(command) {
  const head = command.words[0] ?? "";
  return /^(ba|da)?sh$|^source$|^\.$/.test(head) || head.startsWith("./") || /\.sh$/.test(head);
}
var NO_RECOMMENDS = /^--no-install-recommends$|^APT::Install-Recommends=(false|0|"0"|"false")$/i;
var apt_hygiene_default = defineRule({
  meta: {
    id: "containers/apt-hygiene",
    ruleset: "containers",
    description: "apt and apk installs in Dockerfiles should skip recommended packages, update and install in one layer, and not leave package caches in the image.",
    rationale: "Recommended packages and leftover package indexes add tens of megabytes to every layer that is pushed, pulled, and cached. `apt-get update` in its own RUN creates a layer that BuildKit keeps reusing, so later installs run against a stale index (or fail). Smaller layers mean faster pulls on every ephemeral CI runner and agent sandbox.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/building/best-practices/#apt-get",
      "https://docs.docker.com/build/cache/optimize/#use-cache-mounts",
      "https://wiki.alpinelinux.org/wiki/Alpine_Package_Keeper#Local_Cache"
    ],
    impact: "low",
    fixable: true,
    example: {
      bad: "FROM debian:bookworm-slim\nRUN apt-get update\nRUN apt-get install -y curl",
      good: "FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*"
    }
  },
  check({ project, report }) {
    for (const model of project.dockerfiles) {
      const file = fileOf(project, model);
      const recommendsConfigured = /Install-Recommends\s*["']?\s*(false|0|"0")/i.test(file?.content ?? "");
      for (const stage of model.stages) {
        let ordinal = -1;
        for (const instruction of stage.instructions) {
          if (instruction.keyword !== "RUN") continue;
          ordinal += 1;
          const prefix = `stage:${stageLabel(stage)}:run[${ordinal}]`;
          const commands = shellCommands(file, instruction);
          const mounts = cacheMounts(instruction);
          const aptCached = mounts.some((mount) => /^\/var\/(lib|cache)\/apt/.test(mount.target));
          const apkCached = mounts.some((mount) => /^\/(var\/cache\/apk|etc\/apk\/cache)/.test(mount.target));
          const verbs = commands.map(aptVerb);
          const updates = commands.filter((_, index) => verbs[index] === "update");
          const installs = commands.filter((_, index) => ["install", "upgrade", "dist-upgrade", "full-upgrade"].includes(verbs[index] ?? ""));
          for (const command of commands) {
            const install = systemInstall(command.words);
            if (!install) continue;
            if (install.installer === "apt") {
              if (!recommendsConfigured && !command.words.some((word) => NO_RECOMMENDS.test(word))) {
                let edit;
                if (file && command.offset >= 0) {
                  const tokens = [...command.text.matchAll(/\S+/g)];
                  const verb = tokens[install.verbIndex];
                  if (verb?.index !== void 0) {
                    const at = command.offset + verb.index + verb[0].length;
                    if (!file.content.slice(command.offset, at).includes("\n")) {
                      edit = { path: model.path, start: at, end: at, text: " --no-install-recommends" };
                    }
                  }
                }
                report({
                  path: model.path,
                  line: command.line,
                  key: `${prefix}:install-recommends`,
                  message: `\`${command.words.slice(0, install.verbIndex + 1).join(" ")}\` installs recommended packages too, adding unrequested packages to the layer.`,
                  suggestion: "Add `--no-install-recommends` and list any recommended package you actually need (for example `ca-certificates`) explicitly.",
                  fix: fix("Add --no-install-recommends (list needed recommended packages such as ca-certificates explicitly)", edit)
                });
              }
              if (updates.length > 0 && !aptCached && !commands.some((other) => removes(other, "/var/lib/apt/lists"))) {
                report({
                  path: model.path,
                  line: command.line,
                  key: `${prefix}:apt-lists`,
                  message: "This RUN downloads apt package lists but does not delete them, leaving `/var/lib/apt/lists` in the layer.",
                  suggestion: "End the same RUN with `&& rm -rf /var/lib/apt/lists/*`, or keep the lists out of the image with `RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked`."
                });
              }
            } else if (!command.words.includes("--no-cache") && !apkCached && !commands.some((other) => removes(other, "/var/cache/apk"))) {
              report({
                path: model.path,
                line: command.line,
                key: `${prefix}:apk-no-cache`,
                message: `\`${command.words.slice(0, install.verbIndex + 1).join(" ")}\` without \`--no-cache\` leaves the apk index cache in the layer.`,
                suggestion: "Use `apk add --no-cache ...` (it also makes a separate `apk update` unnecessary), or cache-mount `/var/cache/apk` with BuildKit."
              });
            }
          }
          if (updates.length > 0 && installs.length === 0 && !commands.some(runsScript)) {
            const [update] = updates;
            if (!update) continue;
            report({
              path: model.path,
              line: update.line,
              key: `${prefix}:update-without-install`,
              message: "`apt-get update` runs in a RUN without an install, so its layer is cached separately and later installs can use a stale package index.",
              suggestion: "Combine update and install in one RUN: `RUN apt-get update && apt-get install -y --no-install-recommends <packages> && rm -rf /var/lib/apt/lists/*`."
            });
          }
        }
      }
    }
  }
});

// src/lint/rules/containers/cache-mount.ts
var SPECS = {
  npm: { label: "npm", needs: [{ pattern: /\.npm\/?$/, mount: () => "--mount=type=cache,target=/root/.npm" }] },
  pnpm: {
    label: "pnpm",
    needs: [{ pattern: /pnpm/, mount: () => "--mount=type=cache,id=pnpm,target=/pnpm/store", note: "Set `ENV PNPM_HOME=/pnpm` so the store lives under the mount." }]
  },
  yarn: {
    label: "Yarn",
    needs: [{ pattern: /yarn/, mount: () => "--mount=type=cache,target=/usr/local/share/.cache/yarn", note: "For Yarn Berry mount `/root/.yarn/berry/cache` instead." }]
  },
  bun: { label: "Bun", needs: [{ pattern: /\.bun/, mount: () => "--mount=type=cache,target=/root/.bun/install/cache" }] },
  pip: { label: "pip", needs: [{ pattern: /pip/, mount: () => "--mount=type=cache,target=/root/.cache/pip" }] },
  poetry: { label: "Poetry", needs: [{ pattern: /pypoetry|poetry/, mount: () => "--mount=type=cache,target=/root/.cache/pypoetry" }] },
  uv: { label: "uv", needs: [{ pattern: /(^|\/)uv\/?$|\.cache\/uv/, mount: () => "--mount=type=cache,target=/root/.cache/uv" }] },
  "go-mod": { label: "Go modules", needs: [{ pattern: /pkg\/mod/, mount: () => "--mount=type=cache,target=/go/pkg/mod" }] },
  "go-build": {
    label: "Go build",
    needs: [
      { pattern: /pkg\/mod/, mount: () => "--mount=type=cache,target=/go/pkg/mod" },
      { pattern: /go-build/, mount: () => "--mount=type=cache,target=/root/.cache/go-build" }
    ]
  },
  "cargo-fetch": {
    label: "Cargo registry",
    needs: [{ pattern: /cargo\/registry/, mount: () => "--mount=type=cache,target=/usr/local/cargo/registry" }]
  },
  "cargo-build": {
    label: "Cargo",
    needs: [
      { pattern: /cargo\/registry/, mount: () => "--mount=type=cache,target=/usr/local/cargo/registry" },
      {
        pattern: /(^|\/)target\/?$/,
        mount: (workdir) => `--mount=type=cache,target=${workdir ? `${workdir.replace(/\/$/, "")}/target` : "<workdir>/target"}`,
        note: "A cached target/ is not part of the layer: copy the built binary out of it in the same RUN."
      }
    ]
  },
  maven: { label: "Maven", needs: [{ pattern: /\.m2/, mount: () => "--mount=type=cache,target=/root/.m2" }] },
  gradle: { label: "Gradle", needs: [{ pattern: /\.gradle/, mount: () => "--mount=type=cache,target=/root/.gradle" }] },
  dotnet: { label: "NuGet", needs: [{ pattern: /nuget/i, mount: () => "--mount=type=cache,target=/root/.nuget/packages" }] },
  apt: {
    label: "apt",
    needs: [
      { pattern: /^\/var\/cache\/apt/, mount: () => "--mount=type=cache,target=/var/cache/apt,sharing=locked" },
      { pattern: /^\/var\/lib\/apt/, mount: () => "--mount=type=cache,target=/var/lib/apt,sharing=locked" }
    ]
  }
};
var KNOWN_TARGETS = Object.values(SPECS).flatMap((spec) => spec.needs.map((need) => need.pattern));
function cacheTool(command) {
  const install = dependencyInstall(command.words);
  if (install === "go") return "go-mod";
  if (install === "cargo") return command.words[1] === "build" ? "cargo-build" : "cargo-fetch";
  if (install === "bundler" || install === "composer") return void 0;
  if (install) return install;
  const build = toolchainBuild(command.words);
  if (build === "go build") return "go-build";
  if (build === "cargo build") return "cargo-build";
  if (build === "mvn package") return "maven";
  if (build === "gradle build") return "gradle";
  if (build?.startsWith("dotnet")) return "dotnet";
  if (systemInstall(command.words)?.installer === "apt") return "apt";
  return void 0;
}
function runsAsNonRoot(stage, instruction) {
  let user;
  for (const candidate of stage.instructions) {
    if (candidate === instruction) break;
    if (candidate.keyword === "USER") user = candidate.args.trim();
  }
  return user !== void 0 && !/^(root|0)(:|$)/.test(user);
}
function missingMounts(spec, mounts) {
  return spec.needs.filter((need) => !mounts.some((mount) => need.pattern.test(mount.target)));
}
var cache_mount_default = defineRule({
  meta: {
    id: "containers/cache-mount",
    ruleset: "containers",
    description: "Dependency installs and compiles in Dockerfiles should use BuildKit cache mounts for package-manager and compiler caches.",
    rationale: "When a dependency layer is invalidated, a cache mount (`RUN --mount=type=cache`) lets the package manager reuse previously downloaded packages and compiler output instead of fetching everything again, and keeps those caches out of the image. Cache mounts live in the builder, so on ephemeral hosted runners pair them with a persistent builder or export them (for example with buildkit-cache-dance) to benefit across CI runs.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/cache/optimize/#use-cache-mounts",
      "https://docs.docker.com/reference/dockerfile/#run---mounttypecache",
      "https://docs.docker.com/build/ci/github-actions/cache/#cache-mounts",
      "https://pnpm.io/docker"
    ],
    impact: "medium",
    example: {
      bad: "FROM node:22-slim\nCOPY package.json package-lock.json ./\nRUN npm ci",
      good: "# syntax=docker/dockerfile:1\nFROM node:22-slim\nCOPY package.json package-lock.json ./\nRUN --mount=type=cache,target=/root/.npm npm ci"
    }
  },
  check({ project, report }) {
    for (const model of project.dockerfiles) {
      const file = fileOf(project, model);
      const syntax = hasSyntaxDirective(file) ? "" : " Cache mounts need the Dockerfile frontend 1.2+; add `# syntax=docker/dockerfile:1` as the first line.";
      for (const stage of model.stages) {
        if (/windows|nanoserver|servercore/i.test(`${stage.image}:${stage.tag ?? ""}`)) continue;
        let ordinal = -1;
        for (const instruction of stage.instructions) {
          if (instruction.keyword !== "RUN") continue;
          ordinal += 1;
          const mounts = cacheMounts(instruction);
          if (mounts.some((mount) => !KNOWN_TARGETS.some((pattern) => pattern.test(mount.target)))) continue;
          const seen = /* @__PURE__ */ new Set();
          for (const command of shellCommands(file, instruction)) {
            const tool2 = cacheTool(command);
            if (!tool2 || seen.has(tool2)) continue;
            seen.add(tool2);
            const spec = SPECS[tool2];
            if (!spec) continue;
            const missing = missingMounts(spec, mounts);
            if (missing.length === 0) continue;
            const workdir = workdirBefore(stage, instruction) ?? "";
            const nonRoot = runsAsNonRoot(stage, instruction) ? " This stage runs as a non-root USER: point the target at that user's home and add `uid=`/`gid=` to the mount." : "";
            const apt = tool2 === "apt" ? " Also remove `/etc/apt/apt.conf.d/docker-clean` first so downloaded .deb files stay in the cache." : "";
            const noCache = command.words.includes("--no-cache-dir") ? " Drop `--no-cache-dir` once the cache is mounted." : "";
            report({
              path: model.path,
              line: command.line,
              key: `stage:${stageLabel(stage)}:run[${ordinal}]:${tool2}`,
              message: `\`${command.words.slice(0, 3).join(" ")}\` runs without a BuildKit cache mount, so every rebuild of this layer downloads ${tool2 === "apt" ? "packages" : "dependencies"} from scratch instead of reusing the ${spec.label} cache.`,
              suggestion: `Use \`RUN ${missing.map((need) => need.mount(workdir)).join(" ")} ${command.words.slice(0, 3).join(" ")} ...\`.${missing.map((need) => need.note ? ` ${need.note}` : "").join("")}${apt}${noCache}${nonRoot}${syntax}`
            });
          }
        }
      }
    }
  }
});

// src/lint/rules/containers/dependency-layer.ts
var LAYERING = {
  npm: "`COPY package.json package-lock.json ./`, `RUN npm ci`, then `COPY . .`",
  pnpm: "`COPY pnpm-lock.yaml pnpm-workspace.yaml ./` and `RUN pnpm fetch` (fills the store from the lockfile alone), then `COPY . .` and `RUN pnpm install --offline --frozen-lockfile`",
  yarn: "`COPY package.json yarn.lock .yarnrc.yml ./` (plus `.yarn/releases` for Yarn Berry), `RUN yarn install --immutable` (`--frozen-lockfile` on Yarn 1), then `COPY . .`",
  bun: "`COPY package.json bun.lock ./`, `RUN bun install --frozen-lockfile`, then `COPY . .`",
  pip: "`COPY requirements*.txt ./`, `RUN pip install -r requirements.txt`, then `COPY . .`",
  poetry: "`COPY pyproject.toml poetry.lock ./`, `RUN poetry install --no-root`, then `COPY . .` and install the project",
  uv: "`COPY pyproject.toml uv.lock ./`, `RUN uv sync --frozen --no-install-project`, then `COPY . .` and `RUN uv sync --frozen`",
  go: "`COPY go.mod go.sum ./`, `RUN go mod download`, then `COPY . .` and build",
  bundler: "`COPY Gemfile Gemfile.lock ./`, `RUN bundle install`, then `COPY . .`",
  cargo: "`COPY Cargo.toml Cargo.lock ./` and `RUN cargo fetch` (or pre-build dependencies with cargo-chef), then `COPY . .` and build",
  maven: "`COPY pom.xml ./`, `RUN mvn dependency:go-offline`, then `COPY src ./src` and package",
  gradle: "`COPY build.gradle* settings.gradle* gradle.properties gradle/ ./`, `RUN gradle dependencies`, then `COPY . .` and build",
  dotnet: "`COPY *.sln *.csproj NuGet.config ./`, `RUN dotnet restore`, then `COPY . .` and `dotnet publish --no-restore`",
  composer: "`COPY composer.json composer.lock ./`, `RUN composer install --no-scripts --no-autoloader`, then `COPY . .` and `composer dump-autoload`"
};
var JS = /* @__PURE__ */ new Set(["npm", "pnpm", "yarn", "bun"]);
function excerpt(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}
var dependency_layer_default = defineRule({
  meta: {
    id: "containers/dependency-layer",
    ruleset: "containers",
    description: "Dockerfiles should install dependencies from manifests and lockfiles before copying the rest of the source tree.",
    rationale: "BuildKit reuses a layer only while every input above it is unchanged. Copying the whole context before the install means each source edit (every agent iteration) re-downloads and re-installs all dependencies; copying only manifests and lockfiles first keeps the dependency layer cached until dependencies actually change.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/cache/optimize/#order-your-layers",
      "https://docs.docker.com/build/building/best-practices/",
      "https://pnpm.io/cli/fetch",
      "https://turborepo.com/docs/guides/tools/docker"
    ],
    impact: "high",
    example: {
      bad: "FROM node:22-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci\nRUN npm run build",
      good: "FROM node:22-slim\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build"
    }
  },
  check({ project, report }) {
    const turbo = project.facts.monorepoTools.value.includes("turbo");
    for (const model of project.dockerfiles) {
      const file = fileOf(project, model);
      const installedByStage = /* @__PURE__ */ new Map();
      for (const stage of model.stages) {
        const parent = installedByStage.get(stage.image.toLowerCase());
        const installed = new Set(parent ?? []);
        const pending = [];
        let ordinal = 0;
        for (const instruction of stage.instructions) {
          if (isBroadCopy(instruction)) {
            pending.push({ instruction, ordinal, installedBefore: new Set(installed), reported: false });
            ordinal += 1;
            continue;
          }
          if (instruction.keyword !== "RUN") continue;
          for (const command of shellCommands(file, instruction)) {
            const ecosystem = dependencyInstall(command.words);
            if (!ecosystem) continue;
            for (const copy of pending) {
              if (copy.reported || copy.installedBefore.has(ecosystem)) continue;
              copy.reported = true;
              const hint = turbo && JS.has(ecosystem) ? " In this Turborepo monorepo, `turbo prune <app> --docker` produces `out/json` (manifests) and `out/full` (sources) for exactly this split." : "";
              report({
                path: model.path,
                line: copy.instruction.line,
                key: `stage:${stageLabel(stage)}:copy[${copy.ordinal}]`,
                message: `\`${excerpt(`${copy.instruction.keyword} ${copy.instruction.args}`)}\` copies the whole build context before \`${excerpt(command.text)}\` (line ${command.line}), so every source change invalidates the ${ecosystem} dependency layer.`,
                suggestion: `Copy only manifests and lockfiles first: ${LAYERING[ecosystem]}.${hint}`,
                related: [{ path: model.path, line: command.line }]
              });
            }
            installed.add(ecosystem);
          }
        }
        if (stage.name) installedByStage.set(stage.name.toLowerCase(), installed);
      }
    }
  }
});

// src/lint/rules/containers/dockerignore.ts
function normalize2(path, base2 = "") {
  if (path.includes("$") || path.startsWith("/") || /^[a-z]+:\/\//i.test(path) || path === "-") return void 0;
  const parts = base2 ? base2.split("/") : [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return void 0;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}
function join(dir, name) {
  return dir ? `${dir}/${name}` : name;
}
function parentDirs(dir) {
  const parts = dir ? dir.split("/") : [];
  const result = [];
  for (let length = parts.length - 1; length >= 0; length -= 1) result.push(parts.slice(0, length).join("/"));
  return result;
}
var BUILD_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "-t",
  "--tag",
  "--build-arg",
  "--target",
  "--platform",
  "--cache-from",
  "--cache-to",
  "--label",
  "--secret",
  "--ssh",
  "-o",
  "--output",
  "--network",
  "--progress",
  "--builder",
  "--iidfile",
  "--metadata-file",
  "--add-host",
  "--build-context",
  "--shm-size",
  "--ulimit",
  "--annotation",
  "--attest",
  "--allow",
  "--call",
  "--cgroup-parent",
  "-m",
  "--memory",
  "--isolation"
]);
function parseDockerBuild(command, base2) {
  const words2 = command.split(/\s+/).filter(Boolean).map((word) => word.replace(/^(["'])(.*)\1$/, "$2"));
  const start = words2.findIndex(
    (word, index) => /^(docker|podman)$/.test(word) && (words2[index + 1] === "build" || ["buildx", "image"].includes(words2[index + 1] ?? "") && words2[index + 2] === "build")
  );
  if (start < 0) return void 0;
  const args = words2.slice(start + (words2[start + 1] === "build" ? 2 : 3));
  let file;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-f" || arg === "--file") {
      file = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--file=")) {
      file = arg.slice("--file=".length);
    } else if (BUILD_VALUE_FLAGS.has(arg)) {
      index += 1;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  const contextArg = positional[positional.length - 1];
  if (contextArg === void 0) return void 0;
  const context = normalize2(contextArg, base2);
  if (context === void 0) return void 0;
  const dockerfile = file !== void 0 ? normalize2(file, base2) : join(context, "Dockerfile");
  return dockerfile !== void 0 ? { dockerfile, context } : void 0;
}
function workflowBuilds(project) {
  const models = [...project.workflows, ...project.actions];
  const refs = [];
  for (const { step } of stepsUsing(models, "docker/build-push-action")) {
    const contextInput = withString(step, "context");
    const fileInput = withString(step, "file");
    const contextPath = contextInput === void 0 ? "" : contextInput.replace(/^\{\{\s*defaultContext\s*\}\}:?/, "");
    const context = normalize2(contextPath);
    if (context === void 0) continue;
    const dockerfile = fileInput !== void 0 ? normalize2(fileInput) : join(context, "Dockerfile");
    if (dockerfile !== void 0) refs.push({ dockerfile, context });
  }
  for (const { workflow, job, step } of steps(models)) {
    const base2 = normalize2(step.workingDirectory ?? job.workingDirectory ?? workflow.workingDirectory ?? "");
    if (base2 === void 0) continue;
    for (const { command } of commandsOf(step)) {
      const ref = parseDockerBuild(command, base2);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}
function patternRegex(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      source += (pattern[index] ?? "").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close < 0) {
        source += "\\[";
      } else {
        source += pattern.slice(index, close + 1).replace(/^\[!/, "[^");
        index = close;
      }
    } else {
      source += char.replace(/[.+^${}()|\\/]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`${source}$`);
  } catch {
    return /^\b$/;
  }
}
function isExcluded(content, path) {
  const candidates = path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"));
  let excluded = false;
  for (const raw of content.split(/\r?\n/)) {
    let pattern = raw.trim();
    if (pattern === "" || pattern.startsWith("#")) continue;
    const negated = pattern.startsWith("!");
    if (negated) pattern = pattern.slice(1).trim();
    pattern = pattern.replace(/^(\.?\/)+/, "").replace(/\/+$/, "");
    if (pattern === "") continue;
    const regex = patternRegex(pattern);
    if (candidates.some((candidate) => regex.test(candidate))) excluded = !negated;
  }
  return excluded;
}
function describeContext(context) {
  return context ? `\`${context}\`` : "the repository root";
}
var dockerignore_default = defineRule({
  meta: {
    id: "containers/dockerignore",
    ruleset: "containers",
    description: "Docker build contexts that are copied into images should have a .dockerignore excluding .git and node_modules.",
    rationale: "Without a .dockerignore, `COPY . .` sends and hashes the whole context, including `.git`, `node_modules`, and local build output. Every commit, install, or agent scratch file then changes the COPY checksum and invalidates that layer and everything after it, and large contexts slow down every build.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/concepts/context/#dockerignore-files",
      "https://docs.docker.com/build/cache/invalidation/"
    ],
    impact: "medium",
    example: {
      bad: "# no .dockerignore next to the Dockerfile\nFROM node:22-slim\nCOPY . .",
      good: "# .dockerignore\n.git\n**/node_modules\ndist"
    }
  },
  check({ project, report }) {
    const builds = workflowBuilds(project);
    const reportedIgnoreFiles = /* @__PURE__ */ new Set();
    for (const model of project.dockerfiles) {
      const copies = model.instructions.filter((instruction) => contextSources(instruction) !== void 0);
      if (copies.length === 0) continue;
      const broad = copies.find(isBroadCopy);
      const referenced = [...new Set(builds.filter((build) => build.dockerfile === model.path).map((build) => build.context))];
      let contexts = referenced;
      if (contexts.length === 0) {
        if (parentDirs(model.dir).some((dir) => project.files.has(join(dir, ".dockerignore")))) continue;
        contexts = [model.dir];
      }
      for (const context of contexts) {
        const ignorePath = [`${model.path}.dockerignore`, join(context, ".dockerignore")].find((path) => project.files.has(path));
        if (ignorePath === void 0) {
          const copy = broad ?? copies[0];
          if (!copy) continue;
          report({
            path: model.path,
            line: copy.line,
            key: `missing:${context || "."}`,
            message: `Build context ${describeContext(context)} has no .dockerignore, so \`${copy.keyword} ${copy.args.replace(/\s+/g, " ").trim()}\` sends and hashes everything in it, including \`.git\` and \`node_modules\`; unrelated changes bust this layer's cache.`,
            suggestion: `Add \`${join(context, ".dockerignore")}\` (or \`${model.path}.dockerignore\`) excluding at least \`.git\`, \`**/node_modules\`, build output (\`dist\`, \`coverage\`) and \`.env*\`; or use an allowlist: \`*\` followed by \`!src\`, \`!package.json\`, ...`,
            confidence: broad ? "high" : "medium"
          });
          continue;
        }
        if (!broad || reportedIgnoreFiles.has(ignorePath)) continue;
        const content = project.files.get(ignorePath)?.content ?? "";
        const missing = [];
        if (!isExcluded(content, ".git")) missing.push(".git");
        const packageDirs = project.manifests.map((manifest) => manifest.dir).filter((dir) => dir === context || (context === "" ? dir !== "" : dir.startsWith(`${context}/`))).map((dir) => dir === context ? "" : dir.slice(context ? context.length + 1 : 0)).sort();
        const unexcluded = packageDirs.map((dir) => join(dir, "node_modules")).filter((path) => !isExcluded(content, path));
        if (unexcluded.length > 0) missing.push(...unexcluded.slice(0, 3), ...unexcluded.length > 3 ? [`${unexcluded.length - 3} more node_modules`] : []);
        if (missing.length === 0) continue;
        reportedIgnoreFiles.add(ignorePath);
        report({
          path: ignorePath,
          line: 1,
          key: "incomplete",
          impact: "low",
          message: `${ignorePath} does not exclude ${missing.map((entry) => `\`${entry}\``).join(", ")}, which \`${broad.keyword} ${broad.args.replace(/\s+/g, " ").trim()}\` in ${model.path} (line ${broad.line}) copies into the image and hashes on every build.`,
          suggestion: `Add ${missing.includes(".git") ? "`.git` and " : ""}\`**/node_modules\` (patterns are anchored at the context root, so plain \`node_modules\` only matches the top level).`,
          related: [{ path: model.path, line: broad.line }]
        });
      }
    }
  }
});

// src/lint/rules/containers/multi-stage.ts
var BUILD_PACKAGES = /* @__PURE__ */ new Set(["build-essential", "build-base", "gcc", "g++", "make", "git", "cmake", "clang", "musl-dev", "libc-dev"]);
var DEV_IMAGE = /(^|\/)\.devcontainer\/|(^|\/)(dev\.Dockerfile|Dockerfile\.dev(elopment)?|[^/]*\.dev\.Dockerfile)$/i;
function packageName(spec) {
  return spec.split(/[=~<>]/)[0]?.toLowerCase() ?? spec;
}
function removesPackages(words2) {
  const [head, ...rest] = words2;
  const name = head?.split("/").pop();
  if (name === "apk") return rest.includes("del");
  if (name === "apt-get" || name === "apt") return rest.some((word) => ["purge", "remove", "autoremove"].includes(word));
  return false;
}
function devInstall(words2) {
  const [head, verb, ...rest] = words2;
  const name = head?.split("/").pop();
  const has2 = (pattern) => rest.some((arg) => pattern.test(arg));
  if (name === "npm" && (verb === "ci" || verb === "install" || verb === "i")) {
    if (rest.some((arg) => arg === "-g" || arg === "--global")) return void 0;
    if (has2(/^--(omit=dev|production|only=prod(uction)?)$/) || rest.join(" ").includes("--omit dev")) return void 0;
    return `npm ${verb}`;
  }
  if (name === "pnpm" && (verb === "install" || verb === "i")) {
    return has2(/^(--prod|-P|--production)$/) ? void 0 : "pnpm install";
  }
  if (name === "yarn" && (verb === void 0 || verb === "install")) {
    return has2(/^--production/) || rest.includes("focus") ? void 0 : "yarn install";
  }
  return void 0;
}
var RUNTIME_HINTS = [
  { pattern: /^go build/, runtime: "`gcr.io/distroless/static-debian12` (build with `CGO_ENABLED=0`)" },
  { pattern: /^cargo/, runtime: "`gcr.io/distroless/cc-debian12` or `debian:bookworm-slim`" },
  { pattern: /^(mvn|gradle)/, runtime: "`eclipse-temurin:21-jre` or `gcr.io/distroless/java21-debian12`" },
  { pattern: /^dotnet/, runtime: "`mcr.microsoft.com/dotnet/aspnet` or `mcr.microsoft.com/dotnet/runtime-deps` (chiseled)" },
  { pattern: /^(npm|pnpm|yarn)/, runtime: "`node:<version>-slim` or `gcr.io/distroless/nodejs22-debian12`" }
];
var multi_stage_default = defineRule({
  meta: {
    id: "containers/multi-stage",
    ruleset: "containers",
    description: "Single-stage Dockerfiles that install build toolchains or dev dependencies should use a builder stage and a minimal runtime stage.",
    rationale: "Compilers, git, and devDependencies are only needed to build. Shipping them makes every pull, push, and layer upload larger and slower (and widens the attack surface). A multi-stage build compiles in a builder stage and copies only artifacts into a slim or distroless runtime stage; BuildKit also builds independent stages in parallel.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/building/multi-stage/",
      "https://docs.docker.com/build/building/best-practices/#use-multi-stage-builds",
      "https://github.com/GoogleContainerTools/distroless"
    ],
    impact: "medium",
    example: {
      bad: 'FROM golang:1.23\nWORKDIR /src\nCOPY . .\nRUN go build -o /app ./cmd/server\nCMD ["/app"]',
      good: 'FROM golang:1.23 AS build\nWORKDIR /src\nCOPY go.mod go.sum ./\nRUN go mod download\nCOPY . .\nRUN CGO_ENABLED=0 go build -o /app ./cmd/server\n\nFROM gcr.io/distroless/static-debian12\nCOPY --from=build /app /app\nCMD ["/app"]'
    }
  },
  check({ project, report }) {
    for (const model of project.dockerfiles) {
      const [stage] = model.stages;
      if (model.stages.length !== 1 || !stage || DEV_IMAGE.test(model.path)) continue;
      const file = fileOf(project, model);
      const evidence2 = [];
      let productionEnv = false;
      for (const instruction of stage.instructions) {
        if ((instruction.keyword === "ENV" || instruction.keyword === "ARG") && /\bNODE_ENV[= ]+["']?production\b/.test(instruction.args)) {
          productionEnv = true;
        }
        if (instruction.keyword !== "RUN") continue;
        const commands = shellCommands(file, instruction);
        const purges = commands.some((command) => removesPackages(command.words));
        const inlineProduction = /\bNODE_ENV=["']?production\b/.test(instruction.args);
        const prunes = commands.some((command) => /^(npm|pnpm) prune\b/.test(command.words.join(" ")));
        for (const command of commands) {
          const install = systemInstall(command.words);
          if (install && !purges) {
            const tools = install.packages.map(packageName).filter((name) => BUILD_PACKAGES.has(name));
            if (tools.length > 0) evidence2.push({ label: `${install.installer} installs ${tools.map((tool2) => `\`${tool2}\``).join(", ")}`, line: command.line });
            continue;
          }
          const dev = devInstall(command.words);
          if (dev && !productionEnv && !inlineProduction && !prunes) {
            evidence2.push({ label: `\`${dev}\` installs devDependencies`, line: command.line });
            continue;
          }
          const build = toolchainBuild(command.words);
          if (build) evidence2.push({ label: `\`${build}\` compiles in the final image`, line: command.line });
        }
      }
      if (evidence2.length === 0) continue;
      const runtime = RUNTIME_HINTS.find((hint) => evidence2.some((entry) => hint.pattern.test(entry.label.replace(/^`/, ""))))?.runtime ?? "a `-slim` or distroless image";
      const related = [];
      for (const entry of evidence2) {
        if (!related.some((location) => location.line === entry.line)) related.push({ path: model.path, line: entry.line });
      }
      const shown = evidence2.slice(0, 3).map((entry) => `${entry.label} (line ${entry.line})`);
      report({
        path: model.path,
        line: stage.line,
        key: "single-stage",
        message: `Single-stage image ships its build toolchain: ${shown.join("; ")}${evidence2.length > 3 ? `; and ${evidence2.length - 3} more` : ""}.`,
        suggestion: `Split into a builder stage (\`FROM ${stage.image}${stage.tag ? `:${stage.tag}` : ""} AS build\`) that installs toolchains and dependencies and builds, and a runtime stage based on ${runtime} that only \`COPY --from=build\` the built artifacts and production dependencies.`,
        related
      });
    }
  }
});

// src/lint/rules/containers/shared-base.ts
var HOUSEKEEPING = /^(set|true|:|echo|rm|apt-get (update|clean|autoclean)|apt (update|clean)|apk update|ln|mkdir|chmod|chown|cd)\b/;
var TOOL_INSTALL = /^(npm (i|install) (-g|--global)|pnpm add -g|corepack (enable|prepare)|pip3? install|python3? -m pip install|gem install|go install|cargo install|curl|wget|dnf install|yum install|microdnf install|apk add|apt-get install|apt install)\b/;
function hash(text) {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) value = (value * 33 ^ text.charCodeAt(index)) >>> 0;
  return value.toString(16).padStart(8, "0");
}
function baseOf(stage) {
  return `${stage.image}${stage.tag ? `:${stage.tag}` : ""}`;
}
function preamble(file, model, stage) {
  if (isInternalBase(model, stage)) return void 0;
  const packages = /* @__PURE__ */ new Map();
  const commands = [];
  let installs = 0;
  for (const instruction of stage.instructions) {
    if (contextSources(instruction) !== void 0) break;
    if (instruction.keyword !== "RUN") continue;
    for (const command of shellCommands(file, instruction)) {
      const text = command.words.join(" ");
      const system = systemInstall(command.words);
      if (system) {
        const set = packages.get(system.installer) ?? /* @__PURE__ */ new Set();
        for (const name of system.packages) set.add(name.replace(/^["']|["']$/g, ""));
        packages.set(system.installer, set);
        installs += 1;
        continue;
      }
      if (HOUSEKEEPING.test(text) || isDependencyInstall(command)) continue;
      if (TOOL_INSTALL.test(text)) installs += 1;
      commands.push(text);
    }
  }
  if (installs === 0) return void 0;
  const steps2 = [
    ...[...packages].sort(([a], [b]) => a.localeCompare(b)).map(([installer, names]) => `${installer}: ${[...names].sort().join(" ")}`),
    ...commands
  ];
  return { model, stage, base: baseOf(stage), steps: steps2 };
}
function isDependencyInstall(command) {
  return dependencyInstall(command.words) !== void 0;
}
function summarize(steps2) {
  const text = steps2.map((step) => `\`${step.length > 50 ? `${step.slice(0, 47)}...` : step}\``).slice(0, 3).join(", ");
  return steps2.length > 3 ? `${text} and ${steps2.length - 3} more` : text;
}
function imageName(base2) {
  const name = base2.split("@")[0]?.split(":")[0]?.split("/").pop() ?? "app";
  return name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}
var shared_base_default = defineRule({
  meta: {
    id: "containers/shared-base",
    ruleset: "containers",
    description: "Dockerfiles that repeat the same base image and toolchain preamble should share a base image published to GHCR.",
    rationale: "When several services start from the same image and install the same toolchain, every service build and every runner repeats that work and stores its own copy of the layer. Publishing the preamble once as a shared base image (referenced by digest) builds it once, lets every service and agent sandbox pull the identical cached layer, and turns toolchain upgrades into a single reviewed digest bump.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["insights"],
    requires: ["complete-inventory"],
    defaultOptions: { minDockerfiles: 3 },
    validateOptions: (value) => value.minDockerfiles !== void 0 && (!Number.isInteger(value.minDockerfiles) || value.minDockerfiles < 2) ? ["minDockerfiles must be an integer >= 2"] : [],
    references: [
      "https://docs.docker.com/build/building/base-images/",
      "https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry",
      "https://docs.docker.com/build/building/best-practices/#pin-base-image-versions"
    ],
    impact: "medium",
    example: {
      bad: "# services/a/Dockerfile, services/b/Dockerfile, services/c/Dockerfile\nFROM node:22-slim\nRUN apt-get update && apt-get install -y --no-install-recommends git python3 make",
      good: "# each service\nFROM ghcr.io/acme/node-base@sha256:<digest>"
    }
  },
  check({ project, report, options }) {
    const groups = /* @__PURE__ */ new Map();
    for (const model of [...project.dockerfiles].sort((a, b) => a.path.localeCompare(b.path))) {
      const file = fileOf(project, model);
      const signatures = /* @__PURE__ */ new Set();
      for (const stage of model.stages) {
        const entry = preamble(file, model, stage);
        if (!entry) continue;
        const signature = `${entry.base}
${entry.steps.join("\n")}`;
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        groups.set(signature, [...groups.get(signature) ?? [], entry]);
      }
    }
    for (const [signature, entries2] of groups) {
      if (entries2.length < options.minDockerfiles) continue;
      const [first, ...others] = entries2;
      if (!first) continue;
      report({
        path: first.model.path,
        line: first.stage.line,
        key: `base:${first.base}:${hash(signature)}`,
        confidence: "medium",
        message: `${entries2.length} Dockerfiles start from \`${first.base}\` and repeat the same toolchain preamble (${summarize(first.steps)}).`,
        suggestion: `Move \`FROM ${first.base}\` and the shared install steps into one base Dockerfile, publish it from CI to \`ghcr.io/<org>/${imageName(first.base)}-base\`, and start each of these Dockerfiles with \`FROM ghcr.io/<org>/${imageName(first.base)}-base@sha256:<digest>\` (Dependabot can bump the digest). The layer is then built once and shared across the monorepo.`,
        related: others.map((entry) => ({ path: entry.model.path, line: entry.stage.line }))
      });
    }
  }
});

// src/lint/rules/containers/index.ts
var rules4 = [apt_hygiene_default, cache_mount_default, dependency_layer_default, dockerignore_default, multi_stage_default, shared_base_default];

// src/lint/parsers/dockerfile.ts
function isDockerfilePath(path) {
  const name = path.split("/").pop() ?? path;
  return /^(Dockerfile|Containerfile)(\..+)?$/i.test(name) || /\.(dockerfile|containerfile)$/i.test(name);
}
function splitFlags(rest) {
  const flags = /* @__PURE__ */ new Map();
  let remaining = rest.trimStart();
  for (; ; ) {
    const match2 = /^--([a-z-]+)(?:=("[^"]*"|\S+))?\s*/i.exec(remaining);
    if (!match2?.[1]) break;
    const name = match2[1].toLowerCase();
    const value = match2[2]?.replace(/^"|"$/g, "") ?? "";
    flags.set(name, [...flags.get(name) ?? [], value]);
    remaining = remaining.slice(match2[0].length);
  }
  return { flags, args: remaining.trim() };
}
function parseImageReference(reference) {
  const [withoutDigest, digest] = reference.split("@");
  const base2 = withoutDigest ?? reference;
  const slash = base2.lastIndexOf("/");
  const colon = base2.lastIndexOf(":");
  if (colon > slash) {
    return {
      image: base2.slice(0, colon),
      tag: base2.slice(colon + 1),
      ...digest ? { digest } : {}
    };
  }
  return { image: base2, ...digest ? { digest } : {} };
}
function parseDockerfile(path, content) {
  const lines = content.split(/\r?\n/);
  const escapeDirective = /^#\s*escape\s*=\s*(`|\\)/im.exec(lines.slice(0, 5).join("\n"));
  const escape = escapeDirective?.[1] ?? "\\";
  const instructions = [];
  let index = 0;
  while (index < lines.length) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    const startLine = index + 1;
    let text = trimmed;
    while (text.endsWith(escape) && index + 1 < lines.length) {
      text = text.slice(0, -1);
      index += 1;
      const next = (lines[index] ?? "").trim();
      if (next.startsWith("#")) continue;
      text += ` ${next}`;
    }
    const heredoc = /<<-?["']?([A-Za-z_][A-Za-z0-9_]*)["']?/.exec(text);
    if (heredoc?.[1]) {
      const terminator = heredoc[1];
      while (index + 1 < lines.length) {
        index += 1;
        const body = lines[index] ?? "";
        if (body.trim() === terminator) break;
        text += `
${body}`;
      }
    }
    const match2 = /^([A-Za-z]+)\s*([\s\S]*)$/.exec(text);
    if (match2?.[1]) {
      const { flags, args } = splitFlags(match2[2] ?? "");
      instructions.push({
        keyword: match2[1].toUpperCase(),
        args,
        flags,
        line: startLine,
        endLine: index + 1
      });
    }
    index += 1;
  }
  const globalArgs = /* @__PURE__ */ new Map();
  const stages = [];
  for (const instruction of instructions) {
    if (instruction.keyword === "FROM") {
      const [reference = "", as, name] = instruction.args.split(/\s+/);
      const resolved = reference.replace(
        /\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}?/g,
        (whole, key) => globalArgs.get(key) ?? whole
      );
      const image = parseImageReference(resolved);
      stages.push({
        index: stages.length,
        ...as?.toUpperCase() === "AS" && name ? { name } : {},
        image: image.image,
        ...image.tag !== void 0 ? { tag: image.tag } : {},
        ...image.digest !== void 0 ? { digest: image.digest } : {},
        line: instruction.line,
        instructions: []
      });
      continue;
    }
    const stage = stages.at(-1);
    if (stage) {
      stage.instructions.push(instruction);
    } else if (instruction.keyword === "ARG") {
      const [key, value] = instruction.args.split("=");
      if (key && value !== void 0) globalArgs.set(key.trim(), value.trim().replace(/^"|"$/g, ""));
    }
  }
  const slash = path.lastIndexOf("/");
  return {
    path,
    dir: slash >= 0 ? path.slice(0, slash) : "",
    instructions,
    stages,
    globalArgs
  };
}

// src/lint/rules/hermeticity/images.ts
function imagePinProblem(reference, requireDigest, subject) {
  const { tag, digest } = parseImageReference(reference);
  if (digest?.toLowerCase().startsWith("sha256:")) return void 0;
  if (requireDigest) {
    return {
      kind: "digest",
      message: `${subject} \`${reference}\` is not pinned to an \`@sha256:\` digest, so its contents can change without a commit.`,
      suggestion: "Pin by digest while keeping the tag for readability (`name:1.2.3@sha256:<digest>`); Dependabot and Renovate can keep digests up to date."
    };
  }
  if (digest) return void 0;
  if (tag === void 0 || tag.toLowerCase() === "latest") {
    return {
      kind: tag === void 0 ? "untagged" : "latest",
      message: tag === void 0 ? `${subject} \`${reference}\` has no tag, so it resolves to the mutable \`latest\`.` : `${subject} \`${reference}\` uses the mutable \`latest\` tag.`,
      suggestion: "Pin a specific version tag (e.g. `name:1.2.3`), or a digest for full reproducibility."
    };
  }
  return void 0;
}

// src/lint/rules/hermeticity/docker-base-digest.ts
var docker_base_digest_default = defineRule({
  meta: {
    id: "hermeticity/docker-base-digest",
    ruleset: "hermeticity",
    description: "Dockerfile base images should use pinned versions (and digests when required).",
    rationale: "`FROM image` or `FROM image:latest` silently changes whenever upstream publishes, which breaks reproducibility and invalidates the layer cache for every following instruction. A version tag makes upgrades explicit; a digest makes builds fully reproducible.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { requireDigest: false },
    validateOptions: (options) => "requireDigest" in options && typeof options.requireDigest !== "boolean" ? ["requireDigest must be a boolean"] : [],
    references: [
      "https://docs.docker.com/build/building/best-practices/#pin-base-image-versions",
      "https://docs.docker.com/reference/dockerfile/#from",
      "https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies"
    ],
    impact: "medium",
    example: { bad: "FROM node", good: "FROM node:22.20-bookworm-slim" }
  },
  check({ project, options, report }) {
    for (const dockerfile of project.dockerfiles) {
      const stageNames = /* @__PURE__ */ new Set();
      for (const stage of dockerfile.stages) {
        const from = dockerfile.instructions.find((instruction) => instruction.keyword === "FROM" && instruction.line === stage.line);
        const reference = from?.args.split(/\s+/)[0] ?? "";
        const known2 = reference !== "" && !reference.includes("$") && reference.toLowerCase() !== "scratch" && !stageNames.has(reference.toLowerCase());
        if (stage.name) stageNames.add(stage.name.toLowerCase());
        if (!known2) continue;
        const problem = imagePinProblem(reference, options.requireDigest, "Base image");
        if (!problem) continue;
        report({
          path: dockerfile.path,
          line: stage.line,
          key: `stage[${stage.index}]`,
          message: problem.message,
          suggestion: problem.suggestion
        });
      }
    }
  }
});

// src/lint/rules/hermeticity/frozen-lockfile.ts
var SAFE_NPM_FLAGS = /* @__PURE__ */ new Set(["--no-audit", "--no-fund", "--prefer-offline", "--ignore-scripts", "--legacy-peer-deps", "--loglevel=error", "--silent"]);
var frozen_lockfile_default = defineRule({
  meta: {
    id: "hermeticity/frozen-lockfile",
    ruleset: "hermeticity",
    description: "CI installs must be locked to the committed lockfile.",
    rationale: "`npm install` and unfrozen yarn/bun installs can rewrite the lockfile and resolve different versions per run, which breaks reproducibility and cache keys. Frozen installs are also faster.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.npmjs.com/cli/v11/commands/npm-ci",
      "https://classic.yarnpkg.com/en/docs/cli/install#toc-yarn-install-frozen-lockfile",
      "https://pnpm.io/cli/install#--frozen-lockfile"
    ],
    impact: "medium",
    fixable: true,
    example: { bad: "- run: npm install", good: "- run: npm ci" }
  },
  check({ project, report }) {
    const facts = project.facts;
    const npmLock = facts.lockfiles.some((path) => /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(path));
    const yarnLock = project.files.get("yarn.lock");
    const yarnClassic = typeof project.rootManifest?.json.packageManager === "string" && project.rootManifest.json.packageManager.startsWith("yarn@1") || (yarnLock?.content.includes("# yarn lockfile v1") ?? false);
    for (const { workflow, step } of steps([...project.workflows, ...project.actions])) {
      const file = project.files.get(workflow.path);
      for (const { command, line } of commandsOf(step)) {
        const words2 = command.split(/\s+/);
        const [tool2, verb, ...rest] = words2;
        if (tool2 === "npm" && (verb === "install" || verb === "i")) {
          if (rest.some((arg) => arg === "-g" || arg === "--global")) continue;
          const packages = rest.filter((arg) => !arg.startsWith("-"));
          if (packages.length > 0) continue;
          const fixable = npmLock && rest.every((arg) => SAFE_NPM_FLAGS.has(arg)) && file !== void 0;
          report({
            path: workflow.path,
            line,
            key: `${step.key}:npm-install`,
            message: "`npm install` can modify package-lock.json and resolve different versions in CI.",
            suggestion: npmLock ? "Use `npm ci`." : "Commit package-lock.json and use `npm ci`.",
            confidence: npmLock ? "high" : "medium",
            ...fixable ? { fix: fix("Use npm ci", replaceOnLine(file, line, `npm ${verb}`, "npm ci")) } : {}
          });
        } else if (tool2 === "yarn" && (verb === void 0 || verb === "install") && yarnClassic) {
          if (rest.includes("--frozen-lockfile") || rest.includes("--immutable")) continue;
          report({
            path: workflow.path,
            line,
            key: `${step.key}:yarn-install`,
            message: "Yarn classic install without `--frozen-lockfile` can update yarn.lock in CI.",
            suggestion: "Use `yarn install --frozen-lockfile`."
          });
        } else if (tool2 === "pnpm" && (verb === "install" || verb === "i") && rest.includes("--no-frozen-lockfile")) {
          report({
            path: workflow.path,
            line,
            key: `${step.key}:pnpm-install`,
            message: "`pnpm install --no-frozen-lockfile` disables pnpm's CI lockfile protection.",
            suggestion: "Remove `--no-frozen-lockfile` (pnpm freezes the lockfile in CI by default)."
          });
        } else if (tool2 === "bun" && verb === "install" && !rest.includes("--frozen-lockfile")) {
          report({
            path: workflow.path,
            line,
            key: `${step.key}:bun-install`,
            message: "`bun install` without `--frozen-lockfile` can update the lockfile in CI.",
            suggestion: "Use `bun install --frozen-lockfile`."
          });
        }
      }
    }
  }
});

// src/lint/rules/hermeticity/pin-actions.ts
var SUGGESTION2 = "Pin to the full 40-character commit SHA with a version comment, e.g. `uses: owner/repo@<sha> # v1.2.3`; Dependabot and Renovate keep SHA pins and their comments up to date.";
function describeRef(ref) {
  if (ref === void 0) return "has no ref";
  if (/^[0-9a-f]{7,39}$/i.test(ref)) return `uses a short SHA (\`${ref}\`) that can collide`;
  return `uses the mutable ref \`${ref}\``;
}
var pin_actions_default = defineRule({
  meta: {
    id: "hermeticity/pin-actions",
    ruleset: "hermeticity",
    description: "Third-party actions and reusable workflows should be pinned to a full commit SHA.",
    rationale: "Tags and branches can be moved, so `@v4` may run different code tomorrow than today, which breaks reproducibility and is a supply-chain risk. A full-length commit SHA is immutable. (OpenSSF Scorecard also treats a tag backed by an immutable release as pinned, but most action tags are not immutable releases and this cannot be verified offline.)",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["strict"],
    requires: [],
    defaultOptions: { ignoreOwners: [] },
    validateOptions: (options) => "ignoreOwners" in options && (!Array.isArray(options.ignoreOwners) || !options.ignoreOwners.every((owner) => typeof owner === "string")) ? ["ignoreOwners must be an array of strings"] : [],
    references: [
      "https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions",
      "https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies",
      "https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot"
    ],
    impact: "low",
    example: {
      bad: "- uses: actions/checkout@v6",
      good: "- uses: actions/checkout@<40-character commit sha> # v6.0.0"
    }
  },
  check({ project, options, report }) {
    const ignored = new Set(options.ignoreOwners.map((owner) => owner.toLowerCase()));
    const skip = (owner) => owner !== void 0 && ignored.has(owner);
    for (const workflow of [...project.workflows, ...project.actions]) {
      for (const job of workflow.jobs) {
        if (job.uses && job.uses.kind === "literal") {
          const ref = parseActionRef(job.uses.value);
          if (ref.kind === "remote" && !ref.shaPinned && !skip(ref.owner)) {
            report({
              path: workflow.path,
              line: job.uses.line,
              key: `${job.key}.uses`,
              message: `Reusable workflow \`${ref.raw}\` ${describeRef(ref.ref)} instead of a full commit SHA.`,
              suggestion: SUGGESTION2
            });
          }
        }
        for (const step of job.steps) {
          const uses = step.uses;
          if (!uses || uses.kind !== "literal") continue;
          const action = uses.action;
          if (action.kind === "docker" && !action.shaPinned) {
            report({
              path: workflow.path,
              line: uses.line,
              key: `${step.key}.uses`,
              message: `Docker action image \`${action.raw}\` is not pinned to an \`@sha256:\` digest.`,
              suggestion: "Pin the image by digest, e.g. `docker://alpine:3.22@sha256:<digest>`."
            });
          } else if (action.kind === "remote" && !action.shaPinned && !skip(action.owner)) {
            report({
              path: workflow.path,
              line: uses.line,
              key: `${step.key}.uses`,
              message: `Action \`${action.raw}\` ${describeRef(action.ref)} instead of a full commit SHA.`,
              suggestion: SUGGESTION2
            });
          }
        }
      }
    }
  }
});

// src/lint/rules/hermeticity/pin-container-images.ts
var pin_container_images_default = defineRule({
  meta: {
    id: "hermeticity/pin-container-images",
    ruleset: "hermeticity",
    description: "Job containers and service containers should use pinned image versions.",
    rationale: "An image with no tag or `:latest` changes whenever upstream publishes, so a job's toolchain or a service's database version can change between two runs of the same commit. A version tag makes upgrades explicit; a digest makes them fully reproducible.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { requireDigest: false },
    validateOptions: (options) => "requireDigest" in options && typeof options.requireDigest !== "boolean" ? ["requireDigest must be a boolean"] : [],
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idcontainerimage",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idservicesservice_idimage",
      "https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier"
    ],
    impact: "medium",
    example: {
      bad: "services:\n  db:\n    image: postgres",
      good: "services:\n  db:\n    image: postgres:17.6"
    }
  },
  check({ project, options, report }) {
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        const images = [
          ...job.containerImage ? [{ image: job.containerImage, key: `${job.key}.container`, subject: "Job container image" }] : [],
          ...job.services.map((service) => ({
            image: service.image,
            key: `${job.key}.services.${service.name}`,
            subject: `Service \`${service.name}\` image`
          }))
        ];
        for (const { image, key, subject } of images) {
          if (image.kind !== "literal") continue;
          const reference = image.value.trim().replace(/^docker:\/\//, "");
          if (reference === "") continue;
          const problem = imagePinProblem(reference, options.requireDigest, subject);
          if (!problem) continue;
          report({ path: workflow.path, line: image.line, key, message: problem.message, suggestion: problem.suggestion });
        }
      }
    }
  }
});

// src/lint/rules/hermeticity/pin-runner.ts
var import_yaml7 = __toESM(require_dist(), 1);
var LATEST = /^(ubuntu|windows|macos)-latest$/i;
var MATRIX_REF = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/;
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function osOf(label) {
  return label.toLowerCase().split("-")[0];
}
function describe(label) {
  return osOf(label) === "ubuntu" ? `\`${label}\` is a moving label that is migrating from Ubuntu 24.04 to Ubuntu 26.04 (Oct 19 \u2013 Nov 19, 2026), so the same commit can run on different images` : `\`${label}\` is a moving label that switches OS images when GitHub migrates it, so the same commit can run on different images`;
}
function runsOnLabels(source, jobNode, job) {
  const runsOn = field(source, jobNode, "runs-on");
  if (!runsOn?.value) return [];
  let node = runsOn.value;
  let key = `${job.key}.runs-on`;
  let direct = runsOn.origin === "direct";
  if ((0, import_yaml7.isMap)(node)) {
    if (field(source, node, "group")) return void 0;
    const labels = field(source, node, "labels");
    if (!labels?.value) return [];
    node = labels.value;
    key += ".labels";
    direct &&= labels.origin === "direct";
  }
  if ((0, import_yaml7.isScalar)(node)) {
    const value = stringValue(node);
    return value === void 0 ? [] : [{ node, value, key, direct }];
  }
  if (!(0, import_yaml7.isSeq)(node)) return [];
  return node.items.flatMap((raw, index) => {
    const resolved = resolveNode(source, raw).node;
    const value = (0, import_yaml7.isScalar)(resolved) ? stringValue(resolved) : void 0;
    return resolved && value !== void 0 ? [{ node: resolved, value, key: `${key}[${index}]`, direct: direct && !(0, import_yaml7.isAlias)(raw) }] : [];
  });
}
function matrixValues(source, jobNode, job, name) {
  const matrix = field(source, field(source, jobNode, "strategy")?.value, "matrix")?.value;
  const result = [];
  const axis = field(source, matrix, name)?.value;
  const axisNodes = (0, import_yaml7.isSeq)(resolveNode(source, axis).node) ? items(source, axis) : axis ? [axis] : [];
  axisNodes.forEach((node, index) => {
    const value = (0, import_yaml7.isScalar)(node) ? stringValue(node) : void 0;
    if (value !== void 0) result.push({ node, value, key: `${job.key}.strategy.matrix.${name}[${index}]`, direct: false });
  });
  items(source, field(source, matrix, "include")?.value).forEach((entry, index) => {
    const node = field(source, entry, name)?.value;
    const value = (0, import_yaml7.isScalar)(node) ? stringValue(node) : void 0;
    if (node && value !== void 0) result.push({ node, value, key: `${job.key}.strategy.matrix.include[${index}].${name}`, direct: false });
  });
  return result;
}
function jobNodeOf(workflow, job) {
  const source = workflow.source;
  return field(source, field(source, source.doc.contents, "jobs")?.value, job.id)?.value;
}
var pin_runner_default = defineRule({
  meta: {
    id: "hermeticity/pin-runner",
    ruleset: "hermeticity",
    description: "Jobs should run on a pinned runner image label instead of `*-latest`.",
    rationale: "`ubuntu-latest`, `windows-latest` and `macos-latest` move to a new OS image during a gradual multi-week rollout, so identical commits can pass on one run and fail on the next with different toolchains and preinstalled software. `ubuntu-latest` is migrating from Ubuntu 24.04 to 26.04 between Oct 19 and Nov 19, 2026. Pinning makes the upgrade a deliberate, reviewable change.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { ubuntu: "ubuntu-24.04", windows: "windows-2025", macos: "macos-15" },
    validateOptions: (options) => Object.entries(options).filter(([, value]) => typeof value !== "string" || value.trim() === "" || /-latest$/i.test(value)).map(([key]) => `${key} must be a pinned runner label (a non-empty string that does not end in -latest)`),
    references: [
      "https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories",
      "https://github.com/actions/runner-images#available-images",
      "https://github.com/actions/runner-images#ongoing-migrations"
    ],
    impact: "medium",
    fixable: true,
    example: { bad: "runs-on: ubuntu-latest", good: "runs-on: ubuntu-24.04" }
  },
  check({ project, options, report }) {
    for (const workflow of project.workflows) {
      const source = workflow.source;
      const file = project.files.get(workflow.path);
      for (const job of workflow.jobs) {
        const jobNode = jobNodeOf(workflow, job);
        const labels = runsOnLabels(source, jobNode, job);
        if (!labels || labels.some((label) => label.value.trim().toLowerCase() === "self-hosted")) continue;
        for (const label of labels) {
          const value = label.value.trim();
          const matrixName = MATRIX_REF.exec(value)?.[1];
          if (matrixName) {
            for (const entry of matrixValues(source, jobNode, job, matrixName)) {
              const candidate = entry.value.trim();
              if (!LATEST.test(candidate)) continue;
              const pinned2 = options[osOf(candidate)];
              report({
                path: workflow.path,
                line: lineOfNode(source, entry.node),
                key: entry.key,
                message: `Matrix value ${describe(candidate)}.`,
                suggestion: `Change the matrix value to \`${pinned2}\` (this renames the matrix jobs, so update required status checks and any \`matrix.${matrixName}\` conditions).`
              });
            }
            continue;
          }
          if (!LATEST.test(value)) continue;
          const pinned = options[osOf(value)];
          const line = lineOfNode(source, label.node);
          const edit = label.direct && file !== void 0 ? replaceOnLine(file, line, new RegExp(`(?<![\\w.-])${escapeRegExp(value)}(?![\\w.-])`), pinned) : void 0;
          const autofix = edit ? fix(`Pin runner to ${pinned}`, edit) : void 0;
          report({
            path: workflow.path,
            line,
            key: label.key,
            message: `${describe(value)}.`,
            suggestion: `Pin to \`${pinned}\` and upgrade deliberately in a dedicated change.`,
            ...autofix ? { fix: autofix } : {}
          });
        }
      }
    }
  }
});

// src/lint/rules/hermeticity/index.ts
var rules5 = [docker_base_digest_default, frozen_lockfile_default, pin_actions_default, pin_container_images_default, pin_runner_default];

// src/lint/rules/packages/workspace.ts
var NON_PACKAGE_DIR = /(^|\/)(fixtures?|__fixtures__|examples?|test|tests|__tests__|testdata|e2e)(\/|$)/;
function joinPath2(dir, name) {
  return dir ? `${dir}/${name}` : name;
}
function stringField(manifest, key) {
  const value = manifest.json[key];
  return typeof value === "string" ? value : void 0;
}
function isWorkspaceRoot(project, manifest) {
  if (manifest.json.workspaces !== void 0) return true;
  return manifest.dir === "" && project.facts.workspaceGlobs.value.length > 0;
}
function packageManifests(project) {
  const { workspacePackages, workspaceGlobs } = project.facts;
  const list3 = workspacePackages.status === "known" ? [
    ...project.rootManifest ? [project.rootManifest] : [],
    ...workspacePackages.value.filter((manifest) => workspaceGlobs.value.length > 0 || !NON_PACKAGE_DIR.test(manifest.dir))
  ] : project.manifests.filter((manifest) => !NON_PACKAGE_DIR.test(manifest.dir));
  return [...new Set(list3)].sort((a, b) => a.path.localeCompare(b.path));
}
function internalNames(project) {
  return new Set(project.manifests.map((manifest) => manifest.name).filter((name) => name !== void 0));
}
function looseJson(content) {
  try {
    return JSON.parse(content.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return void 0;
  }
}
function publishedEntries(project, manifest) {
  const paths = [];
  for (const key of ["main", "module", "types", "typings", "browser"]) {
    const value = stringField(manifest, key);
    if (value) paths.push(value);
  }
  const bin = manifest.json.bin;
  if (typeof bin === "string") paths.push(bin);
  else if (bin && typeof bin === "object") paths.push(...Object.values(bin).filter((value) => typeof value === "string"));
  const entries2 = /* @__PURE__ */ new Set();
  for (const path of paths) {
    const clean = path.replace(/^\.?\/+/, "");
    if (!clean || clean.startsWith("..")) continue;
    const [first, ...rest] = clean.split("/");
    if (first) entries2.add(rest.length > 0 ? first : clean);
  }
  if (entries2.size > 0) return [...entries2];
  const tsconfig = looseJson(project.files.get(joinPath2(manifest.dir, "tsconfig.json"))?.content ?? "");
  const outDir = tsconfig?.compilerOptions?.outDir;
  if (typeof outDir === "string") {
    const first = outDir.replace(/^\.?\/+/, "").split("/")[0];
    if (first && !first.startsWith("..")) return [first];
  }
  return ["dist"];
}

// src/lint/rules/packages/exports-map.ts
function relative(path) {
  return path.startsWith("./") || path.startsWith("../") ? path : `./${path.replace(/^\/+/, "")}`;
}
function exportsSnippet(manifest) {
  const types = stringField(manifest, "types") ?? stringField(manifest, "typings");
  const module = stringField(manifest, "module");
  const main = stringField(manifest, "main");
  const conditions = [];
  if (types) conditions.push(["types", relative(types)]);
  if (module && main && module !== main) {
    conditions.push(["import", relative(module)], ["require", relative(main)]);
  } else if (module ?? main) {
    conditions.push(["default", relative(module ?? main)]);
  }
  if (conditions.length === 0) return void 0;
  const entry = conditions.map(([condition, path]) => `"${condition}": "${path}"`).join(", ");
  return `"exports": { ".": { ${entry} }, "./package.json": "./package.json" }`;
}
function isEsm(manifest) {
  return stringField(manifest, "module") !== void 0 || manifest.json.type === "module";
}
var exports_map_default = defineRule({
  meta: {
    id: "packages/exports-map",
    ruleset: "packages",
    description: "Library packages should declare an `exports` map, and ESM libraries a `sideEffects` field.",
    rationale: "An `exports` map is the package's public API: it blocks deep imports into internals, so packages can be split, moved, and rebuilt independently without breaking consumers, and it lets bundlers and TypeScript resolve the right entry without probing. `sideEffects` tells bundlers which modules are safe to drop, which keeps tree-shaking effective and app bundles (and their build times) small.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nodejs.org/api/packages.html#package-entry-points",
      "https://nodejs.org/api/packages.html#conditional-exports",
      "https://webpack.js.org/guides/tree-shaking/#mark-the-file-as-side-effect-free",
      "https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-exports"
    ],
    impact: "low",
    example: {
      bad: '{\n  "name": "@acme/ui",\n  "main": "dist/index.cjs",\n  "module": "dist/index.mjs",\n  "types": "dist/index.d.ts"\n}',
      good: '{\n  "name": "@acme/ui",\n  "main": "dist/index.cjs",\n  "module": "dist/index.mjs",\n  "types": "dist/index.d.ts",\n  "exports": {\n    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.mjs", "require": "./dist/index.cjs" },\n    "./package.json": "./package.json"\n  },\n  "sideEffects": false\n}'
    }
  },
  check({ project, report }) {
    for (const manifest of packageManifests(project)) {
      if (isWorkspaceRoot(project, manifest)) continue;
      const entryKey = ["main", "module", "types", "typings"].find((key) => stringField(manifest, key) !== void 0);
      if (!entryKey) continue;
      if (manifest.private && manifest.json.bin !== void 0) continue;
      const name = manifest.name ? `\`${manifest.name}\`` : manifest.path;
      if (manifest.json.exports === void 0) {
        const snippet = exportsSnippet(manifest);
        if (snippet) {
          report({
            path: manifest.path,
            line: manifest.lineOf(entryKey),
            key: "exports-missing",
            message: `Library ${name} has no \`exports\` map, so consumers can deep-import any internal file and bundlers cannot rely on a fixed public entry point.`,
            suggestion: `Add \`${snippet}\` (add subpaths like \`"./feature": "./dist/feature.js"\` for each public entry). Publish it as a major version if consumers import internal paths today.`
          });
        }
      }
      if (isEsm(manifest) && manifest.json.sideEffects === void 0) {
        const esmKey = stringField(manifest, "module") !== void 0 ? "module" : "type";
        report({
          path: manifest.path,
          line: manifest.lineOf(esmKey),
          key: "side-effects-missing",
          message: `ESM library ${name} does not declare \`sideEffects\`, so bundlers must assume every module has side effects and keep unused code.`,
          suggestion: 'Add `"sideEffects": false` if importing a module has no side effects, or list the files that do (for example `"sideEffects": ["*.css", "./dist/polyfills.js"]`).'
        });
      }
    }
  }
});

// src/lint/rules/packages/files-allowlist.ts
var files_allowlist_default = defineRule({
  meta: {
    id: "packages/files-allowlist",
    ruleset: "packages",
    description: "Publishable packages should declare a `files` allowlist (or an `.npmignore`) so the tarball only ships build output.",
    rationale: "Without an allowlist `npm publish` packs the whole package directory: sources, tests, fixtures, configs, and stray build caches. Bloated tarballs make every install, CI cache restore, and container layer that contains node_modules larger and slower, and can leak files that were never meant to be published. A `files` allowlist keeps composable packages small.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://docs.npmjs.com/cli/v11/configuring-npm/package-json#files",
      "https://docs.npmjs.com/cli/v11/using-npm/developers#keeping-files-out-of-your-package",
      "https://docs.npmjs.com/cli/v11/commands/npm-pack"
    ],
    impact: "medium",
    example: {
      bad: '{\n  "name": "@acme/ui",\n  "version": "1.4.0",\n  "main": "dist/index.js"\n}',
      good: '{\n  "name": "@acme/ui",\n  "version": "1.4.0",\n  "main": "dist/index.js",\n  "files": ["dist"]\n}'
    }
  },
  check({ project, report }) {
    for (const manifest of packageManifests(project)) {
      if (manifest.private || !manifest.name || isWorkspaceRoot(project, manifest)) continue;
      if (typeof manifest.json.version !== "string") continue;
      if (manifest.json.files !== void 0) continue;
      if (project.files.has(joinPath2(manifest.dir, ".npmignore"))) continue;
      const entries2 = publishedEntries(project, manifest);
      const location = manifest.dir || "the repository root";
      report({
        path: manifest.path,
        line: manifest.lineOf("name"),
        key: "files-missing",
        message: `\`${manifest.name}\` is publishable but has no \`files\` allowlist or \`.npmignore\`, so \`npm publish\` packs everything in ${location} (sources, tests, fixtures, configs) into the tarball.`,
        suggestion: `Add \`"files": ${JSON.stringify(entries2)}\` to ${manifest.path} so the tarball only contains build output (package.json, README, and LICENSE are always included), then check the contents with \`npm pack --dry-run\`.`
      });
    }
  }
});

// src/lint/rules/packages/monolith.ts
function dependsOn(manifest, name) {
  const peer = manifest.json.peerDependencies;
  return name in manifest.dependencies || name in manifest.devDependencies || peer !== null && typeof peer === "object" && !Array.isArray(peer) && name in peer;
}
var DECOMPOSE = "Split it into smaller feature packages with explicit `exports`, publish internal packages to the GitHub npm registry (`npm.pkg.github.com`) or consume them as workspace packages, and ship shared runtime dependencies as an OCI base layer on GHCR, so CI can build, test, and cache only the packages a change affects (`nx affected`, `turbo run --filter=...[origin/main]`, `pnpm --filter ...[origin/main]`).";
var nonNegativeInteger = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0;
var monolith_default = defineRule({
  meta: {
    id: "packages/monolith",
    ruleset: "packages",
    description: "Packages with very many dependencies are candidates for decomposition into smaller composable packages.",
    rationale: "A package that pulls in everything is one cache key: any change to it, or to any of its dependencies, reinstalls, rebuilds, and retests the whole thing, and every image that contains it ships all of it. Smaller packages with explicit boundaries let affected-only CI, remote caches, and OCI layers reuse work, which is what keeps agentic edit-test loops fast.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["insights"],
    requires: [],
    defaultOptions: { maxDependencies: 40, maxWorkspaceDependents: 0 },
    validateOptions: (value) => [
      ...value.maxDependencies !== void 0 && !nonNegativeInteger(value.maxDependencies) ? ["maxDependencies must be a non-negative integer"] : [],
      ...value.maxWorkspaceDependents !== void 0 && !nonNegativeInteger(value.maxWorkspaceDependents) ? ["maxWorkspaceDependents must be a non-negative integer (0 disables the dependents check)"] : []
    ],
    references: [
      "https://docs.npmjs.com/cli/v11/using-npm/workspaces",
      "https://nx.dev/ci/features/affected",
      "https://turbo.build/repo/docs/crafting-your-repository/structuring-a-repository",
      "https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry"
    ],
    impact: "medium",
    example: {
      bad: '{\n  "name": "app",\n  "dependencies": { "...": "60 runtime and build dependencies" }\n}',
      good: '// packages/ui, packages/api-client, packages/billing each declare only what they use\n{\n  "name": "app",\n  "dependencies": { "@acme/ui": "workspace:*", "@acme/billing": "workspace:*" }\n}'
    }
  },
  check({ project, options, report }) {
    const { isMonorepo, workspacePackages } = project.facts;
    if (isMonorepo.status !== "known" || workspacePackages.status !== "known") return;
    const workspace = new Set(workspacePackages.value);
    const candidates = packageManifests(project).filter(
      (manifest) => isMonorepo.value ? workspace.has(manifest) : manifest.dir === "" && !isWorkspaceRoot(project, manifest)
    );
    for (const manifest of candidates) {
      const runtime = Object.keys(manifest.dependencies).length;
      const dev = Object.keys(manifest.devDependencies).length;
      const name = manifest.name ? `\`${manifest.name}\`` : manifest.path;
      if (runtime + dev > options.maxDependencies) {
        report({
          path: manifest.path,
          line: manifest.lineOf(runtime > 0 ? "dependencies" : "devDependencies"),
          key: "monolith",
          confidence: "medium",
          message: `${name} declares ${runtime + dev} dependencies (${runtime} runtime + ${dev} dev), more than ${options.maxDependencies}; every change to it reinstalls, rebuilds, and retests all of them as one unit.`,
          suggestion: DECOMPOSE
        });
      }
      const packageName2 = manifest.name;
      if (options.maxWorkspaceDependents > 0 && packageName2) {
        const dependents = [...workspace].filter((other) => other !== manifest && dependsOn(other, packageName2));
        if (dependents.length > options.maxWorkspaceDependents) {
          report({
            path: manifest.path,
            line: manifest.lineOf("name"),
            key: "hub",
            confidence: "medium",
            message: `${name} is a dependency of ${dependents.length} workspace packages (more than ${options.maxWorkspaceDependents}), so any change to it invalidates the build and test caches of all of them.`,
            suggestion: `Split ${name} into smaller packages along its consumers' needs, with explicit \`exports\`, so a change only affects the packages that import the changed part.`,
            related: dependents.sort((a, b) => a.path.localeCompare(b.path)).map((other) => ({ path: other.path, line: other.lineOf(packageName2) }))
          });
        }
      }
    }
  }
});

// src/lint/rules/packages/version-drift.ts
var LOCAL_SPEC = /^(workspace|catalog|file|link|portal):/;
function policy(manager, dependency) {
  switch (manager) {
    case "pnpm":
      return `Define \`${dependency}\` once in a pnpm catalog (\`catalog:\` in pnpm-workspace.yaml) and reference it as \`"${dependency}": "catalog:"\` in every package, or align the ranges with \`syncpack fix-mismatches\`.`;
    case "yarn":
      return `Align every \`${dependency}\` range on one version and enforce it with Yarn constraints (\`yarn constraints --fix\`) or \`syncpack fix-mismatches\` in CI.`;
    default:
      return `Align every \`${dependency}\` range on one version (for example with \`syncpack fix-mismatches\`) and check it in CI; a root \`overrides\` entry can also force a single copy.`;
  }
}
var version_drift_default = defineRule({
  meta: {
    id: "packages/version-drift",
    ruleset: "packages",
    description: "Workspace packages should declare each third-party dependency with the same version specifier.",
    rationale: "When packages in one monorepo ask for different ranges of the same dependency, the lockfile carries several copies, installs and node_modules grow, Docker dependency layers and CI caches fragment by package, and packages behave differently at runtime and in tests. A single version policy keeps one hermetic dependency set that every package and image layer can share.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: { ignore: [] },
    validateOptions: (value) => value.ignore === void 0 || Array.isArray(value.ignore) && value.ignore.every((entry) => typeof entry === "string") ? [] : ["ignore must be an array of dependency names"],
    references: [
      "https://pnpm.io/catalogs",
      "https://yarnpkg.com/features/constraints",
      "https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides",
      "https://github.com/JamieMason/syncpack"
    ],
    impact: "medium",
    example: {
      bad: '// packages/a/package.json\n{ "dependencies": { "zod": "^3.22.0" } }\n// packages/b/package.json\n{ "dependencies": { "zod": "^3.24.1" } }',
      good: '# pnpm-workspace.yaml\ncatalog:\n  zod: ^3.24.1\n// packages/a/package.json and packages/b/package.json\n{ "dependencies": { "zod": "catalog:" } }'
    }
  },
  check({ project, options, report }) {
    if (!isKnownMonorepo(project)) return;
    const manifests = packageManifests(project);
    if (manifests.length < 2) return;
    const internal = internalNames(project);
    const ignored = new Set(options.ignore);
    const declarations = /* @__PURE__ */ new Map();
    for (const manifest of manifests) {
      for (const record2 of [manifest.dependencies, manifest.devDependencies]) {
        for (const [dependency, raw] of Object.entries(record2)) {
          const spec = raw.trim();
          if (!spec || LOCAL_SPEC.test(spec) || internal.has(dependency) || ignored.has(dependency)) continue;
          const list3 = declarations.get(dependency) ?? [];
          if (!list3.some((entry) => entry.manifest === manifest && entry.spec === spec)) list3.push({ manifest, spec });
          declarations.set(dependency, list3);
        }
      }
    }
    const manager = project.facts.packageManager.value;
    for (const [dependency, list3] of [...declarations].sort(([a], [b]) => a.localeCompare(b))) {
      const specs = /* @__PURE__ */ new Map();
      for (const entry of list3) specs.set(entry.spec, [...specs.get(entry.spec) ?? [], entry.manifest.path]);
      if (specs.size < 2) continue;
      const [first, ...rest] = list3;
      if (!first) continue;
      const related = [];
      for (const entry of rest) {
        if (entry.manifest === first.manifest || related.some((location) => location.path === entry.manifest.path)) continue;
        related.push({ path: entry.manifest.path, line: entry.manifest.lineOf(dependency) });
      }
      const summary2 = [...specs].slice(0, 4).map(([spec, paths]) => `\`${spec}\` (${paths.slice(0, 3).join(", ")}${paths.length > 3 ? `, +${paths.length - 3}` : ""})`).join(", ");
      const manifestCount = new Set(list3.map((entry) => entry.manifest)).size;
      report({
        path: first.manifest.path,
        line: first.manifest.lineOf(dependency),
        key: `drift:${dependency}`,
        message: `\`${dependency}\` is declared with ${specs.size} different version specifiers across ${manifestCount} manifests: ${summary2}${specs.size > 4 ? ", ..." : ""}.`,
        suggestion: policy(manager, dependency),
        related
      });
    }
  }
});

// src/lint/rules/packages/index.ts
var rules6 = [exports_map_default, files_allowlist_default, monolith_default, version_drift_default];

// src/lint/rules/registries/ghcr.ts
var GHCR = "ghcr.io";
var LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/;
function usesAction2(step, name) {
  const action = step.uses?.action;
  return action?.kind === "remote" && action.name === name;
}
function hostOf(ref) {
  const dynamic = ref.search(/\$\{\{|\$/);
  const literal = dynamic >= 0 ? ref.slice(0, dynamic) : ref;
  if (dynamic >= 0 && !literal.includes("/")) return void 0;
  if (!literal) return void 0;
  return registryHost(dynamic >= 0 ? `${literal}x` : literal);
}
function registryName(host) {
  return isDockerHub(host) ? "Docker Hub" : `\`${host}\``;
}
function imageName2(ref) {
  const path = ref.split("@")[0] ?? ref;
  const last = path.split("/").pop() ?? path;
  const name = last.split(":")[0] ?? last;
  return /^[a-z0-9][a-z0-9._-]*$/i.test(name) ? name.toLowerCase() : "<image>";
}
function lineOfText(file, fromLine, text) {
  if (!file) return fromLine;
  const lines = file.content.split(/\r?\n/);
  for (let index = Math.max(0, fromLine - 1); index < lines.length; index += 1) {
    if (lines[index]?.includes(text)) return index + 1;
  }
  return fromLine;
}
function listEntries(value) {
  const items2 = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/\r?\n/) : [];
  return items2.flatMap((item) => item.includes("${{") ? [item] : item.split(",")).map((item) => item.trim()).filter(Boolean);
}
function metadataImages(step) {
  const value = step.with.get("images")?.value;
  const lines = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/\r?\n/) : [];
  const images = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/(^|,)\s*name=/.test(trimmed)) {
      const attributes = new Map(
        trimmed.split(",").map((part) => {
          const [key = "", ...rest] = part.split("=");
          return [key.trim(), rest.join("=").trim()];
        })
      );
      const name = attributes.get("name");
      if (name && attributes.get("enable") !== "false") images.push(name);
    } else {
      images.push(...trimmed.split(",").map((item) => item.trim()).filter(Boolean));
    }
  }
  return images;
}
function words(command) {
  return (command.match(/(?:\$\{\{.*?\}\}|\S)+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, "")).filter(Boolean);
}
function commandPushes(command) {
  let parts = words(command);
  if (parts[0] === "sudo") parts = parts.slice(1);
  const [tool2, ...rest] = parts;
  if (!tool2 || !["docker", "podman", "buildah"].includes(tool2.split("/").pop() ?? "")) return void 0;
  const args = rest[0] === "image" || rest[0] === "buildx" ? rest.slice(1) : rest;
  const [action, ...tail2] = args;
  if (action === "push") {
    const ref = tail2.find((word) => !word.startsWith("-"));
    return ref ? [ref] : [];
  }
  if (action !== "build" && action !== "bud") return void 0;
  if (!tail2.some((word) => word === "--push" || word === "--push=true")) return void 0;
  const tags = [];
  tail2.forEach((word, index) => {
    if (word === "-t" || word === "--tag") {
      const next = tail2[index + 1];
      if (next) tags.push(next);
    } else if (/^(-t|--tag)=/.test(word)) tags.push(word.replace(/^(-t|--tag)=/, ""));
  });
  return tags;
}
function commandLogin(command) {
  const parts = words(command);
  const index = parts.findIndex((word, position) => word === "login" && /(^|\/)(docker|podman)$/.test(parts[position - 1] ?? ""));
  if (index < 0) return void 0;
  const args = parts.slice(index + 1);
  for (let position = 0; position < args.length; position += 1) {
    const word = args[position] ?? "";
    if (/^(-u|--username|-p|--password)$/.test(word)) {
      position += 1;
      continue;
    }
    if (word.startsWith("-") || word === "|" || word.startsWith(">")) continue;
    return word;
  }
  return "docker.io";
}
function loginHost(registry) {
  return registry.replace(/^https?:\/\//, "").split("/")[0]?.toLowerCase() ?? registry;
}
var SUGGESTION3 = (image) => `Push to \`ghcr.io/\${{ github.repository_owner }}/${image}\` instead: log in with \`docker/login-action\` (\`registry: ghcr.io\`, \`username: \${{ github.actor }}\`, \`password: \${{ secrets.GITHUB_TOKEN }}\`) and grant the job \`permissions: packages: write\`. GHCR images are scoped to the organization, linked to the repository, need no extra registry secrets, and pull fast from Actions runners.`;
var ghcr_default = defineRule({
  meta: {
    id: "registries/ghcr",
    ruleset: "registries",
    description: "Container images built in CI should be published to GitHub Container Registry (ghcr.io).",
    rationale: "Publishing to GHCR keeps images next to the code: the workflow's GITHUB_TOKEN can push without long-lived registry secrets, packages inherit organization permissions and link to the repository, and runners pull from GHCR without Docker Hub's anonymous rate limits. Shared base and dependency layers published once to GHCR can then be reused by every service in the monorepo.",
    kind: "policy",
    defaultSeverity: "info",
    presets: ["github"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry",
      "https://docs.github.com/en/actions/use-cases-and-examples/publishing-packages/publishing-docker-images#publishing-images-to-github-packages",
      "https://docs.docker.com/docker-hub/usage/"
    ],
    impact: "low",
    example: {
      bad: "- uses: docker/login-action@v3\n  with:\n    username: ${{ secrets.DOCKERHUB_USER }}\n    password: ${{ secrets.DOCKERHUB_TOKEN }}\n- uses: docker/build-push-action@v6\n  with:\n    push: true\n    tags: acme/api:latest",
      good: "permissions:\n  packages: write\nsteps:\n  - uses: docker/login-action@v3\n    with:\n      registry: ghcr.io\n      username: ${{ github.actor }}\n      password: ${{ secrets.GITHUB_TOKEN }}\n  - uses: docker/build-push-action@v6\n    with:\n      push: true\n      tags: ghcr.io/${{ github.repository_owner }}/api:latest"
    }
  },
  check({ project, report }) {
    const ghcrOwners = [];
    let pushesToGhcr = false;
    for (const model of [...project.workflows, ...project.actions]) {
      for (const job of model.jobs) {
        const entries2 = expandedJobSteps(project, model, job);
        const destinations = [];
        const logins = [];
        let unknownPushes = 0;
        for (const entry of entries2) {
          const { step, path } = entry;
          const file = project.files.get(path);
          if (usesAction2(step, "docker/build-push-action")) {
            const push = step.with.get("push");
            if (!push || push.kind !== "literal" || String(push.value) !== "true") continue;
            const tags = step.with.get("tags");
            const raw = withString(step, "tags")?.trim();
            const output2 = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.tags\s*\}\}$/.exec(raw ?? "");
            if (output2) {
              const meta = entries2.find((candidate) => candidate.step.id === output2[1] && usesAction2(candidate.step, "docker/metadata-action"));
              const images = meta ? metadataImages(meta.step) : [];
              const metaFile = meta ? project.files.get(meta.path) : void 0;
              for (const image of images) {
                const host = hostOf(image);
                if (!meta) continue;
                destinations.push({
                  ref: image,
                  ...host ? { host } : {},
                  path: meta.path,
                  line: lineOfText(metaFile, meta.step.with.get("images")?.line ?? meta.step.line, image),
                  key: `${meta.step.key}:image:${image}`,
                  via: "`docker/metadata-action` images"
                });
              }
              if (images.length === 0) unknownPushes += 1;
              continue;
            }
            const refs = listEntries(tags?.value);
            if (refs.length === 0) unknownPushes += 1;
            for (const ref of refs) {
              const host = hostOf(ref);
              destinations.push({
                ref,
                ...host ? { host } : {},
                path,
                line: lineOfText(file, tags?.line ?? step.line, ref),
                key: `${step.key}:tag:${ref}`,
                via: "`docker/build-push-action`"
              });
            }
            continue;
          }
          if (usesAction2(step, "docker/login-action")) {
            const registry = step.with.get("registry");
            if (registry && registry.kind !== "literal") continue;
            const host = registry ? loginHost(String(registry.value)) : "docker.io";
            logins.push({ host, entry, line: registry?.line ?? step.uses?.line ?? step.line, key: `${step.key}:login` });
            continue;
          }
          for (const { command, line } of commandsOf(step)) {
            const login = commandLogin(command);
            if (login !== void 0) {
              if (!login.includes("$")) logins.push({ host: loginHost(login), entry, line, key: `${step.key}:login:${loginHost(login)}` });
              continue;
            }
            const pushed = commandPushes(command);
            if (!pushed) continue;
            if (pushed.length === 0) unknownPushes += 1;
            for (const ref of pushed) {
              const host = hostOf(ref);
              destinations.push({ ref, ...host ? { host } : {}, path, line, key: `${step.key}:push:${ref}`, via: "`docker push`" });
            }
          }
        }
        const known2 = destinations.filter((destination) => destination.host !== void 0 && !LOCAL_HOST.test(destination.host));
        unknownPushes += destinations.filter((destination) => destination.host === void 0).length;
        for (const destination of known2) {
          const host = destination.host ?? "";
          if (host === GHCR) {
            pushesToGhcr = true;
            const owner2 = destination.ref.split("/")[1];
            if (owner2 && !owner2.includes("$")) ghcrOwners.push(owner2.toLowerCase());
            continue;
          }
          report({
            path: destination.path,
            line: destination.line,
            key: destination.key,
            message: `${destination.via} pushes \`${destination.ref}\` to ${registryName(host)} instead of GitHub Container Registry.`,
            suggestion: SUGGESTION3(imageName2(destination.ref))
          });
        }
        if (unknownPushes === 0) continue;
        if (logins.some((login) => login.host === GHCR)) pushesToGhcr = true;
        if (known2.length > 0) continue;
        for (const login of logins) {
          if (login.host === GHCR || LOCAL_HOST.test(login.host)) continue;
          report({
            path: login.entry.path,
            line: login.line,
            key: login.key,
            message: `Job \`${job.id}\` pushes images after logging in to ${registryName(login.host)} instead of GitHub Container Registry.`,
            suggestion: SUGGESTION3("<image>")
          });
        }
      }
    }
    if (!pushesToGhcr) return;
    const owner = ghcrOwners.sort()[0] ?? "<org>";
    for (const model of project.dockerfiles) {
      for (const stage of model.stages) {
        if (isInternalBase(model, stage) || !isDockerHub(registryHost(stage.image))) continue;
        const reference = `${stage.image}${stage.tag ? `:${stage.tag}` : ""}${stage.digest ? `@${stage.digest}` : ""}`;
        const name = stage.image.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io|registry\.hub\.docker\.com)\//, "").replace(/^library\//, "");
        const mirror = `ghcr.io/${owner}/${name}${stage.tag ? `:${stage.tag}` : ""}`;
        report({
          path: model.path,
          line: stage.line,
          key: `stage:${stageLabel(stage)}:from-docker-hub`,
          message: `Base image \`${reference}\` is pulled from Docker Hub although this repository publishes its images to GHCR; Docker Hub rate-limits pulls and every build depends on a second registry.`,
          suggestion: `Mirror the base image to GHCR once (for example a scheduled workflow running \`docker buildx imagetools create -t ${mirror} ${reference}\`) and use \`FROM ${mirror}@sha256:<digest>\`, so builds pull from the same registry they push to.`
        });
      }
    }
  }
});

// src/lint/rules/registries/github-npm.ts
var GITHUB_NPM = "https://npm.pkg.github.com";
function normalizeUrl(url) {
  return url.trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "").toLowerCase();
}
function isGithubRegistry(url) {
  return /^(https?:)?\/\/npm\.pkg\.github\.com(\/[^/]*)?$/.test(normalizeUrl(url));
}
function scopeOf(name) {
  return name?.startsWith("@") && name.includes("/") ? name.split("/")[0]?.toLowerCase() : void 0;
}
function publishConfigOf(manifest) {
  const value = manifest.json.publishConfig;
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function publishRegistryOf(manifest) {
  const config = publishConfigOf(manifest);
  const scope2 = scopeOf(manifest.name);
  const scoped = scope2 ? Object.entries(config ?? {}).find(([key]) => key.toLowerCase() === `${scope2}:registry`)?.[1] : void 0;
  const registry = typeof scoped === "string" ? scoped : config?.registry;
  return typeof registry === "string" ? registry : void 0;
}
function setupNode(step) {
  const action = step.uses?.action;
  return action?.kind === "remote" && action.name === "actions/setup-node";
}
var PUBLISHERS = /* @__PURE__ */ new Set(["npm", "pnpm", "yarn", "npx", "lerna", "changeset"]);
function publishRegistry(command) {
  const parts = command.split(/\s+/).filter(Boolean);
  while (parts[0] !== void 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0])) parts.shift();
  if (!PUBLISHERS.has(parts[0] ?? "")) return void 0;
  const index = parts.indexOf("publish");
  if (index < 0 || parts.slice(0, index).includes("run")) return void 0;
  const args = parts.slice(index + 1);
  if (args.includes("--dry-run")) return void 0;
  for (let position = 0; position < args.length; position += 1) {
    const word = args[position] ?? "";
    if (word === "--registry") return args[position + 1] ?? "";
    if (word.startsWith("--registry=")) return word.slice("--registry=".length);
  }
  return "";
}
var PUBLISH_SETUP = (scope2) => `Publish with \`actions/setup-node\` (\`registry-url: ${GITHUB_NPM}\`, \`scope: ${scope2}\`), \`permissions: packages: write\`, and \`NODE_AUTH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\`; consumers add \`${scope2}:registry=${GITHUB_NPM}\` to .npmrc.`;
var github_npm_default = defineRule({
  meta: {
    id: "registries/github-npm",
    ruleset: "registries",
    description: "Internal scoped npm packages should be published to the GitHub npm registry (npm.pkg.github.com).",
    rationale: "Publishing internal packages to GitHub Packages keeps them next to their source: Actions publish and install with the workflow's GITHUB_TOKEN instead of long-lived npm tokens, access follows organization and repository permissions, and small composable packages can be versioned and consumed independently by every repository and container build in the organization.",
    kind: "policy",
    defaultSeverity: "info",
    presets: ["github"],
    requires: [],
    defaultOptions: { scopes: [] },
    validateOptions: (value) => value.scopes === void 0 || Array.isArray(value.scopes) && value.scopes.every((scope2) => typeof scope2 === "string" && /^@?[a-z0-9][\w.-]*$/i.test(scope2)) ? [] : ['scopes must be an array of npm scopes such as "@acme"'],
    references: [
      "https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry",
      "https://docs.github.com/en/actions/use-cases-and-examples/publishing-packages/publishing-nodejs-packages#publishing-packages-to-github-packages",
      "https://docs.npmjs.com/cli/v11/configuring-npm/package-json#publishconfig"
    ],
    impact: "low",
    example: {
      bad: '{\n  "name": "@acme/ui",\n  "version": "1.0.0"\n}',
      good: '{\n  "name": "@acme/ui",\n  "version": "1.0.0",\n  "publishConfig": { "registry": "https://npm.pkg.github.com" }\n}'
    }
  },
  check({ project, options, input: input2, report }) {
    const configured = options.scopes.map((scope2) => (scope2.startsWith("@") ? scope2 : `@${scope2}`).toLowerCase());
    const repoScopes = new Set(project.manifests.map((manifest) => scopeOf(manifest.name)).filter((scope2) => scope2 !== void 0));
    const internal = configured.length > 0 ? new Set(configured) : repoScopes;
    const isInternal = (scope2) => scope2 !== void 0 && internal.has(scope2);
    const githubScopes = /* @__PURE__ */ new Set();
    for (const [path, file] of project.files) {
      if (!/(^|\/)\.npmrc$/.test(path)) continue;
      file.content.split(/\r?\n/).forEach((text, index) => {
        const match2 = /^\s*(@[^:\s]+):registry\s*=\s*(\S+)/.exec(text);
        if (!match2) return;
        const scope2 = (match2[1] ?? "").toLowerCase();
        const url = match2[2] ?? "";
        if (isGithubRegistry(url)) {
          githubScopes.add(scope2);
          return;
        }
        if (!isInternal(scope2) || url.includes("${")) return;
        report({
          path,
          line: index + 1,
          key: `npmrc:${scope2}`,
          message: `\`.npmrc\` maps the internal scope \`${scope2}\` to \`${url}\` instead of the GitHub npm registry.`,
          suggestion: `Use \`${scope2}:registry=${GITHUB_NPM}\` with \`//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\`, so CI installs with the workflow's GITHUB_TOKEN (\`packages: read\`) instead of a separate registry token.`
        });
      });
    }
    const yarnrcUsesGithub = [...project.files].some(([path, file]) => /(^|\/)\.yarnrc\.yml$/.test(path) && /npm\.pkg\.github\.com/i.test(file.content));
    const workflowsUseGithub = [...project.workflows, ...project.actions].some(
      (model) => model.jobs.some((job) => job.steps.some((step) => setupNode(step) && isGithubRegistry(String(step.with.get("registry-url")?.value ?? ""))))
    );
    const publishable = (manifest) => !manifest.private && typeof manifest.json.version === "string" && !isWorkspaceRoot(project, manifest);
    const internalPackages = packageManifests(project).filter((manifest) => publishable(manifest) && isInternal(scopeOf(manifest.name)));
    const primaryScope = scopeOf(internalPackages[0]?.name) ?? [...internal][0] ?? "@<org>";
    const allPinnedToGithub = internalPackages.every((manifest) => {
      const registry = publishRegistryOf(manifest);
      return registry !== void 0 && isGithubRegistry(registry);
    });
    if (internalPackages.length > 0) {
      for (const model of [...project.workflows, ...project.actions]) {
        for (const job of model.jobs) {
          const entries2 = expandedJobSteps(project, model, job);
          entries2.forEach((entry, position) => {
            for (const { command, line } of commandsOf(entry.step)) {
              const registry = publishRegistry(command);
              if (registry === void 0) continue;
              if (registry) {
                if (registry.includes("$") || isGithubRegistry(registry)) continue;
                report({
                  path: entry.path,
                  line,
                  key: `${entry.step.key}:publish-registry:${registry}`,
                  message: `This step publishes to \`${registry}\` instead of the GitHub npm registry.`,
                  suggestion: PUBLISH_SETUP(primaryScope)
                });
                continue;
              }
              if (allPinnedToGithub) continue;
              const setup = entries2.slice(0, position).reverse().find((candidate) => setupNode(candidate.step) && candidate.step.with.has("registry-url"));
              const url = setup?.step.with.get("registry-url");
              if (!setup || !url || url.kind !== "literal" || isGithubRegistry(String(url.value))) continue;
              const related = [{ path: entry.path, line }];
              report({
                path: setup.path,
                line: url.line,
                key: `${setup.step.key}:registry-url`,
                message: `\`actions/setup-node\` sets \`registry-url: ${String(url.value)}\`, so the \`publish\` step on line ${line} publishes internal packages outside the GitHub npm registry.`,
                suggestion: PUBLISH_SETUP(primaryScope),
                related
              });
            }
          });
        }
      }
    }
    const completeInventory = input2.mode === "repository" && input2.inventoryComplete;
    for (const manifest of internalPackages) {
      const scope2 = scopeOf(manifest.name) ?? primaryScope;
      const config = publishConfigOf(manifest);
      const registry = publishRegistryOf(manifest);
      if (registry !== void 0) {
        if (isGithubRegistry(registry) || registry.includes("${")) continue;
        report({
          path: manifest.path,
          line: typeof config?.registry === "string" ? manifest.lineOf("registry") : manifest.lineOf(`${scope2}:registry`),
          key: "publish-config:registry",
          message: `Internal package \`${manifest.name ?? manifest.path}\` publishes to \`${registry}\` instead of the GitHub npm registry.`,
          suggestion: `Set \`"publishConfig": { "registry": "${GITHUB_NPM}" }\` (the scope \`${scope2}\` must match the GitHub organization). ${PUBLISH_SETUP(scope2)}`
        });
        continue;
      }
      if (!completeInventory || githubScopes.has(scope2) || workflowsUseGithub || yarnrcUsesGithub) continue;
      report({
        path: manifest.path,
        line: config ? manifest.lineOf("publishConfig") : manifest.lineOf("name"),
        key: "publish-config:missing",
        message: `Internal package \`${manifest.name ?? manifest.path}\` has no \`publishConfig.registry\` and no \`.npmrc\` mapping for \`${scope2}\`, so \`npm publish\` targets the public npm registry.`,
        suggestion: `Add \`"publishConfig": { "registry": "${GITHUB_NPM}" }\` (the scope \`${scope2}\` must match the GitHub organization). ${PUBLISH_SETUP(scope2)}`
      });
    }
  }
});

// src/lint/rules/registries/index.ts
var rules7 = [ghcr_default, github_npm_default];

// src/lint/rules/workflow/artifact-retention.ts
var import_yaml9 = __toESM(require_dist(), 1);
var UPLOAD_ACTIONS = /* @__PURE__ */ new Set(["actions/upload-artifact", "actions/upload-artifact/merge"]);
var SINGLE_LINE = /* @__PURE__ */ new Set([import_yaml9.Scalar.PLAIN, import_yaml9.Scalar.QUOTE_DOUBLE, import_yaml9.Scalar.QUOTE_SINGLE]);
function retentionDays(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number(value);
  return void 0;
}
function addRetention(file, workflow, step, days) {
  const withNode = directWith(workflow, step);
  const pairs = (withNode?.items ?? []).filter((pair) => (0, import_yaml9.isScalar)(pair.key) && pair.key.value !== "<<");
  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  if (!first || !last) return void 0;
  const firstLine = lineOfNode(workflow.source, first.key);
  const indent = indentOf(file.content, firstLine);
  const lastLine = lineOfNode(workflow.source, last.key);
  const value = last.value;
  const endsOnKeyLine = (0, import_yaml9.isScalar)(value) && SINGLE_LINE.has(value.type) && value.range !== void 0 && value.range !== null && workflow.source.lineCounter.linePos(Math.max(value.range[0], value.range[1] - 1)).line === lastLine;
  const line = `${indent}retention-days: ${days}`;
  return fix(
    `Set retention-days: ${days}`,
    endsOnKeyLine ? insertLinesAfter(file, lastLine, [line]) : insertLinesAfter(file, firstLine - 1, [line])
  );
}
var artifact_retention_default = defineRule({
  meta: {
    id: "workflow/artifact-retention",
    ruleset: "workflow",
    description: "Uploaded artifacts should set a short `retention-days` instead of the repository default.",
    rationale: "Artifacts are kept for the repository default (90 days unless changed) and count against Actions storage. Agent-driven repositories produce many runs per day, so build outputs that only feed later jobs pile up quickly; a short retention keeps storage and quota headroom without slowing anything down.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: { maxDays: 7 },
    validateOptions: (options) => Object.entries(options).filter(([, value]) => typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 90).map(([key]) => `${key} must be an integer between 1 and 90`),
    references: [
      "https://github.com/actions/upload-artifact#retention-period",
      "https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts#setting-the-retention-period-for-an-artifact"
    ],
    impact: "low",
    fixable: true,
    example: {
      bad: "- uses: actions/upload-artifact@v7\n  with:\n    name: dist\n    path: dist/",
      good: "- uses: actions/upload-artifact@v7\n  with:\n    name: dist\n    path: dist/\n    retention-days: 7"
    }
  },
  check({ project, options, report }) {
    const maxDays = options.maxDays;
    for (const { workflow, step } of steps([...project.workflows, ...project.actions])) {
      const action = step.uses?.action;
      if (action?.kind !== "remote" || action.name === void 0 || !UPLOAD_ACTIONS.has(action.name)) continue;
      const retention = step.with.get("retention-days");
      if (!retention) {
        const file = project.files.get(workflow.path);
        const repair = file ? addRetention(file, workflow, step, maxDays) : void 0;
        report({
          path: workflow.path,
          line: stepLine(step),
          key: `${step.key}.with.retention-days`,
          message: "Artifact upload has no retention-days, so it is kept for the repository default (up to 90 days).",
          suggestion: `Add \`retention-days: ${maxDays}\` to the step's \`with:\` block; artifacts passed between jobs or kept for debugging rarely need more.`,
          ...repair ? { fix: repair } : {}
        });
        continue;
      }
      if (retention.kind !== "literal") continue;
      const days = retentionDays(retention.value);
      if (days === void 0) continue;
      if (days === 0) {
        report({
          path: workflow.path,
          line: retention.line,
          key: `${step.key}.with.retention-days`,
          message: "`retention-days: 0` falls back to the repository default retention (up to 90 days).",
          suggestion: `Set \`retention-days: ${maxDays}\` or less.`
        });
      } else if (days > maxDays) {
        report({
          path: workflow.path,
          line: retention.line,
          key: `${step.key}.with.retention-days`,
          message: `Artifact is kept for ${days} days, above the configured maximum of ${maxDays}.`,
          suggestion: `Lower \`retention-days\` to ${maxDays} or less unless this artifact is a release deliverable that must outlive the run.`
        });
      }
    }
  }
});

// src/lint/rules/workflow/concurrency.ts
var GROUP = "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}";
var CANCEL = "${{ github.event_name == 'pull_request' }}";
var concurrency_default = defineRule({
  meta: {
    id: "workflow/concurrency",
    ruleset: "workflow",
    description: "Pull request workflows should cancel superseded runs; deploy workflows must not.",
    rationale: "Agents push many small commits. Without a concurrency group every push keeps running to completion, wasting runner minutes and delaying feedback. Deploy and release workflows must never cancel in-progress runs.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: ["https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency"],
    impact: "high",
    fixable: true,
    example: {
      bad: "on: [pull_request]\njobs: ...",
      good: `on: [pull_request]
concurrency:
  group: ${GROUP}
  cancel-in-progress: ${CANCEL}
jobs: ...`
    }
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      const deploy = isDeployLike(workflow);
      const concurrency = workflow.concurrency;
      if (deploy) {
        const cancels = [concurrency, ...workflow.jobs.map((job) => job.concurrency)].find((entry) => {
          const value = entry?.value;
          return value && typeof value === "object" && value["cancel-in-progress"] === true;
        });
        if (cancels) {
          report({
            path: workflow.path,
            line: cancels.line,
            key: "deploy-cancel",
            message: "Deploy/release workflow cancels in-progress runs, which can interrupt a deployment midway.",
            suggestion: "Use a concurrency group without `cancel-in-progress` (queue deployments) for deploy workflows.",
            impact: "high"
          });
        }
        continue;
      }
      if (!isPullRequestWorkflow(workflow) || concurrency) continue;
      if (workflow.jobs.length > 0 && workflow.jobs.every((job) => job.concurrency)) continue;
      const file = project.files.get(workflow.path);
      const jobsField = field(workflow.source, workflow.source.doc.contents, "jobs");
      report({
        path: workflow.path,
        line: workflow.triggersLine,
        key: "missing",
        message: "Pull request workflow has no concurrency group, so superseded pushes keep running.",
        suggestion: `Add a workflow-level \`concurrency\` group keyed by PR number with \`cancel-in-progress: ${CANCEL}\`.`,
        ...file && jobsField && jobsField.origin === "direct" ? {
          fix: fix(
            "Cancel superseded pull request runs",
            insertLinesAfter(file, jobsField.line - 1, [
              "concurrency:",
              `  group: ${GROUP}`,
              `  cancel-in-progress: ${CANCEL}`,
              ""
            ])
          )
        } : {}
      });
    }
  }
});

// src/lint/rules/workflow/job-timeout.ts
var job_timeout_default = defineRule({
  meta: {
    id: "workflow/job-timeout",
    ruleset: "workflow",
    description: "Jobs should set `timeout-minutes` well below the 360 minute default.",
    rationale: "A hung job holds a runner (and every dependent job, merge queue entry, and agent loop) for up to six hours. A tight timeout turns hangs into fast, retryable failures.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { defaultMinutes: 30, maxMinutes: 120 },
    validateOptions: (options) => Object.entries(options).filter(([, value]) => typeof value !== "number" || value <= 0).map(([key]) => `${key} must be a positive number`),
    references: ["https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes"],
    impact: "medium",
    fixable: true,
    example: {
      bad: "jobs:\n  test:\n    runs-on: ubuntu-24.04",
      good: "jobs:\n  test:\n    timeout-minutes: 30\n    runs-on: ubuntu-24.04"
    }
  },
  check({ project, options, report }) {
    for (const workflow of project.workflows) {
      const file = project.files.get(workflow.path);
      for (const job of workflow.jobs) {
        if (job.uses) continue;
        const timeout = job.timeoutMinutes;
        if (!timeout) {
          const canFix = file !== void 0 && job.runsOn?.origin === "direct";
          report({
            path: workflow.path,
            line: job.line,
            key: job.key,
            message: `Job "${job.id}" has no timeout-minutes and inherits the 360 minute default.`,
            suggestion: `Add \`timeout-minutes: ${options.defaultMinutes}\` (about 2-3x the job's typical duration).`,
            ...canFix ? {
              fix: fix(
                `Set timeout-minutes: ${options.defaultMinutes} on job ${job.id}`,
                insertLinesAfter(file, job.line, [
                  `${indentOf(file.content, job.runsOn?.line ?? job.line + 1)}timeout-minutes: ${options.defaultMinutes}`
                ])
              )
            } : {}
          });
          continue;
        }
        if (timeout.kind === "literal" && typeof timeout.value === "number" && timeout.value > options.maxMinutes) {
          report({
            path: workflow.path,
            line: timeout.line,
            key: `${job.key}.timeout-minutes`,
            message: `Job "${job.id}" allows ${timeout.value} minutes, above the configured maximum of ${options.maxMinutes}.`,
            suggestion: "Lower the timeout or split the job so failures surface quickly.",
            impact: "low"
          });
        }
      }
    }
  }
});

// src/lint/rules/workflow/merge-group.ts
var PR_AUTOMATION = /label(?:l)?er|labels|triage|stale|greet|welcome|assign|auto-?merge|release-drafter|semantic-pr|pr-title/i;
var CODE_TYPES = /* @__PURE__ */ new Set(["opened", "synchronize", "reopened"]);
var merge_group_default = defineRule({
  meta: {
    id: "workflow/merge-group",
    ruleset: "workflow",
    description: "CI workflows that run on `pull_request` should also run on `merge_group`.",
    rationale: "Agent-heavy repositories open and merge many pull requests at once, so a merge queue is the only practical way to keep the default branch green without serial rebases. A merge queue waits for the required checks to report on the `merge_group` event; a required-check workflow that only listens to `pull_request` never runs there, so queued pull requests stall until they time out.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue#triggering-merge-group-checks-with-github-actions",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group"
    ],
    impact: "medium",
    example: {
      bad: "on:\n  pull_request:",
      good: "on:\n  pull_request:\n  merge_group:"
    }
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      const pullRequest = trigger(workflow, "pull_request");
      if (!pullRequest || hasTrigger(workflow, "merge_group") || isDeployLike(workflow)) continue;
      if (pullRequest.types && !pullRequest.types.some((type) => CODE_TYPES.has(type))) continue;
      if (PR_AUTOMATION.test(`${workflow.path} ${workflow.name ?? ""}`)) continue;
      const runsChecks = workflow.jobs.some(
        (job) => job.uses !== void 0 || job.steps.some((step) => step.run !== void 0 || step.uses?.action.kind === "local" || step.uses?.action.name === "actions/checkout")
      );
      if (!runsChecks) continue;
      report({
        path: workflow.path,
        line: pullRequest.line,
        key: "on.merge_group",
        message: "Workflow runs on pull_request but not merge_group; if it provides a required check, pull requests in a merge queue wait for a check that never runs.",
        suggestion: "Add `merge_group:` next to `pull_request:` under `on:` so the same checks run on the queue's temporary branch. Steps that diff against the base should use `github.event.merge_group.base_sha` for merge_group events.",
        confidence: "medium"
      });
    }
  }
});

// src/lint/rules/workflow/outdated-action-major.ts
var CACHE = { latest: 6, node24: 5 };
var UPLOAD = { latest: 7, node24: 6 };
var TRACKS = {
  "actions/checkout": { latest: 7, node24: 5 },
  "actions/setup-node": { latest: 7, node24: 5 },
  "actions/setup-python": { latest: 7, node24: 6 },
  "actions/setup-go": { latest: 7, node24: 6 },
  "actions/setup-java": { latest: 6, node24: 5 },
  "actions/setup-dotnet": { latest: 6, node24: 5 },
  "actions/cache": CACHE,
  "actions/cache/restore": CACHE,
  "actions/cache/save": CACHE,
  "actions/upload-artifact": UPLOAD,
  "actions/upload-artifact/merge": UPLOAD,
  "actions/download-artifact": { latest: 8, node24: 7 }
};
var RETIRED_RUNTIMES = /* @__PURE__ */ new Set(["node12", "node16", "node20"]);
var NODE_REMOVAL = "GitHub-hosted runners stopped providing on 2026-09-23; they force such actions onto Node 24";
function upgradeNotes(name, from, to) {
  const notes = [];
  if (name === "actions/checkout" && from < 7 && to >= 7) {
    notes.push(
      "checkout v7 refuses to check out fork pull request code under `pull_request_target`/`workflow_run` unless `allow-unsafe-pr-checkout: true` is set."
    );
  }
  if (name.startsWith("actions/upload-artifact") || name === "actions/download-artifact") {
    notes.push("GitHub Enterprise Server only supports artifact actions v3, so skip this on GHES.");
  }
  if (from < (TRACKS[name]?.node24 ?? 0)) {
    notes.push("Self-hosted runners need Actions Runner v2.327.1 or newer for node24 actions.");
  }
  return notes.length > 0 ? ` ${notes.join(" ")}` : "";
}
function checkStep(workflow, step, file, report) {
  const action = step.uses?.action;
  const name = action?.kind === "remote" ? action.name : void 0;
  const track = name !== void 0 ? TRACKS[name] : void 0;
  if (!step.uses || name === void 0 || !track) return;
  const version = actionVersion(step, file);
  if (!version || version.major >= track.latest) return;
  const shown = version.source === "comment" ? `${name}@${step.uses.action.ref?.slice(0, 7) ?? ""} (${version.text})` : `${name}@${version.text}`;
  const retired = version.major < track.node24;
  report({
    path: workflow.path,
    line: step.uses.line,
    key: `${step.key}.uses`,
    message: retired ? `${shown} targets Node 20 or older, which ${NODE_REMOVAL}, a runtime that release was never tested on, and warn on every run. The latest major is v${track.latest}.` : `${shown} is behind the latest major, v${track.latest}.`,
    suggestion: `Upgrade to ${name}@v${track.latest} (or its full commit SHA with a \`# v${track.latest}\` comment) after reviewing the release notes for breaking changes since v${version.major}.${upgradeNotes(name, version.major, track.latest)}`,
    ...retired ? { impact: "high" } : {},
    ...version.source === "comment" ? { confidence: "medium" } : {}
  });
}
var outdated_action_major_default = defineRule({
  meta: {
    id: "workflow/outdated-action-major",
    ruleset: "workflow",
    description: "Well-known actions should use their current major version, and local JavaScript actions should run on node24.",
    rationale: "Old majors of the official setup, cache, checkout, and artifact actions miss performance work (faster caching backends, parallel artifact uploads) and, below the node24 releases, target Node 20, which GitHub Actions runners removed on 2026-09-23: they now force those actions onto Node 24, which their authors never tested, and warn on every run (self-hosted runners on unsupported platforms cannot run them at all). Agents copy existing workflow snippets, so one stale pin spreads quickly.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/",
      "https://github.com/actions/checkout/releases",
      "https://github.com/actions/setup-node/releases",
      "https://github.com/actions/cache/releases",
      "https://github.com/actions/upload-artifact/releases",
      "https://github.com/actions/download-artifact/releases"
    ],
    impact: "medium",
    example: {
      bad: "- uses: actions/checkout@v4",
      good: "- uses: actions/checkout@v7"
    }
  },
  check({ project, report }) {
    for (const { workflow, step } of steps([...project.workflows, ...project.actions])) {
      checkStep(workflow, step, project.files.get(workflow.path), report);
    }
    for (const action of project.actions) {
      if (action.kind !== "action") continue;
      const using = field(action.source, field(action.source, action.source.doc.contents, "runs")?.value, "using");
      const runtime = stringValue(using?.value)?.trim().toLowerCase();
      if (!using || runtime === void 0 || !RETIRED_RUNTIMES.has(runtime)) continue;
      report({
        path: action.path,
        line: using.line,
        key: "runs.using",
        message: `Action declares \`runs.using: ${runtime}\`, which ${NODE_REMOVAL}, a runtime this action was never built or tested for.`,
        suggestion: "Change `runs.using` to `node24`, rebuild any bundled `dist/` output, and run the action's tests on Node 24 before releasing a new tag.",
        impact: "high"
      });
    }
  }
});

// src/lint/rules/workflow/index.ts
var rules8 = [artifact_retention_default, concurrency_default, job_timeout_default, merge_group_default, outdated_action_major_default];

// src/lint/rules/index.ts
var allRules = [
  ...rules8,
  ...rules3,
  ...rules,
  ...rules2,
  ...rules5,
  ...rules4,
  ...rules6,
  ...rules7
];

// src/lint/config.ts
var import_yaml13 = __toESM(require_dist(), 1);
var CONFIG_PATHS = [".github/ci-cd-optimizer.yml", ".github/ci-cd-optimizer.yaml"];
var PRESETS = ["recommended", "strict", "agentic", "github", "insights", "all"];
var SEVERITIES = ["off", "info", "warn", "error"];
var IMPACTS = ["low", "medium", "high"];
var DEPRECATED_RULE_IDS = {
  "github-npm-registry": "registries/github-npm",
  "docker-build-cache": "caching/docker-layer-cache",
  "docker-dependency-layer": "containers/dependency-layer",
  "docker-multistage": "containers/multi-stage",
  "ghcr-output": "registries/ghcr",
  "workflow-concurrency": "workflow/concurrency",
  "workflow-timeout": "workflow/job-timeout",
  "dependency-cache": "caching/setup-cache",
  "immutable-dependency-install": "hermeticity/frozen-lockfile",
  "artifact-retention": "workflow/artifact-retention",
  "path-filtering": "affected/change-detection"
};
var RECIPE_RISKS = ["low", "medium", "high"];
var DEFAULT_CONFIG = {
  schemaVersion: 1,
  enabled: true,
  extends: ["recommended"],
  rulesets: {},
  rules: {},
  // gh-aw compiles `.md` workflows into `.lock.yml`; findings there are fixed in the source, not the generated file.
  ignorePaths: ["vendor/**", "node_modules/**", "**/node_modules/**", "dist/**", "build/**", ".github/workflows/*.lock.yml"],
  failOn: "error",
  limits: { maxFiles: 2e3, maxFileBytes: 512e3 },
  issues: {
    enabled: false,
    minSeverity: "error",
    minImpact: "low",
    groupBy: "rule",
    labels: [],
    assignees: [],
    assignCopilot: false,
    copilot: {},
    maxOpen: 10,
    closeResolved: true,
    rules: {}
  },
  fixes: {
    enabled: false,
    openPullRequestsLimit: 5,
    groups: {},
    ignore: [],
    labels: [],
    reviewers: [],
    branchPrefix: "cicd-optimizer/",
    draft: false
  },
  alerts: {
    enabled: true,
    minSamples: 10,
    window: 30,
    zThreshold: 3.5,
    minIncreasePercent: 20,
    minIncreaseSeconds: 30,
    regressionWindow: 5,
    pValue: 0.01,
    recoveryRuns: 3,
    snoozeDays: 14,
    branches: [],
    labels: [],
    assignees: [],
    assignCopilot: false
  },
  recipes: {
    enabled: true,
    maxRisk: "medium",
    ignore: [],
    labels: [],
    assignCopilot: true
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function levenshtein(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j] ?? 0;
      previous[j] = Math.min(
        above + 1,
        (previous[j - 1] ?? 0) + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length] ?? 0;
}
function didYouMean(value, candidates) {
  let best2;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(value, candidate);
    if (distance < bestDistance) {
      best2 = candidate;
      bestDistance = distance;
    }
  }
  return best2 !== void 0 && bestDistance <= Math.max(2, Math.floor(value.length / 3)) ? ` Did you mean "${best2}"?` : "";
}
var Validator = class {
  problems = [];
  problem(path, message) {
    this.problems.push({ path, message });
  }
  unknownKeys(path, value, allowed) {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.problem(`${path}${path ? "." : ""}${key}`, `Unknown key "${key}".${didYouMean(key, allowed)}`);
      }
    }
  }
  boolean(path, value, fallback) {
    if (value === void 0) return fallback;
    if (typeof value === "boolean") return value;
    this.problem(path, "Expected a boolean.");
    return fallback;
  }
  number(path, value, fallback, min = 0) {
    if (value === void 0) return fallback;
    if (typeof value === "number" && Number.isFinite(value) && value >= min) return value;
    this.problem(path, `Expected a number >= ${min}.`);
    return fallback;
  }
  string(path, value, fallback) {
    if (value === void 0) return fallback;
    if (typeof value === "string") return value;
    this.problem(path, "Expected a string.");
    return fallback;
  }
  strings(path, value, fallback) {
    if (value === void 0) return fallback;
    if (typeof value === "string") return [value];
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
    this.problem(path, "Expected a list of strings.");
    return fallback;
  }
  oneOf(path, value, allowed, fallback) {
    if (value === void 0) return fallback;
    if (typeof value === "string" && allowed.includes(value)) return value;
    this.problem(
      path,
      `Expected one of ${allowed.map((entry) => `"${entry}"`).join(", ")}.${typeof value === "string" ? didYouMean(value, [...allowed]) : ""}`
    );
    return fallback;
  }
  record(path, value) {
    if (value === void 0 || value === null) return {};
    if (isRecord(value)) return value;
    this.problem(path, "Expected a mapping.");
    return {};
  }
};
function normalizeSeverity(value) {
  if (value === 0) return "off";
  if (value === 1) return "warn";
  if (value === 2) return "error";
  if (value === "warning") return "warn";
  if (value === false) return "off";
  return value;
}
function migrateLegacyConfig(raw) {
  const legacyKeys = ["disabledRules", "failOnSeverity", "ignoredPaths", "maxFiles", "maxFileBytes"];
  if (!legacyKeys.some((key) => key in raw)) return void 0;
  const migrated = { ...raw };
  if (Array.isArray(raw.disabledRules)) {
    const rules9 = isRecord(raw.rules) ? { ...raw.rules } : {};
    for (const id of raw.disabledRules) {
      if (typeof id === "string") rules9[DEPRECATED_RULE_IDS[id] ?? id] = "off";
    }
    migrated.rules = rules9;
  }
  if ("failOnSeverity" in raw) {
    const map = { high: "error", medium: "warn", low: "info", never: "never" };
    migrated.failOn = map[String(raw.failOnSeverity)] ?? raw.failOnSeverity;
  }
  if ("ignoredPaths" in raw) migrated.ignorePaths = raw.ignoredPaths;
  if ("maxFiles" in raw || "maxFileBytes" in raw) {
    migrated.limits = {
      ...isRecord(raw.limits) ? raw.limits : {},
      ...raw.maxFiles !== void 0 ? { maxFiles: raw.maxFiles } : {},
      ...raw.maxFileBytes !== void 0 ? { maxFileBytes: raw.maxFileBytes } : {}
    };
  }
  for (const key of legacyKeys) delete migrated[key];
  return migrated;
}
function validateConfig(input2, rules9) {
  const v = new Validator();
  if (input2 === void 0 || input2 === null) return { config: structuredClone(DEFAULT_CONFIG), problems: [], migrated: false };
  if (!isRecord(input2)) {
    v.problem("", "Configuration must be a mapping.");
    return { config: structuredClone(DEFAULT_CONFIG), problems: v.problems, migrated: false };
  }
  const legacy = migrateLegacyConfig(input2);
  const raw = legacy ?? input2;
  v.unknownKeys("", raw, [
    "schemaVersion",
    "enabled",
    "extends",
    "rulesets",
    "rules",
    "ignorePaths",
    "failOn",
    "limits",
    "issues",
    "fixes",
    "alerts",
    "recipes"
  ]);
  if (raw.schemaVersion !== void 0 && raw.schemaVersion !== 1) {
    v.problem("schemaVersion", `Unsupported schemaVersion ${String(raw.schemaVersion)}; expected 1.`);
  }
  const ruleIds = rules9.map((rule) => rule.meta.id);
  const rulesetNames = [...new Set(rules9.map((rule) => rule.meta.ruleset))];
  const config = structuredClone(DEFAULT_CONFIG);
  config.enabled = v.boolean("enabled", raw.enabled, true);
  config.extends = v.strings("extends", raw.extends, DEFAULT_CONFIG.extends).filter((preset, index) => {
    if (PRESETS.includes(preset)) return true;
    v.problem(`extends[${index}]`, `Unknown preset "${preset}".${didYouMean(preset, PRESETS)}`);
    return false;
  });
  for (const [name, value] of Object.entries(v.record("rulesets", raw.rulesets))) {
    if (!rulesetNames.includes(name)) {
      v.problem(`rulesets.${name}`, `Unknown ruleset "${name}".${didYouMean(name, rulesetNames)}`);
      continue;
    }
    config.rulesets[name] = v.oneOf(`rulesets.${name}`, normalizeSeverity(value), SEVERITIES, "off");
  }
  for (const [rawId, value] of Object.entries(v.record("rules", raw.rules))) {
    const id = DEPRECATED_RULE_IDS[rawId] ?? rawId;
    if (id !== rawId) v.problem(`rules.${rawId}`, `Rule "${rawId}" is deprecated; use "${id}".`);
    const rule = rules9.find((candidate) => candidate.meta.id === id);
    if (!rule) {
      v.problem(`rules.${rawId}`, `Unknown rule "${rawId}".${didYouMean(rawId, ruleIds)}`);
      continue;
    }
    if (Array.isArray(value)) {
      const severity = v.oneOf(`rules.${rawId}[0]`, normalizeSeverity(value[0]), SEVERITIES, "off");
      const options = v.record(`rules.${rawId}[1]`, value[1]);
      const allowed = Object.keys(rule.meta.defaultOptions);
      v.unknownKeys(`rules.${rawId}[1]`, options, allowed);
      for (const message of rule.meta.validateOptions?.(options) ?? []) {
        v.problem(`rules.${rawId}[1]`, message);
      }
      config.rules[id] = [severity, options];
    } else {
      config.rules[id] = v.oneOf(`rules.${rawId}`, normalizeSeverity(value), SEVERITIES, "off");
    }
  }
  config.ignorePaths = v.strings("ignorePaths", raw.ignorePaths, DEFAULT_CONFIG.ignorePaths);
  config.failOn = v.oneOf("failOn", raw.failOn, ["info", "warn", "error", "never"], "error");
  const limits = v.record("limits", raw.limits);
  v.unknownKeys("limits", limits, ["maxFiles", "maxFileBytes"]);
  config.limits = {
    maxFiles: v.number("limits.maxFiles", limits.maxFiles, DEFAULT_CONFIG.limits.maxFiles, 1),
    maxFileBytes: v.number("limits.maxFileBytes", limits.maxFileBytes, DEFAULT_CONFIG.limits.maxFileBytes, 1)
  };
  const issues = v.record("issues", raw.issues);
  const issueDefaults = DEFAULT_CONFIG.issues;
  v.unknownKeys("issues", issues, Object.keys(issueDefaults));
  const copilot = v.record("issues.copilot", issues.copilot);
  v.unknownKeys("issues.copilot", copilot, ["baseBranch", "customInstructions", "customAgent", "model"]);
  const issueRules = {};
  for (const [id, value] of Object.entries(v.record("issues.rules", issues.rules))) {
    if (!ruleIds.includes(id)) v.problem(`issues.rules.${id}`, `Unknown rule "${id}".${didYouMean(id, ruleIds)}`);
    else issueRules[id] = v.boolean(`issues.rules.${id}`, value, true);
  }
  config.issues = {
    enabled: v.boolean("issues.enabled", issues.enabled, issueDefaults.enabled),
    minSeverity: v.oneOf("issues.minSeverity", issues.minSeverity, ["info", "warn", "error"], issueDefaults.minSeverity),
    minImpact: v.oneOf("issues.minImpact", issues.minImpact, IMPACTS, issueDefaults.minImpact),
    groupBy: v.oneOf("issues.groupBy", issues.groupBy, ["rule", "finding"], issueDefaults.groupBy),
    labels: v.strings("issues.labels", issues.labels, []),
    assignees: v.strings("issues.assignees", issues.assignees, []),
    assignCopilot: v.boolean("issues.assignCopilot", issues.assignCopilot, false),
    copilot: Object.fromEntries(
      Object.entries(copilot).map(([key, value]) => [key, v.string(`issues.copilot.${key}`, value, "")])
    ),
    maxOpen: v.number("issues.maxOpen", issues.maxOpen, issueDefaults.maxOpen, 0),
    closeResolved: v.boolean("issues.closeResolved", issues.closeResolved, true),
    rules: issueRules
  };
  const fixes = v.record("fixes", raw.fixes);
  const fixDefaults = DEFAULT_CONFIG.fixes;
  v.unknownKeys("fixes", fixes, Object.keys(fixDefaults));
  const groups = {};
  for (const [name, value] of Object.entries(v.record("fixes.groups", fixes.groups))) {
    const group = v.record(`fixes.groups.${name}`, value);
    v.unknownKeys(`fixes.groups.${name}`, group, ["rulesets", "rules"]);
    groups[name] = {
      ...group.rulesets !== void 0 ? { rulesets: v.strings(`fixes.groups.${name}.rulesets`, group.rulesets, []) } : {},
      ...group.rules !== void 0 ? { rules: v.strings(`fixes.groups.${name}.rules`, group.rules, []) } : {}
    };
  }
  const ignore = Array.isArray(fixes.ignore) ? fixes.ignore.flatMap((entry, index) => {
    const item = v.record(`fixes.ignore[${index}]`, entry);
    if (typeof item.rule !== "string") {
      v.problem(`fixes.ignore[${index}].rule`, "Expected a rule id.");
      return [];
    }
    return [{ rule: item.rule, ...item.paths !== void 0 ? { paths: v.strings(`fixes.ignore[${index}].paths`, item.paths, []) } : {} }];
  }) : [];
  config.fixes = {
    enabled: v.boolean("fixes.enabled", fixes.enabled, fixDefaults.enabled),
    openPullRequestsLimit: v.number("fixes.openPullRequestsLimit", fixes.openPullRequestsLimit, fixDefaults.openPullRequestsLimit, 0),
    groups,
    ignore,
    labels: v.strings("fixes.labels", fixes.labels, []),
    reviewers: v.strings("fixes.reviewers", fixes.reviewers, []),
    branchPrefix: v.string("fixes.branchPrefix", fixes.branchPrefix, fixDefaults.branchPrefix),
    draft: v.boolean("fixes.draft", fixes.draft, false)
  };
  const alerts = v.record("alerts", raw.alerts);
  const alertDefaults = DEFAULT_CONFIG.alerts;
  v.unknownKeys("alerts", alerts, Object.keys(alertDefaults));
  config.alerts = {
    enabled: v.boolean("alerts.enabled", alerts.enabled, alertDefaults.enabled),
    minSamples: v.number("alerts.minSamples", alerts.minSamples, alertDefaults.minSamples, 3),
    window: v.number("alerts.window", alerts.window, alertDefaults.window, 5),
    zThreshold: v.number("alerts.zThreshold", alerts.zThreshold, alertDefaults.zThreshold, 1),
    minIncreasePercent: v.number("alerts.minIncreasePercent", alerts.minIncreasePercent, alertDefaults.minIncreasePercent, 0),
    minIncreaseSeconds: v.number("alerts.minIncreaseSeconds", alerts.minIncreaseSeconds, alertDefaults.minIncreaseSeconds, 0),
    regressionWindow: v.number("alerts.regressionWindow", alerts.regressionWindow, alertDefaults.regressionWindow, 3),
    pValue: v.number("alerts.pValue", alerts.pValue, alertDefaults.pValue, 0),
    recoveryRuns: v.number("alerts.recoveryRuns", alerts.recoveryRuns, alertDefaults.recoveryRuns, 1),
    snoozeDays: v.number("alerts.snoozeDays", alerts.snoozeDays, alertDefaults.snoozeDays, 0),
    branches: v.strings("alerts.branches", alerts.branches, []),
    labels: v.strings("alerts.labels", alerts.labels, []),
    assignees: v.strings("alerts.assignees", alerts.assignees, []),
    assignCopilot: v.boolean("alerts.assignCopilot", alerts.assignCopilot, false)
  };
  const recipes = v.record("recipes", raw.recipes);
  const recipeDefaults = DEFAULT_CONFIG.recipes;
  v.unknownKeys("recipes", recipes, Object.keys(recipeDefaults));
  config.recipes = {
    enabled: v.boolean("recipes.enabled", recipes.enabled, recipeDefaults.enabled),
    maxRisk: v.oneOf("recipes.maxRisk", recipes.maxRisk, RECIPE_RISKS, recipeDefaults.maxRisk),
    ignore: v.strings("recipes.ignore", recipes.ignore, []),
    labels: v.strings("recipes.labels", recipes.labels, []),
    assignCopilot: v.boolean("recipes.assignCopilot", recipes.assignCopilot, recipeDefaults.assignCopilot)
  };
  return { config, problems: v.problems, migrated: legacy !== void 0 };
}
function parseConfigText(text, rules9, path = CONFIG_PATHS[0] ?? "config") {
  let raw;
  try {
    raw = (0, import_yaml13.parse)(text, { maxAliasCount: 100 });
  } catch (error) {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      problems: [{ path, message: `Invalid YAML: ${error instanceof Error ? error.message : String(error)}` }],
      migrated: false
    };
  }
  return validateConfig(raw, rules9);
}
function resolveRules(config, rules9, presetOverride) {
  const presets = presetOverride ?? config.extends;
  const severity = new Map(rules9.map((rule) => [rule.meta.id, "off"]));
  for (const preset of presets) {
    for (const rule of rules9) {
      if (preset === "all" || rule.meta.presets.includes(preset)) {
        severity.set(rule.meta.id, rule.meta.defaultSeverity);
      }
    }
  }
  for (const [ruleset, value] of Object.entries(config.rulesets)) {
    for (const rule of rules9) {
      if (rule.meta.ruleset === ruleset) severity.set(rule.meta.id, value);
    }
  }
  const options = /* @__PURE__ */ new Map();
  for (const [id, setting] of Object.entries(config.rules)) {
    if (Array.isArray(setting)) {
      severity.set(id, setting[0]);
      options.set(id, setting[1]);
    } else {
      severity.set(id, setting);
    }
  }
  return rules9.flatMap((rule) => {
    const level = severity.get(rule.meta.id) ?? "off";
    if (level === "off") return [];
    return [
      {
        rule,
        severity: level,
        options: { ...rule.meta.defaultOptions, ...options.get(rule.meta.id) ?? {} }
      }
    ];
  });
}

// src/lint/engine.ts
import { createHash } from "node:crypto";

// src/utils.ts
function matchesGlob(path, glob) {
  let regex = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        regex += "(?:.*/)?";
        index += 2;
      } else {
        regex += ".*";
        index += 1;
      }
    } else if (char === "*") regex += "[^/]*";
    else if (char === "?") regex += "[^/]";
    else regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${regex}$`).test(path);
}
async function mapLimit(items2, limit, fn) {
  const results = new Array(items2.length);
  let next = 0;
  const worker = async () => {
    while (next < items2.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items2[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items2.length) }, worker));
  return results;
}

// src/lint/parsers/manifest.ts
function isManifestPath(path) {
  return /(^|\/)package\.json$/i.test(path);
}
function stringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry) => typeof entry[1] === "string"
    )
  );
}
function parseManifest(path, content) {
  const json2 = JSON.parse(content);
  if (!json2 || typeof json2 !== "object" || Array.isArray(json2)) {
    throw new Error("package.json must contain a JSON object");
  }
  const record2 = json2;
  const lines = content.split(/\r?\n/);
  const slash = path.lastIndexOf("/");
  return {
    path,
    dir: slash >= 0 ? path.slice(0, slash) : "",
    json: record2,
    ...typeof record2.name === "string" ? { name: record2.name } : {},
    private: record2.private === true,
    dependencies: stringRecord(record2.dependencies),
    devDependencies: stringRecord(record2.devDependencies),
    lineOf(key) {
      const pattern = new RegExp(`^\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`);
      const index = lines.findIndex((line) => pattern.test(line));
      return index >= 0 ? index + 1 : 1;
    }
  };
}

// src/lint/project.ts
var LOCKFILES = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "bun.lock": "bun"
};
var TOOL_FILES = {
  "nx.json": "nx",
  "turbo.json": "turbo",
  "lerna.json": "lerna",
  "rush.json": "rush",
  "MODULE.bazel": "bazel",
  WORKSPACE: "bazel",
  "WORKSPACE.bazel": "bazel",
  "pants.toml": "pants",
  "settings.gradle": "gradle",
  "settings.gradle.kts": "gradle"
};
function known(value) {
  return { status: "known", value };
}
function unknown(value) {
  return { status: "unknown", value };
}
function workspaceGlobsFrom(root, files) {
  const globs = [];
  const workspaces = root?.json.workspaces;
  if (Array.isArray(workspaces)) globs.push(...workspaces.map(String));
  else if (workspaces && typeof workspaces === "object") {
    const packages = workspaces.packages;
    if (Array.isArray(packages)) globs.push(...packages.map(String));
  }
  const pnpm = files.get("pnpm-workspace.yaml");
  if (pnpm) {
    const parsed = parseYaml(pnpm.path, pnpm.content).doc.toJS();
    if (Array.isArray(parsed?.packages)) globs.push(...parsed.packages.map(String));
  }
  const lerna = files.get("lerna.json");
  if (lerna) {
    try {
      const parsed = JSON.parse(lerna.content);
      if (Array.isArray(parsed.packages)) globs.push(...parsed.packages.map(String));
    } catch {
    }
  }
  return [...new Set(globs.filter((glob) => !glob.startsWith("!")))];
}
function buildProject(input2) {
  const files = new Map(input2.files.map((file) => [file.path, file]));
  const parseProblems = [];
  const workflows = [];
  const actions = [];
  const dockerfiles = [];
  const manifests = [];
  for (const file of input2.files) {
    try {
      if (isWorkflowPath(file.path) || isActionPath(file.path)) {
        const model = parseWorkflow(file.path, file.content);
        for (const problem of parseErrors(model.source)) {
          parseProblems.push({ path: file.path, ...problem });
        }
        if (model.kind === "workflow") workflows.push(model);
        else actions.push(model);
      } else if (isDockerfilePath(file.path)) {
        dockerfiles.push(parseDockerfile(file.path, file.content));
      } else if (isManifestPath(file.path) && !file.path.includes("node_modules/")) {
        manifests.push(parseManifest(file.path, file.content));
      }
    } catch (error) {
      parseProblems.push({
        path: file.path,
        line: 1,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const repository = input2.mode === "repository";
  const complete = repository && input2.inventoryComplete;
  const rootManifest = manifests.find((manifest) => manifest.dir === "");
  const lockfiles = input2.files.map((file) => file.path).filter((path) => (path.split("/").pop() ?? "") in LOCKFILES);
  const rootLock = lockfiles.find((path) => !path.includes("/"));
  const declaredManager = typeof rootManifest?.json.packageManager === "string" ? rootManifest.json.packageManager.split("@")[0] : void 0;
  const packageManager = declaredManager ?? (rootLock ? LOCKFILES[rootLock] : void 0);
  const tools = [
    ...new Set(
      input2.files.map((file) => TOOL_FILES[file.path]).filter((tool2) => tool2 !== void 0)
    )
  ];
  const globs = workspaceGlobsFrom(rootManifest, files);
  const workspacePackages = manifests.filter(
    (manifest) => manifest.dir !== "" && (globs.length > 0 ? globs.some((glob) => matchesGlob(manifest.dir, glob) || matchesGlob(`${manifest.dir}/`, glob)) : tools.length > 0)
  );
  const isMonorepo = globs.length > 0 || tools.includes("nx") || tools.includes("turbo") || tools.includes("lerna") || tools.includes("rush") || tools.includes("bazel") || tools.includes("pants");
  const dockerignoreDirs = new Set(
    input2.files.filter((file) => /(^|\/)\.dockerignore$/.test(file.path) || /\.dockerignore$/.test(file.path)).map((file) => {
      const slash = file.path.lastIndexOf("/");
      return slash >= 0 ? file.path.slice(0, slash) : "";
    })
  );
  const actionByDir = /* @__PURE__ */ new Map();
  for (const action of actions) {
    const slash = action.path.lastIndexOf("/");
    actionByDir.set(slash >= 0 ? action.path.slice(0, slash) : "", action);
  }
  const localAction = (ref) => {
    const normalized = ref.replace(/^\.\//, "").replace(/\/$/, "");
    return actionByDir.get(normalized);
  };
  const expand = (steps2, depth, seen) => steps2.flatMap((step) => {
    const ref = step.uses?.action;
    if (ref?.kind !== "local" || depth >= 5) return [step];
    const action = localAction(ref.raw);
    if (!action || action.kind !== "composite-action" || seen.has(action.path)) return [step];
    const nested = action.jobs[0]?.steps ?? [];
    return [step, ...expand(nested, depth + 1, /* @__PURE__ */ new Set([...seen, action.path]))];
  });
  return {
    files,
    workflows,
    actions,
    dockerfiles,
    manifests,
    ...rootManifest ? { rootManifest } : {},
    facts: {
      packageManager: packageManager || complete ? known(packageManager) : unknown(packageManager),
      monorepoTools: complete || tools.length > 0 ? known(tools) : unknown(tools),
      workspaceGlobs: repository ? known(globs) : unknown(globs),
      workspacePackages: repository ? known(workspacePackages) : unknown(workspacePackages),
      isMonorepo: isMonorepo || repository ? known(isMonorepo) : unknown(false),
      lockfiles,
      dockerignoreDirs
    },
    parseProblems,
    localAction,
    expandedSteps: (job) => expand(job.steps, 0, /* @__PURE__ */ new Set())
  };
}

// src/lint/engine.ts
var DOCS_BASE = "https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/blob/main/docs/rules.md";
var SEVERITY_RANK = { info: 1, warn: 2, error: 3 };
var DIRECTIVE = /#\s*cicd-optimizer-disable-(next-line|file)\b([^\n]*)/;
var ruleAnchor = (ruleId) => ruleId.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
function docsUrl(ruleId) {
  return `${DOCS_BASE}#${ruleAnchor(ruleId)}`;
}
function parseIds(text) {
  const body = text.split(/\s--\s/)[0]?.trim() ?? "";
  if (!body) return "all";
  return new Set(body.split(/[\s,]+/).filter(Boolean));
}
function merge(existing, next) {
  if (existing === "all" || next === "all") return "all";
  return /* @__PURE__ */ new Set([...existing ?? [], ...next]);
}
function collectSuppressions(file) {
  const result = { file: void 0, lines: /* @__PURE__ */ new Map() };
  if (!file.content.includes("cicd-optimizer-disable")) return result;
  const isYaml = /\.ya?ml$/i.test(file.path);
  const blocks = isYaml ? parseYaml(file.path, file.content).blockScalarLines : [];
  const inBlock = (line) => blocks.some(([start, end]) => line >= start && line <= end);
  const lines = file.content.split(/\r?\n/);
  lines.forEach((text, index) => {
    const lineNumber = index + 1;
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("#") || inBlock(lineNumber)) return;
    const match2 = DIRECTIVE.exec(trimmed);
    if (!match2) return;
    const ids = parseIds(match2[2] ?? "");
    if (match2[1] === "file") {
      result.file = merge(result.file, ids);
      return;
    }
    let target = lineNumber + 1;
    while (target <= lines.length) {
      const candidate = (lines[target - 1] ?? "").trim();
      if (candidate !== "" && !candidate.startsWith("#")) break;
      target += 1;
    }
    result.lines.set(target, merge(result.lines.get(target), ids));
  });
  return result;
}
function suppressed(entry, diagnostic) {
  if (entry === void 0) return false;
  return entry === "all" || entry.has(diagnostic.ruleId) || entry.has(diagnostic.ruleset);
}
function unmet(requires, input2) {
  return requires.find((capability) => {
    if (capability === "repository") return input2.mode !== "repository";
    if (capability === "complete-inventory") return input2.mode !== "repository" || !input2.inventoryComplete;
    return input2.change === void 0;
  });
}
var UNMET_REASON = {
  repository: "needs the whole repository (run in repository mode)",
  "complete-inventory": "needs a complete file inventory; absence checks are unsafe on a partial view",
  "change-set": "needs the set of changed files (--base/--head or a pull request)"
};
function fingerprint(ruleId, path, discriminator) {
  return createHash("sha256").update(`${ruleId}\0${path}\0${discriminator}`).digest("hex").slice(0, 32);
}
function isRelevant(path) {
  return isWorkflowPath(path) || isActionPath(path) || /(^|\/)(Dockerfile|Containerfile)(\.[^/]+)?$/i.test(path) || /\.(dockerfile|containerfile)$/i.test(path) || /(^|\/)package\.json$/.test(path);
}
function filterInput(input2, ignorePaths) {
  return {
    ...input2,
    files: input2.files.filter(
      (file) => !ignorePaths.some((glob) => matchesGlob(file.path, glob) || matchesGlob(file.path, `${glob}/**`))
    )
  };
}
function lint(rawInput, options) {
  const started = performance.now();
  const input2 = filterInput(rawInput, options.config.ignorePaths);
  const project = buildProject(input2);
  const resolved = options.config.enabled ? resolveRules(options.config, options.rules, options.presets) : [];
  const skipped = [];
  const raw = [];
  let rulesRun = 0;
  for (const { rule, severity, options: ruleOptions } of resolved) {
    const missing = unmet(rule.meta.requires, input2);
    if (missing) {
      skipped.push({ ruleId: rule.meta.id, reason: UNMET_REASON[missing] });
      continue;
    }
    rulesRun += 1;
    const report = (descriptor) => {
      raw.push({
        ruleId: rule.meta.id,
        ruleset: rule.meta.ruleset,
        kind: rule.meta.kind,
        severity,
        message: descriptor.message,
        path: descriptor.path,
        line: Math.max(1, descriptor.line),
        column: Math.max(1, descriptor.column ?? 1),
        impact: descriptor.impact ?? rule.meta.impact,
        confidence: descriptor.confidence ?? "high",
        fingerprint: "",
        docsUrl: docsUrl(rule.meta.id),
        discriminator: descriptor.key ?? descriptor.message,
        ...descriptor.suggestion !== void 0 ? { suggestion: descriptor.suggestion } : {},
        ...descriptor.related ? { related: descriptor.related } : {},
        ...descriptor.fix ? { fix: descriptor.fix } : {}
      });
    };
    try {
      rule.check({ options: ruleOptions, project, input: input2, report });
    } catch (error) {
      skipped.push({
        ruleId: rule.meta.id,
        reason: `rule crashed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
  const suppressionCache = /* @__PURE__ */ new Map();
  const suppressionsFor = (path) => {
    const file = project.files.get(path);
    if (!file) return void 0;
    let entry = suppressionCache.get(path);
    if (!entry) {
      entry = collectSuppressions(file);
      suppressionCache.set(path, entry);
    }
    return entry;
  };
  const seen = /* @__PURE__ */ new Set();
  const occurrences = /* @__PURE__ */ new Map();
  const diagnostics = [];
  let suppressedCount = 0;
  for (const item of raw) {
    const dedupeKey = `${item.ruleId}\0${item.path}\0${item.line}\0${item.message}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const { discriminator, ...diagnostic } = item;
    const directives = suppressionsFor(diagnostic.path);
    if (directives && (suppressed(directives.file, diagnostic) || suppressed(directives.lines.get(diagnostic.line), diagnostic))) {
      suppressedCount += 1;
      continue;
    }
    const base2 = `${diagnostic.ruleId}\0${diagnostic.path}\0${discriminator}`;
    const count = occurrences.get(base2) ?? 0;
    occurrences.set(base2, count + 1);
    diagnostic.fingerprint = fingerprint(diagnostic.ruleId, diagnostic.path, count === 0 ? discriminator : `${discriminator}#${count}`);
    diagnostics.push(diagnostic);
  }
  const change = input2.change;
  if (change) {
    const changed = new Set(change.changedPaths);
    for (const diagnostic of diagnostics) {
      if (options.baseFingerprints && !options.baseFingerprints.has(diagnostic.fingerprint)) {
        diagnostic.scope = "introduced";
      } else {
        diagnostic.scope = changed.has(diagnostic.path) ? "changed-file" : "existing";
      }
    }
  }
  diagnostics.sort(
    (left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column || left.ruleId.localeCompare(right.ruleId)
  );
  return {
    diagnostics,
    skipped,
    parseProblems: project.parseProblems,
    filesAnalyzed: input2.files.filter((file) => isRelevant(file.path)).length,
    rulesRun,
    suppressed: suppressedCount,
    durationMs: Math.round(performance.now() - started)
  };
}
function exceedsThreshold(diagnostics, failOn) {
  if (failOn === "never") return false;
  return diagnostics.some((diagnostic) => SEVERITY_RANK[diagnostic.severity] >= SEVERITY_RANK[failOn]);
}
function atLeast(severity, minimum) {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}

// src/lint/docs.ts
function renderRulesMarkdown(rules9) {
  const rulesets = [...new Set(rules9.map((rule) => rule.meta.ruleset))];
  const lines = [
    "# Rules",
    "",
    "<!-- Generated by `npm run docs:rules`. Do not edit by hand. -->",
    "",
    "Each rule belongs to a ruleset. Enable presets with `extends`, toggle whole rulesets with `rulesets`, and tune",
    "individual rules with `rules` in `.github/ci-cd-optimizer.yml`. See [configuration](configuration.md).",
    "",
    `Presets: ${PRESETS.map((preset) => `\`${preset}\``).join(", ")}.`,
    "",
    "| Rule | Kind | Default | Presets | Fixable | Description |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rules9.map(
      (rule) => `| [\`${rule.meta.id}\`](#${ruleAnchor(rule.meta.id)}) | ${rule.meta.kind} | ${rule.meta.defaultSeverity} | ${rule.meta.presets.join(", ")} | ${rule.meta.fixable ? "yes" : ""} | ${rule.meta.description.replace(/\|/g, "\\|")} |`
    ),
    ""
  ];
  for (const ruleset of rulesets) {
    lines.push(`## Ruleset: ${ruleset}`, "");
    for (const rule of rules9.filter((candidate) => candidate.meta.ruleset === ruleset)) {
      const meta = rule.meta;
      lines.push(`<a id="${ruleAnchor(meta.id)}"></a>`, "", `### ${meta.id}`, "", meta.description, "", `**Why:** ${meta.rationale}`, "");
      lines.push(
        `- Kind: ${meta.kind}; default severity: ${meta.defaultSeverity}; impact: ${meta.impact}${meta.fixable ? "; autofix available" : ""}`,
        `- Presets: ${meta.presets.map((preset) => `\`${preset}\``).join(", ") || "none (opt-in)"}`
      );
      if (meta.requires.length > 0) lines.push(`- Requires: ${meta.requires.map((capability) => `\`${capability}\``).join(", ")}`);
      const options = Object.entries(meta.defaultOptions);
      if (options.length > 0) {
        lines.push(`- Options: ${options.map(([key, value]) => `\`${key}\` (default \`${JSON.stringify(value)}\`)`).join(", ")}`);
      }
      if (meta.example) {
        lines.push("", "Before:", "", "```yaml", meta.example.bad, "```", "", "After:", "", "```yaml", meta.example.good, "```");
      }
      if (meta.references.length > 0) {
        lines.push("", "References:", "", ...meta.references.map((reference) => `- <${reference}>`));
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}
`;
}

// src/version.ts
var VERSION = "0.2.0";

// src/cli/experiments.ts
var import_yaml20 = __toESM(require_dist(), 1);
import { appendFile, readdir as readdir3, readFile as readFile4, stat as stat3 } from "node:fs/promises";
import { join as join6 } from "node:path";
import { parseArgs as parseArgs2 } from "node:util";

// src/github/client.ts
function httpStatus(error) {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : void 0;
}
async function paginate(client, route, parameters, maxPages = 10) {
  const results = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await client.request(route, { ...parameters, per_page: 100, page });
    const data = response.data;
    results.push(...data);
    if (data.length < 100) break;
  }
  return results;
}
var LABEL_COLORS = {
  "cicd-optimizer": "0e8a16",
  "severity:error": "b60205",
  "severity:warn": "fbca04",
  "severity:info": "c5def5",
  "alert:duration": "d93f0b",
  "copilot:ready": "8250df",
  dependencies: "0366d6"
};
function colorFor(label) {
  if (LABEL_COLORS[label]) return LABEL_COLORS[label];
  if (label.startsWith("ruleset:")) return "1d76db";
  if (label.startsWith("impact:")) return "5319e7";
  if (label.startsWith("recipe:")) return "006b75";
  return "ededed";
}
async function ensureLabels(client, repo, labels) {
  if (labels.length === 0) return;
  const existing = new Set(
    (await paginate(client, "GET /repos/{owner}/{repo}/labels", { ...repo }, 5)).map((label) => label.name.toLowerCase())
  );
  for (const name of new Set(labels)) {
    if (existing.has(name.toLowerCase())) continue;
    try {
      await client.request("POST /repos/{owner}/{repo}/labels", { ...repo, name, color: colorFor(name) });
    } catch (error) {
      if (httpStatus(error) !== 422) throw error;
    }
  }
}

// src/github/git.ts
async function commitFiles(client, repo, baseSha, files, message) {
  const base2 = await client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { ...repo, commit_sha: baseSha });
  const baseTree = base2.data.tree.sha;
  const tree = await client.request("POST /repos/{owner}/{repo}/git/trees", {
    ...repo,
    base_tree: baseTree,
    tree: files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content }))
  });
  const commit = await client.request("POST /repos/{owner}/{repo}/git/commits", {
    ...repo,
    message,
    tree: tree.data.sha,
    parents: [baseSha]
  });
  return commit.data.sha;
}
async function pushBranch(client, repo, branch, sha, overwriteExisting = true) {
  try {
    await client.request("POST /repos/{owner}/{repo}/git/refs", { ...repo, ref: `refs/heads/${branch}`, sha });
  } catch (error) {
    if (httpStatus(error) !== 422 || !overwriteExisting) throw error;
    await client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { ...repo, ref: `heads/${branch}`, sha, force: true });
  }
}
async function deleteBranch(client, repo, branch) {
  if (!branch) return;
  try {
    await client.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { ...repo, ref: `heads/${branch}` });
  } catch (error) {
    if (![404, 422].includes(httpStatus(error) ?? 0)) throw error;
  }
}
async function branchSha(client, repo, branch) {
  const response = await client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { ...repo, ref: `heads/${branch}` });
  return response.data.object.sha;
}
async function readFileAt(client, repo, path, ref) {
  try {
    const response = await client.request("GET /repos/{owner}/{repo}/contents/{path}", { ...repo, path, ref });
    const data = response.data;
    if (typeof data.content !== "string") return void 0;
    return data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content;
  } catch (error) {
    if (httpStatus(error) === 404) return void 0;
    throw error;
  }
}

// src/experiments/manifest.ts
var import_yaml16 = __toESM(require_dist(), 1);
var EXPERIMENT_PREFIX = "experiments/";
var TRUNK = "trunk";
var NAME = /^[a-z0-9][a-z0-9-]{1,47}$/;
var trunkBranch = (experiment) => `${EXPERIMENT_PREFIX}${experiment}/${TRUNK}`;
var armBranch = (experiment, arm) => `${EXPERIMENT_PREFIX}${experiment}/${arm}`;
var manifestPath = (experiment) => `experiments/${experiment}/experiment.yml`;
function parseExperimentRef(ref) {
  const match2 = /^(?:refs\/heads\/)?experiments\/([^/]+)\/([^/]+)$/.exec(ref);
  if (!match2 || !NAME.test(match2[1]) || !NAME.test(match2[2])) return void 0;
  return { experiment: match2[1], arm: match2[2] };
}
function validateManifest(input2, options = {}) {
  const v = new Validator();
  const root = v.record("", input2);
  v.unknownKeys("", root, ["name", "title", "hypothesis", "kind", "metrics", "rubric", "arms", "createdAt", "expiresAt", "status", "winner", "applicability", "source", "evidence"]);
  const name = v.string("name", root.name, "");
  if (!NAME.test(name)) v.problem("name", "Use 2-48 lowercase letters, digits, or dashes.");
  const required = (key) => {
    const value = v.string(key, root[key], "");
    if (!value.trim()) v.problem(key, "Required.");
    return value;
  };
  const title = required("title");
  const hypothesis = required("hypothesis");
  const kind = v.oneOf("kind", root.kind, ["rules", "pipeline"], "rules");
  const rubricRaw = v.record("rubric", root.rubric);
  v.unknownKeys("rubric", rubricRaw, ["scores", "rationale"]);
  const scores = {};
  for (const [key, value] of Object.entries(v.record("rubric.scores", rubricRaw.scores))) {
    const score = v.number(`rubric.scores.${key}`, value, 0, 1);
    if (score > 5) v.problem(`rubric.scores.${key}`, "Scores range from 1 to 5.");
    scores[key] = score;
  }
  const arms = [];
  if (!Array.isArray(root.arms) || root.arms.length === 0) v.problem("arms", "Define at least one arm.");
  else {
    root.arms.forEach((entry, index) => {
      const path = `arms[${index}]`;
      const arm = v.record(path, entry);
      v.unknownKeys(path, arm, ["name", "title", "approach"]);
      const armName = v.string(`${path}.name`, arm.name, "");
      if (!NAME.test(armName) || armName === TRUNK) v.problem(`${path}.name`, `Use 2-48 lowercase letters, digits, or dashes (not "${TRUNK}").`);
      if (arms.some((other) => other.name === armName)) v.problem(`${path}.name`, `Duplicate arm "${armName}".`);
      arms.push({ name: armName, title: v.string(`${path}.title`, arm.title, armName), approach: v.string(`${path}.approach`, arm.approach, "") });
      if (!arms.at(-1)?.approach.trim()) v.problem(`${path}.approach`, "Describe how this arm differs.");
    });
  }
  const config = options.config;
  if (config && arms.length > config.selection.maxArms) v.problem("arms", `At most ${config.selection.maxArms} arms per experiment.`);
  const metrics = root.metrics === void 0 ? void 0 : v.strings("metrics", root.metrics, []);
  if (config && metrics) {
    for (const metric of metrics) if (!config.metrics.some((spec) => spec.id === metric)) v.problem("metrics", `Unknown metric "${metric}".`);
  }
  const createdAt = v.string("createdAt", root.createdAt, "");
  const expiresAt = v.string("expiresAt", root.expiresAt, "");
  for (const [key, value] of [["createdAt", createdAt], ["expiresAt", expiresAt]]) {
    if (Number.isNaN(Date.parse(value))) v.problem(key, "Expected an ISO 8601 timestamp.");
  }
  const manifest = {
    name,
    title,
    hypothesis,
    kind,
    ...metrics ? { metrics } : {},
    rubric: { scores, rationale: v.string("rubric.rationale", rubricRaw.rationale, "") },
    arms,
    createdAt,
    expiresAt,
    status: v.oneOf("status", root.status, ["running", "promoted", "rejected", "expired"], "running")
  };
  if (root.winner !== void 0) manifest.winner = v.string("winner", root.winner, "");
  if (root.applicability !== void 0) {
    const raw = v.record("applicability", root.applicability);
    v.unknownKeys("applicability", raw, ["rules", "files", "description"]);
    manifest.applicability = {
      ...raw.rules !== void 0 ? { rules: v.strings("applicability.rules", raw.rules, []) } : {},
      ...raw.files !== void 0 ? { files: v.strings("applicability.files", raw.files, []) } : {},
      ...raw.description !== void 0 ? { description: v.string("applicability.description", raw.description, "") } : {}
    };
  }
  if (root.source !== void 0) manifest.source = v.record("source", root.source);
  if (root.evidence !== void 0) {
    const raw = v.record("evidence", root.evidence);
    const metrics2 = Array.isArray(raw.metrics) ? raw.metrics : [];
    manifest.evidence = {
      improvement: v.number("evidence.improvement", raw.improvement, 0, -1),
      metrics: metrics2.flatMap((entry, index) => {
        const item = v.record(`evidence.metrics[${index}]`, entry);
        const optional = (key) => typeof item[key] === "number" ? { [key]: item[key] } : {};
        return [{ metric: v.string(`evidence.metrics[${index}].metric`, item.metric, ""), delta: v.number(`evidence.metrics[${index}].delta`, item.delta, 0, -1), ...optional("control"), ...optional("arm"), ...optional("pValue") }];
      })
    };
  }
  return v.problems.length === 0 ? { manifest, problems: [] } : { problems: v.problems };
}
function parseManifest2(text, options = {}) {
  try {
    return validateManifest((0, import_yaml16.parse)(text), options);
  } catch (error) {
    return { problems: [{ path: "experiment.yml", message: error.message }] };
  }
}
function serializeManifest(manifest) {
  return (0, import_yaml16.stringify)(manifest, { lineWidth: 0 });
}
function scoreRubric(scores, rubric) {
  const total = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0) || 1;
  const missing = rubric.criteria.filter((criterion) => scores[criterion.id] === void 0).map((criterion) => criterion.id);
  const weighted = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight * Math.min(5, Math.max(1, scores[criterion.id] ?? 1)), 0);
  const score = Math.round(weighted / total * 100) / 100;
  return { score, passed: missing.length === 0 && score >= rubric.minScore, missing };
}
function renderRubric(rubric) {
  return [
    `Score each criterion from 1 (poor) to 5 (excellent). Proposals need a weighted score of at least ${rubric.minScore}.`,
    "",
    "| Criterion | Weight | What a 5 looks like |",
    "| --- | --- | --- |",
    ...rubric.criteria.map((criterion) => `| \`${criterion.id}\` | ${criterion.weight} | ${criterion.description} |`)
  ].join("\n");
}

// src/alerts/stats.ts
function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function mad(values, center = median(values)) {
  return median(values.map((value) => Math.abs(value - center)));
}
function robustZ(value, center, deviation, madFloor2 = 0) {
  const scale = Math.max(deviation, madFloor2);
  if (scale === 0) return value === center ? 0 : Number.POSITIVE_INFINITY * Math.sign(value - center);
  return 0.6745 * (value - center) / scale;
}
function normalCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
function ranks(values) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array(values.length).fill(0);
  let tieTerm = 0;
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]?.value === order[start]?.value) end += 1;
    const average = (start + end + 2) / 2;
    for (let position = start; position <= end; position += 1) result[order[position]?.index ?? 0] = average;
    const size = end - start + 1;
    tieTerm += size ** 3 - size;
    start = end + 1;
  }
  return { ranks: result, tieTerm };
}
function exactUpperTail(m, n, u) {
  const maxU = m * n;
  let previous = Array.from({ length: n + 1 }, () => new Array(maxU + 1).fill(0));
  for (let j = 0; j <= n; j += 1) previous[j][0] = 1;
  for (let i = 1; i <= m; i += 1) {
    const current = Array.from({ length: n + 1 }, () => new Array(maxU + 1).fill(0));
    current[0][0] = 1;
    for (let j = 1; j <= n; j += 1) {
      const row = current[j];
      const left = current[j - 1];
      const up = previous[j];
      for (let k = 0; k <= i * j; k += 1) row[k] = (left[k] ?? 0) + (k - j >= 0 ? up[k - j] ?? 0 : 0);
    }
    previous = current;
  }
  const distribution = previous[n];
  const total = distribution.reduce((sum, count) => sum + count, 0);
  let tail2 = 0;
  for (let k = Math.ceil(u); k <= maxU; k += 1) tail2 += distribution[k] ?? 0;
  return tail2 / total;
}
function mannWhitneyGreater(sample, reference) {
  const m = sample.length;
  const n = reference.length;
  if (m === 0 || n === 0) return { u: 0, pValue: 1, method: "normal" };
  const { ranks: combined, tieTerm } = ranks([...sample, ...reference]);
  const rankSum = combined.slice(0, m).reduce((sum, rank) => sum + rank, 0);
  const u = rankSum - m * (m + 1) / 2;
  if (tieTerm === 0 && m * n <= 2500) return { u, pValue: exactUpperTail(m, n, u), method: "exact" };
  const total = m + n;
  const variance = m * n / 12 * (total + 1 - tieTerm / (total * (total - 1)));
  if (variance <= 0) return { u, pValue: 1, method: "normal" };
  const z = (u - m * n / 2 - 0.5) / Math.sqrt(variance);
  return { u, pValue: 1 - normalCdf(z), method: "normal" };
}

// src/experiments/score.ts
var EPSILON = 1e-9;
var clamp = (value) => Math.max(-1, Math.min(1, value));
var round = (value) => Math.round(value * 1e4) / 1e4;
function metricsFor(manifest, config) {
  if (manifest.metrics?.length) return config.metrics.filter((spec) => manifest.metrics?.includes(spec.id));
  const source = manifest.kind === "rules" ? "corpus" : "ci";
  return config.metrics.filter((spec) => spec.source === source);
}
function relativeDelta(spec, control, arm) {
  const change = spec.direction === "maximize" ? arm - control : control - arm;
  if (Math.abs(control) < EPSILON) return change === 0 ? 0 : clamp(Math.sign(change));
  return clamp(change / Math.abs(control));
}
function compare(spec, control, arm, config) {
  const base2 = { id: spec.id, weight: spec.weight, direction: spec.direction, delta: 0 };
  if (spec.source === "corpus") {
    const c2 = control.corpus?.[spec.id];
    const a2 = arm.corpus?.[spec.id];
    if (c2 === void 0 || a2 === void 0) return base2;
    return { ...base2, control: c2, arm: a2, delta: round(relativeDelta(spec, c2, a2)) };
  }
  const cSamples = control.ci?.[spec.id] ?? [];
  const aSamples = arm.ci?.[spec.id] ?? [];
  const minSamples = config.selection.minSamples;
  if (cSamples.length < minSamples || aSamples.length < minSamples) {
    return { ...base2, needs: { control: Math.max(0, minSamples - cSamples.length), arm: Math.max(0, minSamples - aSamples.length) } };
  }
  const c = median(cSamples);
  const a = median(aSamples);
  const delta = relativeDelta(spec, c, a);
  const better = delta > 0;
  const [high, low] = spec.direction === "minimize" === better ? [cSamples, aSamples] : [aSamples, cSamples];
  const pValue = mannWhitneyGreater(high, low).pValue;
  const significant = delta !== 0 && pValue < config.selection.pValue;
  return { ...base2, control: c, arm: a, pValue: round(pValue), delta: significant ? round(delta) : 0 };
}
function scoreArm(manifest, control, arm, config) {
  const specs = metricsFor(manifest, config);
  const metrics = specs.map((spec) => compare(spec, control, arm, config));
  const pending = [];
  const failures = [];
  if (arm.error) failures.push(`evaluation failed: ${arm.error}`);
  if (control.error) failures.push(`control evaluation failed: ${control.error}`);
  if (arm.testsPassed === false) failures.push("checks failed");
  if (arm.testsPassed === void 0 && !arm.error) pending.push("checks are still running");
  const touched = arm.changedPaths.filter((path) => config.protectedPaths.some((glob) => matchesGlob(path, glob)));
  if (touched.length > 0) failures.push(`modified protected paths: ${touched.join(", ")}`);
  for (const metric of metrics) {
    const spec = specs.find((candidate) => candidate.id === metric.id);
    if (metric.needs && (metric.needs.arm > 0 || metric.needs.control > 0)) pending.push(`${metric.id} needs more CI samples`);
    else if (metric.control === void 0 || metric.arm === void 0) {
      if (!arm.error && !control.error) pending.push(`${metric.id} has not been measured`);
    } else if (spec?.maxRegression !== void 0 && metric.delta < -spec.maxRegression) {
      failures.push(`${metric.id} regressed ${Math.round(-metric.delta * 100)}% (limit ${Math.round(spec.maxRegression * 100)}%)`);
    }
  }
  const totalWeight = metrics.reduce((sum, metric) => sum + metric.weight, 0) || 1;
  const deterministic = round(metrics.reduce((sum, metric) => sum + metric.weight * metric.delta, 0) / totalWeight);
  const cap = Math.max(0, Math.min(0.5, config.selection.judgeWeight));
  const judge = arm.judge ? Math.max(0, Math.min(1, arm.judge.score)) : void 0;
  const rank = round(judge === void 0 ? deterministic : (1 - cap) * deterministic + cap * (2 * judge - 1));
  return {
    arm: arm.arm,
    metrics,
    deterministic,
    rank,
    pending,
    failures,
    qualifies: failures.length === 0 && pending.length === 0 && deterministic >= config.selection.minImprovement
  };
}

// src/experiments/collect.ts
var seconds = (start, end) => {
  const value = (Date.parse(end ?? "") - Date.parse(start ?? "")) / 1e3;
  return Number.isFinite(value) && value >= 0 ? value : void 0;
};
async function ciSamples(client, repo, spec, options) {
  if (!spec.workflow) return [];
  const response = await client.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
    ...repo,
    workflow_id: spec.workflow,
    branch: options.branch,
    status: "success",
    created: `>=${options.since.slice(0, 10)}`,
    per_page: 100
  });
  const runs = (response.data.workflow_runs ?? []).filter((run3) => !options.headSha || run3.head_sha === options.headSha).slice(0, options.maxRuns ?? 30);
  const samples = [];
  for (const run3 of runs) {
    if (!spec.job) {
      const value2 = seconds(run3.run_started_at ?? run3.created_at, run3.updated_at);
      if (value2 !== void 0) samples.push(value2);
      continue;
    }
    const response2 = await client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", { ...repo, run_id: run3.id, per_page: 100 }).catch(() => void 0);
    const list3 = response2?.data?.jobs ?? [];
    const job = list3.find((candidate) => candidate.name === spec.job && candidate.conclusion === "success");
    const value = job ? seconds(job.started_at, job.completed_at) : void 0;
    if (value !== void 0) samples.push(value);
  }
  return samples;
}
var FAILED = /* @__PURE__ */ new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
async function checksPassed(client, repo, sha) {
  const response = await client.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...repo, ref: sha, per_page: 100 });
  const runs = response.data.check_runs ?? [];
  if (runs.length === 0) return void 0;
  if (runs.some((run3) => run3.conclusion && FAILED.has(run3.conclusion))) return false;
  if (runs.some((run3) => run3.status !== "completed")) return void 0;
  return true;
}
async function changedPaths(client, repo, base2, head) {
  const response = await client.request("GET /repos/{owner}/{repo}/compare/{basehead}", { ...repo, basehead: `${base2}...${head}`, per_page: 300 });
  return (response.data.files ?? []).flatMap(
    (file) => file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]
  );
}
async function collectMeasurements(client, repo, options) {
  const { manifest, state, config } = options;
  const ciSpecs = metricsFor(manifest, config).filter((spec) => spec.source === "ci");
  const trunk = trunkBranch(manifest.name);
  const measure = async (branch, arm, headSha, pullRequest) => {
    const measurement = { arm, changedPaths: [], ...headSha ? { headSha } : {}, ...pullRequest ? { pullRequest } : {} };
    try {
      if (ciSpecs.length > 0) {
        measurement.ci = {};
        for (const spec of ciSpecs) {
          measurement.ci[spec.id] = await ciSamples(client, repo, spec, { branch, since: manifest.createdAt, ...headSha ? { headSha } : {} });
        }
      }
      if (arm !== "trunk" && headSha) {
        measurement.changedPaths = await changedPaths(client, repo, trunk, headSha);
        const passed = await checksPassed(client, repo, headSha);
        if (passed !== void 0) measurement.testsPassed = passed;
      } else {
        measurement.testsPassed = true;
      }
    } catch (error) {
      measurement.error = error.message;
    }
    return measurement;
  };
  const control = await measure(trunk, "trunk", state.trunk?.headSha);
  const arms = [];
  for (const spec of manifest.arms) {
    const pull = state.arms.find((candidate) => candidate.arm === spec.name && candidate.state === "open");
    if (pull) arms.push(await measure(armBranch(manifest.name, spec.name), spec.name, pull.headSha, pull.number));
  }
  return { experiment: manifest.name, collectedAt: (options.now ?? /* @__PURE__ */ new Date()).toISOString(), control, arms };
}
function mergeMeasurement(measurements, update) {
  const apply = (branch) => {
    const merged = { ...branch, ...update, changedPaths: update.changedPaths ?? branch.changedPaths };
    if (branch.testsPassed === false || update.testsPassed === false) merged.testsPassed = false;
    return merged;
  };
  if (update.arm === "trunk") return { ...measurements, control: apply(measurements.control) };
  const exists = measurements.arms.some((arm) => arm.arm === update.arm);
  return {
    ...measurements,
    arms: exists ? measurements.arms.map((arm) => arm.arm === update.arm ? apply(arm) : arm) : [...measurements.arms, { changedPaths: [], ...update }]
  };
}

// src/experiments/config.ts
var import_yaml17 = __toESM(require_dist(), 1);
var HILL_CLIMB_CONFIG_PATH = ".github/hill-climb.yml";
var CORPUS_METRICS = ["precision", "recall", "f1", "fixRate", "durationMs"];
var DEFAULT_RUBRIC = {
  minScore: 3.5,
  criteria: [
    { id: "impact", weight: 0.3, description: "Expected reduction in build, test, or release wall-clock time for high-volume agent-authored changes." },
    { id: "evidence", weight: 0.2, description: "Grounded in this repository's telemetry or findings, or in authoritative platform documentation." },
    { id: "safety", weight: 0.2, description: "Preserves security, hermeticity, required checks, and deploy correctness; easy to revert." },
    { id: "generality", weight: 0.15, description: "Likely to transfer to other repositories as a rule or recipe rather than a one-off tweak." },
    { id: "measurability", weight: 0.15, description: "Success is measurable with the configured metrics within the experiment window." }
  ]
};
var DEFAULT_HILL_CLIMB_CONFIG = {
  rubric: DEFAULT_RUBRIC,
  metrics: [
    { id: "precision", source: "corpus", direction: "maximize", weight: 0.35, maxRegression: 0.02 },
    { id: "recall", source: "corpus", direction: "maximize", weight: 0.35, maxRegression: 0.05 },
    { id: "fixRate", source: "corpus", direction: "maximize", weight: 0.15 },
    { id: "durationMs", source: "corpus", direction: "minimize", weight: 0.15, maxRegression: 0.5 }
  ],
  selection: { judgeWeight: 0.2, minSamples: 5, pValue: 0.05, minImprovement: 0.02, maxAgeDays: 14, maxConcurrent: 3, maxArms: 4 },
  protectedPaths: [".github/hill-climb.yml", "experiments/*/experiment.yml", "corpus/**"],
  promotion: { autoMerge: false, reviewers: [], labels: [] },
  evaluation: { corpus: "corpus", engine: "dist/lint/api.js", install: "npm ci --ignore-scripts", build: "npm run build", test: "npm test", timingRuns: 3 }
};
function validateHillClimbConfig(input2) {
  const v = new Validator();
  const defaults = DEFAULT_HILL_CLIMB_CONFIG;
  const root = v.record("", input2);
  v.unknownKeys("", root, Object.keys(defaults));
  const rubricRaw = v.record("rubric", root.rubric);
  v.unknownKeys("rubric", rubricRaw, ["minScore", "criteria"]);
  let criteria = defaults.rubric.criteria;
  if (rubricRaw.criteria !== void 0) {
    if (!Array.isArray(rubricRaw.criteria) || rubricRaw.criteria.length === 0) v.problem("rubric.criteria", "Expected a non-empty list.");
    else {
      criteria = rubricRaw.criteria.map((entry, index) => {
        const path = `rubric.criteria[${index}]`;
        const item = v.record(path, entry);
        v.unknownKeys(path, item, ["id", "weight", "description"]);
        return { id: v.string(`${path}.id`, item.id, `criterion-${index}`), weight: v.number(`${path}.weight`, item.weight, 1), description: v.string(`${path}.description`, item.description, "") };
      });
    }
  }
  const rubric = { minScore: v.number("rubric.minScore", rubricRaw.minScore, defaults.rubric.minScore, 1), criteria };
  if (rubric.minScore > 5) v.problem("rubric.minScore", "Expected a number between 1 and 5.");
  let metrics = defaults.metrics;
  if (root.metrics !== void 0) {
    if (!Array.isArray(root.metrics) || root.metrics.length === 0) v.problem("metrics", "Expected a non-empty list.");
    else {
      metrics = root.metrics.map((entry, index) => {
        const path = `metrics[${index}]`;
        const item = v.record(path, entry);
        v.unknownKeys(path, item, ["id", "source", "direction", "weight", "workflow", "job", "maxRegression"]);
        const metric = {
          id: v.string(`${path}.id`, item.id, `metric-${index}`),
          source: v.oneOf(`${path}.source`, item.source, ["corpus", "ci"], "corpus"),
          direction: v.oneOf(`${path}.direction`, item.direction, ["maximize", "minimize"], "maximize"),
          weight: v.number(`${path}.weight`, item.weight, 1)
        };
        if (item.workflow !== void 0) metric.workflow = v.string(`${path}.workflow`, item.workflow, "");
        if (item.job !== void 0) metric.job = v.string(`${path}.job`, item.job, "");
        if (item.maxRegression !== void 0) metric.maxRegression = v.number(`${path}.maxRegression`, item.maxRegression, 0);
        if (metric.source === "corpus" && !CORPUS_METRICS.includes(metric.id)) {
          v.problem(`${path}.id`, `Corpus metrics are ${CORPUS_METRICS.join(", ")}.`);
        }
        if (metric.source === "ci" && !metric.workflow) v.problem(`${path}.workflow`, "CI metrics need the workflow file to measure.");
        return metric;
      });
    }
  }
  const selectionRaw = v.record("selection", root.selection);
  v.unknownKeys("selection", selectionRaw, Object.keys(defaults.selection));
  const s = defaults.selection;
  const selection = {
    judgeWeight: v.number("selection.judgeWeight", selectionRaw.judgeWeight, s.judgeWeight),
    minSamples: v.number("selection.minSamples", selectionRaw.minSamples, s.minSamples, 2),
    pValue: v.number("selection.pValue", selectionRaw.pValue, s.pValue),
    minImprovement: v.number("selection.minImprovement", selectionRaw.minImprovement, s.minImprovement),
    maxAgeDays: v.number("selection.maxAgeDays", selectionRaw.maxAgeDays, s.maxAgeDays, 1),
    maxConcurrent: v.number("selection.maxConcurrent", selectionRaw.maxConcurrent, s.maxConcurrent, 1),
    maxArms: v.number("selection.maxArms", selectionRaw.maxArms, s.maxArms, 1)
  };
  if (selection.judgeWeight > 0.5) v.problem("selection.judgeWeight", "Keep the judge weight at or below 0.5 so measurements dominate.");
  if (selection.pValue >= 1) v.problem("selection.pValue", "Expected a probability below 1.");
  const promotionRaw = v.record("promotion", root.promotion);
  v.unknownKeys("promotion", promotionRaw, Object.keys(defaults.promotion));
  const promotion = {
    autoMerge: v.boolean("promotion.autoMerge", promotionRaw.autoMerge, defaults.promotion.autoMerge),
    reviewers: v.strings("promotion.reviewers", promotionRaw.reviewers, defaults.promotion.reviewers),
    labels: v.strings("promotion.labels", promotionRaw.labels, defaults.promotion.labels)
  };
  const evaluationRaw = v.record("evaluation", root.evaluation);
  v.unknownKeys("evaluation", evaluationRaw, Object.keys(defaults.evaluation));
  const e = defaults.evaluation;
  const evaluation = {
    corpus: v.string("evaluation.corpus", evaluationRaw.corpus, e.corpus),
    engine: v.string("evaluation.engine", evaluationRaw.engine, e.engine),
    install: v.string("evaluation.install", evaluationRaw.install, e.install),
    build: v.string("evaluation.build", evaluationRaw.build, e.build),
    test: v.string("evaluation.test", evaluationRaw.test, e.test),
    timingRuns: v.number("evaluation.timingRuns", evaluationRaw.timingRuns, e.timingRuns, 1)
  };
  return {
    config: { rubric, metrics, selection, protectedPaths: v.strings("protectedPaths", root.protectedPaths, defaults.protectedPaths), promotion, evaluation },
    problems: v.problems
  };
}
function parseHillClimbConfig(text) {
  if (text === void 0) return { config: structuredClone(DEFAULT_HILL_CLIMB_CONFIG), problems: [] };
  try {
    const raw = (0, import_yaml17.parse)(text);
    return validateHillClimbConfig(raw ?? {});
  } catch (error) {
    return { config: structuredClone(DEFAULT_HILL_CLIMB_CONFIG), problems: [{ path: HILL_CLIMB_CONFIG_PATH, message: error.message }] };
  }
}

// src/experiments/corpus.ts
var import_yaml18 = __toESM(require_dist(), 1);
import { readdir, readFile, stat } from "node:fs/promises";
import { join as join2, relative as relative2, sep } from "node:path";
var ratio = (numerator, denominator) => denominator === 0 ? 1 : numerator / denominator;
var inScope = (scope2, rule) => scope2.includes("*") || scope2.includes(rule);
var toPosix = (path) => path.split(sep).join("/");
function match(diagnostics, expected) {
  const remaining = [...expected];
  const matched = [];
  const unmatched = [];
  for (const diagnostic of diagnostics) {
    const index = remaining.findIndex(
      (finding) => finding.rule === diagnostic.ruleId && finding.path === diagnostic.path && (finding.line === void 0 || finding.line === diagnostic.line)
    );
    if (index === -1) unmatched.push(diagnostic);
    else {
      matched.push(diagnostic);
      remaining.splice(index, 1);
    }
  }
  return { matched, unmatched, missed: remaining };
}
function evaluateCase(engine, testCase) {
  const input2 = {
    files: testCase.files,
    mode: "repository",
    inventoryComplete: testCase.inventoryComplete,
    ...testCase.change ? { change: testCase.change } : {}
  };
  try {
    const diagnostics = engine.lint({ input: input2, presets: ["all"] }).diagnostics.filter((d) => inScope(testCase.rules, d.ruleId));
    const { matched, unmatched, missed } = match(diagnostics, testCase.expected);
    const fixable = matched.filter((diagnostic) => diagnostic.fix);
    let fixed = 0;
    if (fixable.length > 0) {
      const result = engine.applyFixes(testCase.files, fixable);
      const after = testCase.files.map((file) => ({ path: file.path, content: result.files.get(file.path) ?? file.content }));
      const remaining = engine.lint({ input: { ...input2, files: after }, presets: ["all"] }).diagnostics;
      const contentsMatch = Object.entries(testCase.fixed ?? {}).every(([path, content]) => result.files.get(path) === content);
      if (contentsMatch) {
        const pending = [...remaining];
        for (const diagnostic of fixable) {
          const index = pending.findIndex((other) => other.ruleId === diagnostic.ruleId && other.path === diagnostic.path);
          if (index === -1) fixed += 1;
          else pending.splice(index, 1);
        }
      }
    }
    return {
      id: testCase.id,
      tp: matched.length,
      fp: unmatched.length,
      fn: missed.length,
      fixable: fixable.length,
      fixed,
      falsePositives: unmatched.map((d) => ({ rule: d.ruleId, path: d.path, line: d.line })),
      falseNegatives: missed
    };
  } catch (error) {
    return { id: testCase.id, tp: 0, fp: 0, fn: testCase.expected.length, fixable: 0, fixed: 0, falsePositives: [], falseNegatives: testCase.expected, error: error.message };
  }
}
function evaluateCorpus(engine, cases, options = {}) {
  const now = options.now ?? (() => performance.now());
  const results = cases.map((testCase) => evaluateCase(engine, testCase));
  const timings = [];
  for (let run3 = 0; run3 < Math.max(1, options.timingRuns ?? 3); run3 += 1) {
    const start = now();
    for (const testCase of cases) {
      try {
        engine.lint({
          input: { files: testCase.files, mode: "repository", inventoryComplete: testCase.inventoryComplete, ...testCase.change ? { change: testCase.change } : {} },
          presets: ["all"]
        });
      } catch {
      }
    }
    timings.push(now() - start);
  }
  timings.sort((a, b) => a - b);
  const sum = (key) => results.reduce((total, result) => total + result[key], 0);
  const totals = { tp: sum("tp"), fp: sum("fp"), fn: sum("fn"), fixable: sum("fixable"), fixed: sum("fixed"), cases: results.length, errors: results.filter((r) => r.error).length };
  const precision = ratio(totals.tp, totals.tp + totals.fp);
  const recall = ratio(totals.tp, totals.tp + totals.fn);
  const round2 = (value) => Math.round(value * 1e4) / 1e4;
  return {
    metrics: {
      precision: round2(precision),
      recall: round2(recall),
      f1: round2(precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall)),
      fixRate: round2(ratio(totals.fixed, totals.fixable)),
      durationMs: Math.round((timings[Math.floor(timings.length / 2)] ?? 0) * 100) / 100
    },
    totals,
    cases: results
  };
}
async function walk(root, directory = root) {
  const entries2 = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries2.map(async (entry) => {
      const path = join2(directory, entry.name);
      return entry.isDirectory() ? walk(root, path) : [toPosix(relative2(root, path))];
    })
  );
  return files.flat().sort();
}
function parseCase(id, text, files) {
  const raw = (0, import_yaml18.parse)(text) ?? {};
  const expected = Array.isArray(raw.expected) ? raw.expected.map((entry) => {
    const item = entry;
    if (typeof item.rule !== "string" || typeof item.path !== "string") throw new Error(`${id}: expected entries need rule and path`);
    return { rule: item.rule, path: item.path, ...typeof item.line === "number" ? { line: item.line } : {} };
  }) : [];
  const declared = Array.isArray(raw.rules) ? raw.rules.filter((rule) => typeof rule === "string") : [];
  const rules9 = [.../* @__PURE__ */ new Set([...declared, ...expected.map((finding) => finding.rule)])];
  const change = raw.change;
  return {
    id,
    description: typeof raw.description === "string" ? raw.description : id,
    rules: rules9.length > 0 ? rules9 : ["*"],
    expected,
    files,
    inventoryComplete: raw.inventoryComplete !== false,
    ...change ? {
      change: {
        event: change.event ?? "pull_request",
        changedPaths: Array.isArray(change.changedPaths) ? change.changedPaths : [],
        ...typeof change.baseSha === "string" ? { baseSha: change.baseSha } : {},
        ...typeof change.headSha === "string" ? { headSha: change.headSha } : {}
      }
    } : {},
    ...raw.fixed && typeof raw.fixed === "object" ? { fixed: raw.fixed } : {}
  };
}
async function loadCorpus(directory) {
  const ids = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return Promise.all(
    ids.map(async (id) => {
      const caseDir = join2(directory, id);
      const filesDir = join2(caseDir, "files");
      const exists = await stat(filesDir).then((info) => info.isDirectory(), () => false);
      const paths = exists ? await walk(filesDir) : [];
      const files = await Promise.all(paths.map(async (path) => ({ path, content: await readFile(join2(filesDir, path), "utf8") })));
      return parseCase(id, await readFile(join2(caseDir, "case.yml"), "utf8"), files);
    })
  );
}
async function loadEngine(modulePath, expectedVersion) {
  const { pathToFileURL } = await import("node:url");
  const engine = await import(pathToFileURL(modulePath).href);
  if (engine.ENGINE_API_VERSION !== expectedVersion) {
    throw new Error(`Engine at ${modulePath} speaks API v${String(engine.ENGINE_API_VERSION)}; the evaluator expects v${expectedVersion}.`);
  }
  if (typeof engine.lint !== "function" || typeof engine.applyFixes !== "function") throw new Error(`Engine at ${modulePath} is missing lint/applyFixes.`);
  return engine;
}

// src/experiments/decide.ts
var DAY = 864e5;
function isExpired(manifest, config, now) {
  const expires = Date.parse(manifest.expiresAt);
  const maxAge = Date.parse(manifest.createdAt) + config.selection.maxAgeDays * DAY;
  return now.getTime() >= Math.min(Number.isNaN(expires) ? Infinity : expires, Number.isNaN(maxAge) ? Infinity : maxAge);
}
function best(scores) {
  return scores.filter((score) => score.qualifies).sort((a, b) => b.rank - a.rank || b.deterministic - a.deterministic || a.arm.localeCompare(b.arm))[0];
}
function decide(manifest, measurements, config, options) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const scores = manifest.arms.map((spec) => {
    const measured = measurements.arms.find((arm) => arm.arm === spec.name);
    if (!measured) {
      return { arm: spec.name, metrics: [], deterministic: 0, rank: 0, pending: ["arm has not been built yet"], failures: [], qualifies: false };
    }
    return scoreArm(manifest, measurements.control, measured, config);
  });
  if (manifest.status !== "running") return { action: "skip", reason: `experiment is ${manifest.status}`, scores };
  const expired = isExpired(manifest, config, now);
  const winner = best(scores);
  const pending = scores.filter((score) => score.pending.length > 0 && score.failures.length === 0);
  const losers = (name) => manifest.arms.map((arm) => arm.name).filter((arm) => arm !== name);
  if (winner && (pending.length === 0 || expired)) {
    return { action: "promote", winner: winner.arm, losers: losers(winner.arm), reason: `${winner.arm} improved the weighted metrics by ${(winner.deterministic * 100).toFixed(1)}%`, scores };
  }
  if (expired) return { action: "expire", reason: `no arm qualified within ${config.selection.maxAgeDays} days`, scores };
  if (pending.length === 0) {
    const leader = [...scores].sort((a, b) => b.deterministic - a.deterministic)[0];
    const why = leader?.failures.length ? leader.failures.join("; ") : `best improvement ${(Math.max(0, leader?.deterministic ?? 0) * 100).toFixed(1)}% is below the ${(config.selection.minImprovement * 100).toFixed(1)}% bar`;
    return { action: "reject", reason: `no arm qualified (${why})`, scores };
  }
  const dispatch = [];
  const ciSpecs = metricsFor(manifest, config).filter((spec) => spec.source === "ci" && spec.workflow);
  for (const spec of ciSpecs) {
    let control = 0;
    for (const score of pending) {
      const needs = score.metrics.find((metric) => metric.id === spec.id)?.needs;
      if (!needs) continue;
      control = Math.max(control, needs.control);
      if (needs.arm > 0) dispatch.push({ ref: options.armRef(score.arm), arm: score.arm, workflow: spec.workflow, runs: needs.arm });
    }
    if (control > 0) dispatch.push({ ref: options.trunkRef, arm: "trunk", workflow: spec.workflow, runs: control });
  }
  const merged = /* @__PURE__ */ new Map();
  for (const request of dispatch) {
    const key = `${request.ref}\0${request.workflow}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, runs: Math.max(existing.runs, request.runs) } : request);
  }
  return { action: "wait", reason: `${pending.length} arm(s) still collecting evidence`, scores, dispatch: [...merged.values()] };
}
var pct = (value) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
var fmt = (value) => value === void 0 ? "\u2013" : Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
function renderDecision(manifest, decision) {
  const heading = {
    skip: "\u23ED\uFE0F Skipped",
    wait: "\u23F3 Collecting evidence",
    promote: `\u{1F3C6} Promoting \`${decision.action === "promote" ? decision.winner : ""}\``,
    reject: "\u274C Rejected",
    expire: "\u231B Expired"
  }[decision.action];
  const metricIds = [...new Set(decision.scores.flatMap((score) => score.metrics.map((metric) => metric.id)))];
  const lines = [
    `### ${heading}: ${manifest.title}`,
    "",
    `**Hypothesis:** ${manifest.hypothesis}`,
    "",
    `**Decision:** ${decision.reason}`,
    "",
    `| Arm | ${metricIds.map((id) => `\`${id}\``).join(" | ")} | Score | Rank | Status |`,
    `| --- | ${metricIds.map(() => "---").join(" | ")} | --- | --- | --- |`,
    ...decision.scores.map((score) => {
      const cells = metricIds.map((id) => {
        const metric = score.metrics.find((candidate) => candidate.id === id);
        if (!metric || metric.arm === void 0) return metric?.needs ? `needs ${metric.needs.arm} run(s)` : "\u2013";
        const p = metric.pValue === void 0 ? "" : ` (p=${metric.pValue.toFixed(3)})`;
        return `${fmt(metric.control)} \u2192 ${fmt(metric.arm)} ${pct(metric.delta)}${p}`;
      });
      const status = score.failures.length ? `\u274C ${score.failures.join("; ")}` : score.pending.length ? `\u23F3 ${score.pending.join("; ")}` : score.qualifies ? "\u2705 qualifies" : "\u2796 no measurable gain";
      return `| \`${score.arm}\` | ${cells.join(" | ")} | ${pct(score.deterministic)} | ${score.rank.toFixed(3)} | ${status} |`;
    })
  ];
  if (decision.action === "wait" && decision.dispatch.length > 0) {
    lines.push("", "Requested additional runs:", ...decision.dispatch.map((request) => `- \`${request.workflow}\` on \`${request.ref}\` \xD7 ${request.runs}`));
  }
  lines.push("", "<sub>Scores are relative improvements over the experiment trunk (control). The judge can only reorder arms that already pass every gate.</sub>");
  return lines.join("\n");
}

// src/experiments/evaluate.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
var quote = (value) => `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
var tail = (text, lines = 20) => text.trim().split("\n").slice(-lines).join("\n");
async function evaluateBranches(options) {
  const { root, config, exec } = options;
  const log = options.log ?? (() => void 0);
  const load = options.loadEngine ?? loadEngine;
  const workdir = options.workdir ?? await mkdtemp(join3(tmpdir(), "cicd-eval-"));
  const git2 = (args) => exec(`git ${args}`, { cwd: root });
  const evaluations = [];
  let cases;
  let corpusError;
  const branches = [options.measurements.control, ...options.measurements.arms];
  for (const branch of branches) {
    const evaluation = { arm: branch.arm, ...branch.headSha ? { headSha: branch.headSha } : {} };
    evaluations.push(evaluation);
    if (!branch.headSha) {
      evaluation.error = "no head commit to evaluate";
      continue;
    }
    const dir = join3(workdir, branch.arm);
    try {
      if ((await git2(`cat-file -e ${branch.headSha}^{commit}`)).code !== 0) {
        const fetched = await git2(`fetch --no-tags origin ${branch.headSha}`);
        if (fetched.code !== 0) throw new Error(`git fetch failed:
${tail(fetched.output)}`);
      }
      const added = await git2(`worktree add --force --detach ${quote(dir)} ${branch.headSha}`);
      if (added.code !== 0) throw new Error(`git worktree add failed:
${tail(added.output)}`);
      if (branch.arm === "trunk") {
        try {
          cases = await (options.loadCorpus ?? loadCorpus)(join3(dir, config.evaluation.corpus));
        } catch (error) {
          corpusError = `cannot load corpus: ${error.message}`;
        }
      }
      if (!cases) throw new Error(corpusError ?? "control was not evaluated");
      for (const [step, command] of [
        ["install", config.evaluation.install],
        ["build", config.evaluation.build]
      ]) {
        if (!command) continue;
        log(`[${branch.arm}] ${step}: ${command}`);
        const result = await exec(command, { cwd: dir });
        if (result.code !== 0) throw new Error(`${step} failed (exit ${result.code}):
${tail(result.output)}`);
      }
      if (config.evaluation.test) {
        log(`[${branch.arm}] test: ${config.evaluation.test}`);
        const result = await exec(config.evaluation.test, { cwd: dir });
        evaluation.testsPassed = result.code === 0;
        if (!evaluation.testsPassed) log(`[${branch.arm}] tests failed:
${tail(result.output)}`);
      } else {
        evaluation.testsPassed = true;
      }
      const engine = await load(join3(dir, config.evaluation.engine), options.engineVersion);
      evaluation.report = evaluateCorpus(engine, cases, { timingRuns: config.evaluation.timingRuns });
      log(`[${branch.arm}] ${JSON.stringify(evaluation.report.metrics)}`);
    } catch (error) {
      evaluation.error = error.message;
      log(`[${branch.arm}] ${evaluation.error}`);
    } finally {
      await git2(`worktree remove --force ${quote(dir)}`).catch(() => void 0);
    }
  }
  if (!options.workdir) await rm(workdir, { recursive: true, force: true }).catch(() => void 0);
  let measurements = options.measurements;
  for (const evaluation of evaluations) {
    measurements = mergeMeasurement(measurements, {
      arm: evaluation.arm,
      ...evaluation.report ? { corpus: evaluation.report.metrics } : {},
      ...evaluation.testsPassed !== void 0 ? { testsPassed: evaluation.testsPassed } : {},
      ...evaluation.error ? { error: evaluation.error } : {}
    });
  }
  return { measurements, evaluations };
}

// src/issues/markers.ts
import { createHash as createHash2 } from "node:crypto";
var MARKER = /<!--\s*cicd-optimizer:(finding|alert|fix|recipe|experiment)\s+([^>]*?)\s*-->/;
function marker(kind, fingerprint2, attributes = {}) {
  const extra = Object.entries(attributes).filter(([, value]) => value !== "").map(([key, value]) => ` ${key}=${encodeURIComponent(value)}`).join("");
  return `<!-- cicd-optimizer:${kind} fingerprint=${encodeURIComponent(fingerprint2)}${extra} -->`;
}
function parseMarker(body) {
  const match2 = body ? MARKER.exec(body) : null;
  if (!match2) return void 0;
  const attributes = {};
  for (const pair of (match2[2] ?? "").split(/\s+/)) {
    const index = pair.indexOf("=");
    if (index > 0) {
      try {
        attributes[pair.slice(0, index)] = decodeURIComponent(pair.slice(index + 1));
      } catch (error) {
        if (error instanceof URIError) return void 0;
        throw error;
      }
    }
  }
  const fingerprint2 = attributes.fingerprint;
  if (!fingerprint2) return void 0;
  delete attributes.fingerprint;
  return { kind: match2[1], fingerprint: fingerprint2, attributes };
}
function findMarker(body, kind) {
  if (!body) return void 0;
  const all = new RegExp(MARKER.source, "g");
  for (const match2 of body.matchAll(all)) {
    const parsed = parseMarker(match2[0]);
    if (parsed?.kind === kind) return parsed;
  }
  return void 0;
}
function signatureOf(parts) {
  return createHash2("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}
function updateMarker(body, kind, fingerprint2, attributes) {
  const existing = parseMarker(body);
  const next = marker(kind, fingerprint2, { ...existing?.attributes ?? {}, ...attributes });
  return existing ? body.replace(MARKER, () => next) : `${next}
${body}`;
}

// src/experiments/github.ts
var EXPERIMENT_LABEL = "experiment";
var PROMOTE_LABEL = "experiment:promote";
var OUTCOME_LABELS = { reject: "experiment:rejected", expire: "experiment:expired" };
async function listExperimentPullRequests(client, repo, state = "open") {
  const pulls = await paginate(client, "GET /repos/{owner}/{repo}/pulls", { ...repo, state, sort: "updated", direction: "desc" }, state === "open" ? 10 : 3);
  return pulls.flatMap((pull) => {
    const ref = parseExperimentRef(pull.head.ref);
    if (!ref) return [];
    return [
      {
        number: pull.number,
        nodeId: pull.node_id,
        state: pull.state,
        merged: pull.merged_at !== null,
        draft: pull.draft === true,
        title: pull.title,
        body: pull.body ?? "",
        labels: pull.labels.map((label) => label.name),
        head: pull.head.ref,
        headSha: pull.head.sha,
        base: pull.base.ref,
        experiment: ref.experiment,
        arm: ref.arm,
        ...pull.closed_at ? { closedAt: pull.closed_at } : {}
      }
    ];
  });
}
function groupExperiments(pulls) {
  const byName = /* @__PURE__ */ new Map();
  for (const pull of pulls) {
    const state = byName.get(pull.experiment) ?? { name: pull.experiment, arms: [] };
    if (pull.arm === TRUNK) state.trunk ??= pull;
    else if (pull.base === trunkBranch(pull.experiment)) state.arms.push(pull);
    byName.set(pull.experiment, state);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function experimentBody(manifest, config, decision) {
  const rubric = scoreRubric(manifest.rubric.scores, config.rubric);
  return [
    marker("experiment", manifest.name, { status: manifest.status, kind: manifest.kind, ...manifest.winner ? { winner: manifest.winner } : {} }),
    `## \u{1F9EA} Experiment: ${manifest.title}`,
    "",
    `**Hypothesis:** ${manifest.hypothesis}`,
    "",
    `**Kind:** \`${manifest.kind}\` \xB7 **Rubric score:** ${rubric.score} / 5 \xB7 **Expires:** ${manifest.expiresAt.slice(0, 10)}`,
    "",
    "| Arm | Approach |",
    "| --- | --- |",
    ...manifest.arms.map((arm) => `| \`${armBranch(manifest.name, arm.name)}\` | **${arm.title}** \u2014 ${arm.approach.replace(/\r?\n/g, " ")} |`),
    "",
    `Arms open pull requests into \`${trunkBranch(manifest.name)}\`. The grader merges the winning arm into this branch and marks this pull request ready for review; merging it promotes the result.`,
    ...decision ? ["", "---", "", decision] : [],
    "",
    "<details><summary>Rubric</summary>",
    "",
    renderRubric(config.rubric),
    "",
    `Rationale: ${manifest.rubric.rationale || "\u2013"}`,
    "",
    "</details>"
  ].join("\n");
}
async function createExperiment(client, repo, options) {
  const { manifest, baseBranch, config } = options;
  const trunk = trunkBranch(manifest.name);
  const baseSha = await branchSha(client, repo, baseBranch);
  const sha = await commitFiles(
    client,
    repo,
    baseSha,
    [{ path: manifestPath(manifest.name), content: serializeManifest(manifest) }, ...options.files ?? []],
    `experiment(${manifest.name}): ${manifest.title}`
  );
  try {
    await client.request("POST /repos/{owner}/{repo}/git/refs", { ...repo, ref: `refs/heads/${trunk}`, sha });
  } catch (error) {
    if (httpStatus(error) === 422) throw new Error(`Experiment "${manifest.name}" already exists (${trunk}).`, { cause: error });
    throw error;
  }
  const pull = { ...repo, title: `experiment(${manifest.name}): ${manifest.title}`, head: trunk, base: baseBranch, body: experimentBody(manifest, config), maintainer_can_modify: true };
  let response;
  try {
    response = await client.request("POST /repos/{owner}/{repo}/pulls", { ...pull, draft: true });
  } catch (error) {
    if (httpStatus(error) !== 422) throw error;
    response = await client.request("POST /repos/{owner}/{repo}/pulls", pull);
  }
  const number = response.data.number;
  await ensureLabels(client, repo, [EXPERIMENT_LABEL]);
  await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: number, labels: [EXPERIMENT_LABEL] });
  return { trunk, pullRequest: number, sha };
}
async function dispatchRuns(client, repo, requests, maxPerRequest = 5) {
  let dispatched = 0;
  for (const request of requests) {
    for (let run3 = 0; run3 < Math.min(request.runs, maxPerRequest); run3 += 1) {
      await client.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", { ...repo, workflow_id: request.workflow, ref: request.ref });
      dispatched += 1;
    }
  }
  return dispatched;
}
async function upsertComment(client, repo, issue, name, body) {
  const comments = await paginate(client, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: issue }, 3);
  const existing = comments.find((comment) => {
    const parsed = parseMarker(comment.body);
    return parsed?.kind === "experiment" && parsed.fingerprint === name && parsed.attributes.role === "grade";
  });
  const text = `${marker("experiment", name, { role: "grade" })}
${body}`;
  if (existing) await client.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", { ...repo, comment_id: existing.id, body: text });
  else await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: issue, body: text });
}
async function graphql(client, query, variables) {
  const response = await client.request("POST /graphql", { query, variables });
  const errors = response.data?.errors;
  if (errors?.length) throw new Error(errors.map((error) => error.message).join("; "));
}
async function closePull(client, repo, pull, comment) {
  if (pull.state !== "open") return;
  await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: pull.number, body: comment });
  await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pull.number, state: "closed" });
  await deleteBranch(client, repo, pull.head);
}
async function applyDecision(client, repo, options) {
  const { manifest, decision, state, config } = options;
  const result = { action: decision.action, closed: [], dispatched: 0, notes: [] };
  const report = renderDecision(manifest, decision);
  const trunk = state.trunk;
  if (decision.action === "skip") return result;
  if (decision.action === "wait") {
    result.dispatched = await dispatchRuns(client, repo, decision.dispatch);
    if (trunk) await upsertComment(client, repo, trunk.number, manifest.name, report);
    return result;
  }
  if (decision.action === "promote") {
    const winner = state.arms.find((arm) => arm.arm === decision.winner && arm.state === "open");
    if (!winner) {
      result.notes.push(`winning arm ${decision.winner} has no open pull request`);
      return result;
    }
    const measured = decision.scores.find((score) => score.arm === decision.winner);
    await client.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
      ...repo,
      pull_number: winner.number,
      merge_method: "squash",
      sha: winner.headSha,
      commit_title: `experiment(${manifest.name}): adopt ${decision.winner} (#${winner.number})`,
      commit_message: `${decision.reason}

Weighted improvement: ${((measured?.deterministic ?? 0) * 100).toFixed(1)}%`
    });
    result.merged = winner.number;
    await deleteBranch(client, repo, winner.head);
    for (const loser of state.arms.filter((arm) => arm.arm !== decision.winner)) {
      await closePull(client, repo, loser, `Not selected: \`${decision.winner}\` won experiment \`${manifest.name}\`.

${report}`);
      if (loser.state === "open") result.closed.push(loser.number);
    }
    const promoted = {
      ...manifest,
      status: "promoted",
      winner: decision.winner,
      evidence: {
        improvement: measured?.deterministic ?? 0,
        metrics: (measured?.metrics ?? []).map((metric) => ({
          metric: metric.id,
          delta: metric.delta,
          ...metric.control !== void 0 ? { control: metric.control } : {},
          ...metric.arm !== void 0 ? { arm: metric.arm } : {},
          ...metric.pValue !== void 0 ? { pValue: metric.pValue } : {}
        }))
      }
    };
    const trunkName = trunkBranch(manifest.name);
    const head = await branchSha(client, repo, trunkName);
    const sha = await commitFiles(client, repo, head, [{ path: manifestPath(manifest.name), content: serializeManifest(promoted) }], `experiment(${manifest.name}): promote ${decision.winner}`);
    await client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { ...repo, ref: `heads/${trunkName}`, sha, force: false });
    if (trunk) {
      await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: trunk.number, body: experimentBody(promoted, config, report) });
      const labels = [PROMOTE_LABEL, ...config.promotion.labels];
      await ensureLabels(client, repo, labels);
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: trunk.number, labels });
      if (trunk.draft) {
        await graphql(client, "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }", { id: trunk.nodeId });
      }
      const users = config.promotion.reviewers.filter((reviewer) => !reviewer.includes("/"));
      const teams = config.promotion.reviewers.filter((reviewer) => reviewer.includes("/")).map((team) => team.split("/")[1]);
      if (users.length > 0 || teams.length > 0) {
        try {
          await client.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", { ...repo, pull_number: trunk.number, reviewers: users, team_reviewers: teams });
        } catch (error) {
          if (httpStatus(error) !== 422) throw error;
          result.notes.push("could not request reviewers");
        }
      }
      if (config.promotion.autoMerge) {
        try {
          await graphql(client, "mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }", { id: trunk.nodeId });
        } catch (error) {
          result.notes.push(`auto-merge unavailable: ${error.message}`);
        }
      }
      await upsertComment(client, repo, trunk.number, manifest.name, report);
    }
    return result;
  }
  for (const arm of state.arms) {
    await closePull(client, repo, arm, `Experiment \`${manifest.name}\` ${decision.action === "reject" ? "was rejected" : "expired"}.`);
    if (arm.state === "open") result.closed.push(arm.number);
  }
  if (trunk) {
    await upsertComment(client, repo, trunk.number, manifest.name, report);
    const label = OUTCOME_LABELS[decision.action];
    await ensureLabels(client, repo, [label]);
    await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: trunk.number, labels: [label] });
    if (trunk.state === "open") {
      await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: trunk.number, state: "closed" });
      result.closed.push(trunk.number);
    }
    await deleteBranch(client, repo, trunk.head);
  }
  return result;
}

// src/experiments/propose.ts
var import_yaml19 = __toESM(require_dist(), 1);
var DAY2 = 864e5;
function validateProposal(text, options) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + options.config.selection.maxAgeDays * DAY2).toISOString();
  let raw;
  try {
    raw = (0, import_yaml19.parse)(text);
  } catch (error) {
    return { errors: [`manifest: ${error.message}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { errors: ["manifest: expected a YAML mapping"] };
  const proposed = { ...raw };
  delete proposed.winner;
  const parsed = validateManifest({ ...proposed, createdAt, expiresAt, status: "running" }, { config: options.config });
  const errors = parsed.problems.map((problem) => `${problem.path || "manifest"}: ${problem.message}`);
  const manifest = parsed.manifest;
  if (!manifest) return { errors };
  const rubric = scoreRubric(manifest.rubric.scores, options.config.rubric);
  if (rubric.missing.length > 0) errors.push(`rubric: missing scores for ${rubric.missing.join(", ")}`);
  else if (!rubric.passed) errors.push(`rubric: weighted score ${rubric.score} is below the ${options.config.rubric.minScore} bar`);
  if (options.knownNames.includes(manifest.name)) errors.push(`name: an experiment named "${manifest.name}" already exists or was tried before`);
  const running = options.running.filter((state) => state.trunk?.state === "open").length;
  if (running >= options.config.selection.maxConcurrent) errors.push(`selection: ${running} experiments are already running (max ${options.config.selection.maxConcurrent})`);
  return { manifest, rubric, errors };
}
function outcome(pull) {
  if (pull.merged) return "promoted and merged";
  if (pull.labels.includes("experiment:rejected")) return "rejected";
  if (pull.labels.includes("experiment:expired")) return "expired";
  if (pull.labels.includes("experiment:promote")) return pull.state === "open" ? "awaiting promotion review" : "promotion declined";
  return pull.state === "open" ? "running" : "closed";
}
function generatorContext(input2) {
  const byRule = /* @__PURE__ */ new Map();
  for (const diagnostic of input2.diagnostics ?? []) byRule.set(diagnostic.ruleId, (byRule.get(diagnostic.ruleId) ?? 0) + 1);
  const findings = [...byRule.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const metrics = input2.config.metrics.map(
    (metric) => `| \`${metric.id}\` | ${metric.source}${metric.workflow ? ` (\`${metric.workflow}\`${metric.job ? ` / ${metric.job}` : ""})` : ""} | ${metric.direction} | ${metric.weight} | ${metric.maxRegression === void 0 ? "\u2013" : `${Math.round(metric.maxRegression * 100)}%`} |`
  );
  const trunks = input2.history.filter((pull) => pull.arm === "trunk");
  return [
    "# Experiment generator context",
    "",
    "## Rubric",
    "",
    renderRubric(input2.config.rubric),
    "",
    "## Metrics",
    "",
    "| Metric | Source | Direction | Weight | Max regression |",
    "| --- | --- | --- | --- | --- |",
    ...metrics,
    "",
    `Arms must beat the trunk control by at least ${(input2.config.selection.minImprovement * 100).toFixed(1)}% (weighted) and must not modify: ${input2.config.protectedPaths.map((path) => `\`${path}\``).join(", ")}.`,
    `At most ${input2.config.selection.maxArms} arms per experiment and ${input2.config.selection.maxConcurrent} concurrent experiments.`,
    "",
    "## Current findings",
    "",
    ...findings.length > 0 ? ["| Rule | Findings |", "| --- | --- |", ...findings.slice(0, 30).map(([rule, count]) => `| \`${rule}\` | ${count} |`)] : ["No findings were supplied."],
    "",
    ...input2.telemetry ? ["## Telemetry", "", input2.telemetry, ""] : [],
    "## Running experiments",
    "",
    ...input2.running.length > 0 ? input2.running.map((state) => `- \`${state.name}\` \u2014 ${state.trunk?.title ?? "(no trunk pull request)"} (${state.arms.length} arm PRs)`) : ["None."],
    "",
    "## Past experiments (do not repeat without a new angle)",
    "",
    ...trunks.length > 0 ? trunks.slice(0, 30).map((pull) => `- \`${pull.experiment}\` \u2014 ${pull.title.replace(/^experiment\([^)]*\):\s*/, "")} \u2192 **${outcome(pull)}**`) : ["None yet."],
    "",
    "## Available rules",
    "",
    ...input2.rules.map((rule) => `- \`${rule.id}\` \u2014 ${rule.description}`)
  ].join("\n");
}
function knownExperimentNames(pulls) {
  return [...new Set(pulls.map((pull) => pull.experiment))];
}

// src/lint/api.ts
var ENGINE_API_VERSION = 1;
function lint2(request) {
  return lint(request.input, {
    config: request.config ?? structuredClone(DEFAULT_CONFIG),
    rules: allRules,
    ...request.presets ? { presets: request.presets } : {},
    ...request.baseFingerprints ? { baseFingerprints: request.baseFingerprints } : {}
  });
}

// src/lint/inventory.ts
import { execFile } from "node:child_process";
import { readdir as readdir2, readFile as readFile2, stat as stat2 } from "node:fs/promises";
import { join as join4, relative as relative3, sep as sep2 } from "node:path";
import { promisify } from "node:util";
var run = promisify(execFile);
var BASENAMES = /* @__PURE__ */ new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".yarnrc.yml",
  ".npmignore",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "tsconfig.json",
  "nx.json",
  "turbo.json",
  "lerna.json",
  "rush.json",
  "MODULE.bazel",
  "WORKSPACE",
  "WORKSPACE.bazel",
  ".bazelrc",
  ".bazelversion",
  "pants.toml",
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties",
  "pom.xml",
  "build.sbt",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "go.work",
  "pyproject.toml",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "uv.lock",
  "packages.lock.json",
  "Directory.Packages.props",
  "global.json",
  "docker-bake.hcl",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  ".dockerignore",
  "action.yml",
  "action.yaml"
]);
var LOCKFILES2 = /* @__PURE__ */ new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "Pipfile.lock", "uv.lock", "packages.lock.json"]);
var LOCKFILE_HEAD_BYTES = 8192;
var SKIP_DIRS = /* @__PURE__ */ new Set([".git", "node_modules", ".pnpm-store", ".yarn", ".venv", "venv", "__pycache__", ".turbo", ".nx", "target", ".gradle"]);
function isInventoryPath(path) {
  if (/(^|\/)node_modules\//.test(path)) return false;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) return true;
  if (/^\.github\/ci-cd-optimizer\.ya?ml$/.test(path)) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (BASENAMES.has(name)) return true;
  if (/^(Dockerfile|Containerfile)(\.[^/]+)?$/i.test(name) || /\.(dockerfile|containerfile|dockerignore)$/i.test(name)) return true;
  if (/^requirements.*\.txt$/i.test(name) || /(^|\/)requirements\/[^/]+\.txt$/i.test(path)) return true;
  if (/\.bazelrc$/i.test(name) || /\.(csproj|fsproj|sln)$/i.test(name)) return true;
  return path === ".changeset/config.json";
}
var isLockfile = (path) => LOCKFILES2.has(path.slice(path.lastIndexOf("/") + 1));
function selectInventory(entries2, config) {
  const paths = [];
  const truncated = [];
  let complete = true;
  const ignored = (path) => config.ignorePaths.some((glob) => matchesGlob(path, glob) || matchesGlob(path, `${glob}/**`));
  for (const entry of [...entries2].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!isInventoryPath(entry.path) || ignored(entry.path)) continue;
    if (paths.length >= config.limits.maxFiles) {
      complete = false;
      break;
    }
    if ((entry.size ?? 0) > config.limits.maxFileBytes) {
      if (!isLockfile(entry.path)) {
        complete = false;
        continue;
      }
      truncated.push(entry.path);
    }
    paths.push(entry.path);
  }
  return { paths, truncated, complete };
}
function truncateContent(content) {
  return content.length > LOCKFILE_HEAD_BYTES ? content.slice(0, LOCKFILE_HEAD_BYTES) : content;
}
async function walk2(root, dir, out) {
  for (const entry of await readdir2(dir, { withFileTypes: true })) {
    const full = join4(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk2(root, full, out);
    } else if (entry.isFile()) {
      const path = relative3(root, full).split(sep2).join("/");
      if (isInventoryPath(path)) out.push({ path, size: (await stat2(full)).size });
    }
  }
}
async function loadDirectory(root, config, change) {
  const entries2 = [];
  await walk2(root, root, entries2);
  const selection = selectInventory(entries2, config);
  const truncated = new Set(selection.truncated);
  const files = await Promise.all(
    selection.paths.map(async (path) => {
      const content = path.endsWith(".lockb") ? "" : await readFile2(join4(root, path), "utf8");
      return { path, content: truncated.has(path) ? truncateContent(content) : content };
    })
  );
  return { files, mode: "repository", inventoryComplete: selection.complete, truncated: selection.truncated, ...change ? { change } : {} };
}
async function git(root, args) {
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
async function loadGitRevision(root, ref, config) {
  const listing = await git(root, ["ls-tree", "-r", "-l", "--full-tree", ref]);
  const entries2 = listing.split("\n").map((line) => /^\d+ blob [0-9a-f]+\s+(\d+|-)\t(.+)$/.exec(line)).filter((match2) => match2 !== null).map((match2) => ({ path: match2[2], size: Number(match2[1]) || 0 }));
  const selection = selectInventory(entries2, config);
  const truncated = new Set(selection.truncated);
  const files = [];
  for (const path of selection.paths) {
    const content = path.endsWith(".lockb") ? "" : await git(root, ["show", `${ref}:${path}`]);
    files.push({ path, content: truncated.has(path) ? truncateContent(content) : content });
  }
  return { files, mode: "repository", inventoryComplete: selection.complete };
}
async function changedSince(root, base2) {
  const mergeBase = (await git(root, ["merge-base", base2, "HEAD"])).trim();
  const committed = await git(root, ["diff", "--name-only", "--no-renames", mergeBase]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard"]);
  const changedPaths2 = [...new Set([...committed.split("\n"), ...untracked.split("\n")].map((line) => line.trim()).filter(Boolean))];
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  return { event: "pull_request", baseSha: mergeBase, headSha: head, changedPaths: changedPaths2 };
}

// src/cli/lint.ts
import { readFile as readFile3, writeFile as writeFile2 } from "node:fs/promises";
import { join as join5 } from "node:path";
import { parseArgs } from "node:util";

// src/lint/formatters/index.ts
var FORMATS = ["stylish", "json", "sarif", "markdown", "github"];
var ICON = { error: "error", warn: "warning", info: "info" };
function stylish(result) {
  const lines = [];
  const byPath = /* @__PURE__ */ new Map();
  for (const diagnostic of result.diagnostics) {
    byPath.set(diagnostic.path, [...byPath.get(diagnostic.path) ?? [], diagnostic]);
  }
  for (const [path, diagnostics] of byPath) {
    lines.push(path);
    for (const diagnostic of diagnostics) {
      lines.push(
        `  ${`${diagnostic.line}:${diagnostic.column}`.padEnd(8)} ${ICON[diagnostic.severity].padEnd(8)} ${diagnostic.message}  ${diagnostic.ruleId}${diagnostic.fix ? " (fixable)" : ""}`
      );
      if (diagnostic.suggestion) lines.push(`  ${"".padEnd(8)} ${"".padEnd(8)} -> ${diagnostic.suggestion}`);
    }
    lines.push("");
  }
  for (const problem of result.parseProblems) lines.push(`${problem.path}:${problem.line} parse error: ${problem.message}`);
  const count = (severity) => result.diagnostics.filter((d) => d.severity === severity).length;
  const fixable = result.diagnostics.filter((d) => d.fix).length;
  lines.push(
    `${result.diagnostics.length} problem(s) (${count("error")} error, ${count("warn")} warning, ${count("info")} info)${fixable ? `, ${fixable} fixable with --fix` : ""}; ${result.rulesRun} rules over ${result.filesAnalyzed} files in ${result.durationMs}ms${result.skipped.length ? `; ${result.skipped.length} rule(s) skipped` : ""}${result.suppressed ? `; ${result.suppressed} suppressed` : ""}`
  );
  return lines.join("\n");
}
function json(result) {
  return JSON.stringify(result, null, 2);
}
function github(result) {
  const escape = (value) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const property = (value) => escape(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
  return result.diagnostics.map((d) => {
    const level = d.severity === "error" ? "error" : d.severity === "warn" ? "warning" : "notice";
    const body = d.suggestion ? `${d.message} ${d.suggestion}` : d.message;
    return `::${level} file=${property(d.path)},line=${d.line},col=${d.column},title=${property(d.ruleId)}::${escape(body)}`;
  }).join("\n");
}
function markdown(result, options = {}) {
  const limit = options.limit ?? 50;
  const lines = [`## ${options.title ?? "CI/CD Optimizer"}`, ""];
  if (result.diagnostics.length === 0) {
    lines.push("No CI/CD optimization findings. :rocket:");
  } else {
    lines.push("| Severity | Rule | Location | Finding |", "| --- | --- | --- | --- |");
    for (const d of result.diagnostics.slice(0, limit)) {
      const finding = `${d.message}${d.suggestion ? `<br>**Fix:** ${d.suggestion}` : ""}`.replace(/\|/g, "\\|");
      lines.push(`| ${d.severity} | [\`${d.ruleId}\`](${d.docsUrl}) | \`${d.path}:${d.line}\` | ${finding} |`);
    }
    if (result.diagnostics.length > limit) lines.push("", `_${result.diagnostics.length - limit} more finding(s) omitted._`);
  }
  if (result.skipped.length > 0) {
    lines.push("", "<details><summary>Skipped rules</summary>", "");
    for (const skip of result.skipped) lines.push(`- \`${skip.ruleId}\`: ${skip.reason}`);
    lines.push("", "</details>");
  }
  return lines.join("\n");
}
function sarif(result, rules9, version = "0.0.0") {
  const used = rules9.filter((rule) => result.diagnostics.some((d) => d.ruleId === rule.meta.id));
  const index = new Map(used.map((rule, position) => [rule.meta.id, position]));
  const level = { error: "error", warn: "warning", info: "note" };
  const securitySeverity = { high: "7.0", medium: "4.0", low: "2.0" };
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "ci-cd-optimizer",
              informationUri: "https://github.com/MSFT-TKENDRICK/ci-cd-optimizer",
              semanticVersion: version,
              rules: used.map((rule) => ({
                id: rule.meta.id,
                name: rule.meta.id.replace(/[^a-z0-9]+(.)/gi, (_, c) => c.toUpperCase()),
                shortDescription: { text: rule.meta.description },
                fullDescription: { text: rule.meta.rationale },
                helpUri: result.diagnostics.find((d) => d.ruleId === rule.meta.id)?.docsUrl,
                help: { text: rule.meta.rationale, markdown: `${rule.meta.rationale}

${rule.meta.references.map((ref) => `- ${ref}`).join("\n")}` },
                defaultConfiguration: { level: level[rule.meta.defaultSeverity] },
                properties: {
                  tags: ["ci-cd", "performance", rule.meta.ruleset, rule.meta.kind],
                  precision: "high",
                  "problem.severity": rule.meta.defaultSeverity === "warn" ? "warning" : rule.meta.defaultSeverity === "info" ? "recommendation" : "error",
                  "security-severity": securitySeverity[rule.meta.impact]
                }
              }))
            }
          },
          automationDetails: { id: "ci-cd-optimizer/" },
          results: result.diagnostics.map((d) => ({
            ruleId: d.ruleId,
            ruleIndex: index.get(d.ruleId),
            level: level[d.severity],
            message: { text: d.suggestion ? `${d.message} ${d.suggestion}` : d.message },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: d.path, uriBaseId: "%SRCROOT%" },
                  region: { startLine: d.line, startColumn: d.column }
                }
              }
            ],
            partialFingerprints: { "ciCdOptimizer/v1": d.fingerprint },
            properties: { impact: d.impact, confidence: d.confidence, ruleset: d.ruleset }
          }))
        }
      ]
    },
    null,
    2
  );
}
function format(name, result, rules9, version) {
  switch (name) {
    case "json":
      return json(result);
    case "sarif":
      return sarif(result, rules9, version);
    case "markdown":
      return markdown(result);
    case "github":
      return github(result);
    default:
      return stylish(result);
  }
}

// src/cli/lint.ts
var LINT_HELP = `Usage: ci-cd-optimizer lint [dir] [options]

Lints GitHub Actions workflows, Dockerfiles, and package manifests for CI/CD performance and hermeticity.

Options:
  -c, --config <file>       Configuration file (default: .github/ci-cd-optimizer.yml in dir)
  -f, --format <name>       ${FORMATS.join(" | ")} (default: stylish)
  -o, --output <file>       Write the report to a file instead of stdout
      --sarif <file>        Also write a SARIF 2.1.0 report (for code scanning)
      --preset <name>       Replace the configured presets (repeatable): ${PRESETS.join(", ")}
      --rule <id>=<sev>     Override a rule severity (repeatable): off | info | warn | error
      --ruleset <id>=<sev>  Override every rule in a ruleset (repeatable)
      --fail-on <sev>       Exit 1 at this severity or above: info | warn | error | never
      --max-warnings <n>    Exit 1 when more than n warnings are reported
      --base <ref>          Compare with a git ref; only findings this change introduces are reported
      --scope <scope>       all | changed | introduced (default: introduced with --base, else all)
      --fix                 Apply safe autofixes in place, then report what remains
  -q, --quiet               Report errors only
`;
var SEVERITIES2 = ["off", "info", "warn", "error"];
var RANK = { info: 1, warn: 2, error: 3 };
function parseOverride(flag, value, known2) {
  const index = Math.max(value.lastIndexOf("="), value.lastIndexOf(":"));
  const id = index === -1 ? value : value.slice(0, index);
  const severity = index === -1 ? "error" : value.slice(index + 1);
  if (!SEVERITIES2.includes(severity)) throw new UsageError(`--${flag} ${value}: severity must be one of ${SEVERITIES2.join(", ")}`);
  if (!known2.includes(id)) throw new UsageError(`--${flag} ${value}: unknown ${flag}.${didYouMean(id, known2)}`);
  return [id, severity];
}
async function loadLintConfig(io, root, explicit) {
  const candidates = explicit ? [resolvePath(io, explicit)] : CONFIG_PATHS.map((path) => join5(root, path));
  for (const path of candidates) {
    const text = await readFile3(path, "utf8").catch((error) => {
      if (error.code === "ENOENT" && !explicit) return void 0;
      throw new UsageError(`Cannot read configuration ${path}: ${error.message}`);
    });
    if (text === void 0) continue;
    const parsed = parseConfigText(text, allRules, path);
    if (parsed.problems.length > 0) {
      throw new UsageError(`Invalid configuration ${path}:
${parsed.problems.map((problem) => `  ${problem.path || "(root)"}: ${problem.message}`).join("\n")}`);
    }
    if (parsed.migrated) io.stderr(`${path}: legacy configuration keys were migrated; run with --format json to inspect the effective rules.`);
    return { config: parsed.config, path };
  }
  return { config: structuredClone(DEFAULT_CONFIG) };
}
function inScope2(diagnostic, scope2) {
  if (scope2 === "all" || diagnostic.scope === void 0) return true;
  if (scope2 === "introduced") return diagnostic.scope === "introduced";
  return diagnostic.scope === "introduced" || diagnostic.scope === "changed-file";
}
async function lintCommand(args, io) {
  const { values, positionals: positionals2 } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string", short: "c" },
      format: { type: "string", short: "f", default: "stylish" },
      output: { type: "string", short: "o" },
      sarif: { type: "string" },
      preset: { type: "string", multiple: true },
      rule: { type: "string", multiple: true },
      ruleset: { type: "string", multiple: true },
      "fail-on": { type: "string" },
      "max-warnings": { type: "string" },
      base: { type: "string" },
      scope: { type: "string" },
      fix: { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false }
    }
  });
  if (values.help) {
    io.stdout(LINT_HELP);
    return 0;
  }
  if (positionals2.length > 1) throw new UsageError("lint accepts a single directory.");
  const formatName = values.format;
  if (!FORMATS.includes(formatName)) throw new UsageError(`--format must be one of ${FORMATS.join(", ")}.${didYouMean(values.format ?? "", FORMATS)}`);
  const scope2 = values.scope ?? (values.base ? "introduced" : "all");
  if (!["all", "changed", "introduced"].includes(scope2)) throw new UsageError("--scope must be all, changed, or introduced.");
  if (scope2 !== "all" && !values.base) throw new UsageError(`--scope ${scope2} needs --base to know what changed.`);
  const maxWarnings = values["max-warnings"] === void 0 ? void 0 : Number(values["max-warnings"]);
  if (maxWarnings !== void 0 && (!Number.isInteger(maxWarnings) || maxWarnings < 0)) throw new UsageError("--max-warnings must be a non-negative integer.");
  const root = resolvePath(io, positionals2[0] ?? ".");
  const { config } = await loadLintConfig(io, root, values.config);
  const presets = values.preset?.map((preset) => {
    if (!PRESETS.includes(preset)) throw new UsageError(`--preset ${preset}: unknown preset.${didYouMean(preset, PRESETS)}`);
    return preset;
  });
  const ruleIds = allRules.map((rule) => rule.meta.id);
  const rulesets = [...new Set(allRules.map((rule) => rule.meta.ruleset))];
  for (const value of values.ruleset ?? []) {
    const [id, severity] = parseOverride("ruleset", value, rulesets);
    config.rulesets = { ...config.rulesets, [id]: severity };
  }
  for (const value of values.rule ?? []) {
    const [id, severity] = parseOverride("rule", value, ruleIds);
    config.rules = { ...config.rules, [id]: severity };
  }
  if (values["fail-on"] !== void 0) {
    if (!["info", "warn", "error", "never"].includes(values["fail-on"])) throw new UsageError("--fail-on must be info, warn, error, or never.");
    config.failOn = values["fail-on"];
  }
  const request = { config, ...presets ? { presets } : {} };
  let baseFingerprints;
  let change;
  if (values.base) {
    try {
      change = await changedSince(root, values.base);
      const baseInput = await loadGitRevision(root, change.baseSha ?? values.base, config);
      baseFingerprints = new Set(lint2({ ...request, input: baseInput }).diagnostics.map((diagnostic) => diagnostic.fingerprint));
    } catch (error) {
      throw new UsageError(`--base ${values.base}: ${error.message.split("\n")[0]}`);
    }
  }
  let input2 = await loadDirectory(root, config, change);
  let result = lint2({ ...request, input: input2, ...baseFingerprints ? { baseFingerprints } : {} });
  if (values.fix) {
    const truncated = new Set(input2.truncated);
    const fixable = result.diagnostics.filter((diagnostic) => diagnostic.fix && !truncated.has(diagnostic.path) && inScope2(diagnostic, scope2));
    if (fixable.length > 0) {
      const fixed = applyFixes(input2.files, fixable);
      const original = new Map(input2.files.map((file) => [file.path, file.content]));
      let written = 0;
      for (const [path, content] of fixed.files) {
        if (original.get(path) === content || truncated.has(path)) continue;
        await writeFile2(join5(root, path), content, "utf8");
        written += 1;
      }
      io.stderr(`Applied ${fixed.applied.length} fix(es) to ${written} file(s)${fixed.conflicts.length ? `; ${fixed.conflicts.length} overlapping fix(es) skipped, run --fix again` : ""}.`);
      input2 = await loadDirectory(root, config, change);
      result = lint2({ ...request, input: input2, ...baseFingerprints ? { baseFingerprints } : {} });
    }
  }
  const minimum = values.quiet ? "error" : "info";
  const diagnostics = result.diagnostics.filter((diagnostic) => inScope2(diagnostic, scope2) && RANK[diagnostic.severity] >= RANK[minimum]);
  const shown = { ...result, diagnostics };
  if (!input2.inventoryComplete) io.stderr("Inventory was truncated by limits; rules that check for missing files were skipped.");
  await writeText(io, values.output, format(formatName, shown, allRules, VERSION));
  if (values.sarif) await writeText(io, values.sarif, sarif(shown, allRules, VERSION));
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warn").length;
  if (exceedsThreshold(diagnostics, config.failOn)) return 1;
  if (maxWarnings !== void 0 && warnings > maxWarnings) {
    io.stderr(`Too many warnings (${warnings}); maximum allowed is ${maxWarnings}.`);
    return 1;
  }
  return 0;
}

// src/cli/experiments.ts
var EXPERIMENTS_HELP = `Usage: ci-cd-optimizer experiments <command> [options]

Hill-climbing experiments on experiments/<name>/<arm> branches (see docs/experiments.md).

Commands:
  list                      Running experiments as JSON
  context                   Markdown briefing for the experiment generator agent
  create                    Validate a proposal and create its trunk branch, PR, and arm runs
  collect                   Gather CI evidence for running experiments into measurement files
  evaluate                  Build each arm in a worktree and score it on the benchmark corpus
  decide                    Grade measurements and (with --apply) promote, reject, or request runs

Common options:
      --repo <owner/name>   Repository (default: $GITHUB_REPOSITORY)
      --config <file>       Hill-climb configuration (default: ${HILL_CLIMB_CONFIG_PATH})

create:    --manifest <file> | --agent-output <file>   [--cases <file.json>] [--base <branch>] [--arm-workflow <file>] [--dry-run]
collect:   [--experiment <name>] --output-dir <dir> | --output <file>
evaluate:  --measurements <file|dir> [--repo-dir <dir>]  |  --engine <module> [--corpus <dir>]
decide:    --measurements <file|dir> [--agent-output <file>] [--apply]
context:   [--dir <dir>] [--telemetry <file>] [--output <file>]
`;
var COMMON = {
  repo: { type: "string" },
  config: { type: "string" },
  help: { type: "boolean", short: "h", default: false }
};
async function readText(io, path) {
  try {
    return await readFile4(resolvePath(io, path), "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read ${path}: ${error.message}`);
  }
}
async function loadHillClimbConfig(io, explicit) {
  const path = resolvePath(io, explicit ?? HILL_CLIMB_CONFIG_PATH);
  const text = await readFile4(path, "utf8").catch((error) => {
    if (error.code === "ENOENT" && !explicit) return void 0;
    throw new UsageError(`Cannot read ${path}: ${error.message}`);
  });
  const parsed = parseHillClimbConfig(text);
  if (parsed.problems.length > 0) throw new UsageError(`Invalid ${path}:
${parsed.problems.map((p) => `  ${p.path || "(root)"}: ${p.message}`).join("\n")}`);
  return parsed.config;
}
async function loadManifest(client, repo, name, config) {
  const text = await readFileAt(client, repo, manifestPath(name), trunkBranch(name));
  if (text === void 0) throw new Error(`${manifestPath(name)} was not found on ${trunkBranch(name)}`);
  const parsed = parseManifest2(text, { config });
  if (!parsed.manifest) throw new Error(`${manifestPath(name)} is invalid: ${parsed.problems.map((p) => `${p.path}: ${p.message}`).join("; ")}`);
  return parsed.manifest;
}
async function runningExperiments(client, repo, config, only) {
  const states = groupExperiments(await listExperimentPullRequests(client, repo, "open")).filter((state) => state.trunk?.state === "open" && (!only || state.name === only));
  if (only && states.length === 0) throw new UsageError(`No open experiment named "${only}".`);
  const result = [];
  for (const state of states) {
    try {
      result.push({ state, manifest: await loadManifest(client, repo, state.name, config) });
    } catch (error) {
      result.push({ state, error: error.message });
    }
  }
  return result;
}
async function agentItems(io, path, type) {
  let data;
  try {
    data = JSON.parse(await readText(io, path));
  } catch (error) {
    throw new UsageError(`${path} is not valid agent output: ${error.message}`);
  }
  const items2 = data.items;
  if (!Array.isArray(items2)) return [];
  return items2.filter((item) => typeof item === "object" && item !== null && item.type === type);
}
function structured(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return (0, import_yaml20.parse)(value);
  }
}
async function measurementFiles(io, path) {
  const target = resolvePath(io, path);
  const info = await stat3(target).catch(() => void 0);
  if (!info) throw new UsageError(`${path} does not exist.`);
  if (!info.isDirectory()) return [target];
  return (await readdir3(target)).filter((name) => name.endsWith(".json")).sort().map((name) => join6(target, name));
}
var CASE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
var MAX_CASES = 10;
var MAX_CASE_FILES = 50;
var MAX_CASE_BYTES = 2e5;
async function caseFiles(io, raw, config) {
  const cases = structured(raw);
  if (cases === void 0 || cases === null || cases === "") return [];
  if (!Array.isArray(cases)) throw new Error("cases: expected a list of { id, case, files }");
  if (cases.length > MAX_CASES) throw new Error(`cases: at most ${MAX_CASES} new cases per experiment`);
  const files = [];
  let bytes = 0;
  for (const [index, entry] of cases.entries()) {
    const item = entry ?? {};
    const id = String(item.id ?? "");
    if (!CASE_ID.test(id)) throw new Error(`cases[${index}].id must be lowercase kebab-case`);
    const exists = await stat3(resolvePath(io, join6(config.evaluation.corpus, id))).then(() => true, () => false);
    if (exists) throw new Error(`cases[${index}]: corpus case "${id}" already exists; existing cases are immutable`);
    const caseText = typeof item.case === "string" ? item.case : JSON.stringify(item.case ?? {});
    const contents = item.files ?? {};
    if (typeof contents !== "object" || Array.isArray(contents)) throw new Error(`cases[${index}].files must map paths to contents`);
    const entries2 = Object.entries(contents);
    if (entries2.length === 0 || entries2.length > MAX_CASE_FILES) throw new Error(`cases[${index}].files must contain 1-${MAX_CASE_FILES} files`);
    const sources = [];
    for (const [path, content] of entries2) {
      if (typeof content !== "string") throw new Error(`cases[${index}].files["${path}"] must be text`);
      if (path.startsWith("/") || path.split("/").some((segment) => segment === ".." || segment === "") || path.includes("\\")) {
        throw new Error(`cases[${index}].files: invalid path "${path}"`);
      }
      bytes += content.length;
      sources.push({ path, content });
    }
    parseCase(id, caseText, sources);
    const base2 = `${config.evaluation.corpus}/${id}`;
    files.push({ path: `${base2}/case.yml`, content: caseText }, ...sources.map((file) => ({ path: `${base2}/files/${file.path}`, content: file.content })));
  }
  if (bytes > MAX_CASE_BYTES) throw new Error(`cases: ${bytes} bytes exceeds the ${MAX_CASE_BYTES}-byte budget`);
  return files;
}
async function listCommand(args, io) {
  const { values } = parseArgs2({ args, strict: true, options: { ...COMMON } });
  const config = await loadHillClimbConfig(io, values.config);
  const repo = repoFrom(values.repo, io);
  const running = await runningExperiments(githubClient(io), repo, config);
  const summary2 = running.map(({ state, manifest, error }) => ({
    name: state.name,
    ...manifest ? { kind: manifest.kind, status: manifest.status, title: manifest.title, needsCorpus: metricsFor(manifest, config).some((m) => m.source === "corpus") } : {},
    ...error ? { error } : {},
    trunk: state.trunk ? { number: state.trunk.number, headSha: state.trunk.headSha } : null,
    arms: state.arms.map((arm) => ({ arm: arm.arm, number: arm.number, headSha: arm.headSha, state: arm.state }))
  }));
  io.stdout(JSON.stringify(summary2, null, 2));
  return 0;
}
async function contextCommand(args, io) {
  const { values } = parseArgs2({ args, strict: true, options: { ...COMMON, dir: { type: "string" }, telemetry: { type: "string" }, output: { type: "string", short: "o" } } });
  const config = await loadHillClimbConfig(io, values.config);
  const repo = repoFrom(values.repo, io);
  const client = githubClient(io);
  const root = resolvePath(io, values.dir ?? ".");
  const { config: lintConfig } = await loadLintConfig(io, root, void 0);
  const input2 = await loadDirectory(root, lintConfig);
  const diagnostics = lint2({ input: input2, config: lintConfig, presets: ["all"] }).diagnostics;
  const history = await listExperimentPullRequests(client, repo, "all");
  const running = groupExperiments(history.filter((pull) => pull.state === "open"));
  const telemetry = values.telemetry ? await readText(io, values.telemetry) : void 0;
  const text = generatorContext({
    config,
    diagnostics,
    ...telemetry ? { telemetry } : {},
    running,
    history,
    rules: allRules.map((rule) => ({ id: rule.meta.id, description: rule.meta.description }))
  });
  await writeText(io, values.output, text);
  return 0;
}
async function createCommand(args, io) {
  const { values } = parseArgs2({
    args,
    strict: true,
    options: {
      ...COMMON,
      manifest: { type: "string" },
      "agent-output": { type: "string" },
      cases: { type: "string" },
      base: { type: "string" },
      "arm-workflow": { type: "string" },
      "dry-run": { type: "boolean", default: false }
    }
  });
  if (!values.manifest === !values["agent-output"]) throw new UsageError("create needs exactly one of --manifest or --agent-output.");
  const config = await loadHillClimbConfig(io, values.config);
  const repo = repoFrom(values.repo, io);
  const client = githubClient(io);
  const proposals = values.manifest ? [{ manifest: await readText(io, values.manifest), ...values.cases ? { cases: await readText(io, values.cases) } : {} }] : (await agentItems(io, values["agent-output"], "create_experiment")).map((item) => ({ manifest: String(item.manifest ?? ""), cases: item.cases }));
  if (proposals.length === 0) {
    io.stderr("No create_experiment proposals found.");
    return 0;
  }
  const history = await listExperimentPullRequests(client, repo, "all");
  const running = groupExperiments(history.filter((pull) => pull.state === "open"));
  const knownNames = knownExperimentNames(history);
  const base2 = values.base ?? io.env.GITHUB_REF_NAME ?? "main";
  let failed = false;
  for (const proposal of proposals) {
    const result = validateProposal(proposal.manifest, { config, running, knownNames, ...io.now ? { now: io.now() } : {} });
    let files = [];
    try {
      files = await caseFiles(io, proposal.cases, config);
    } catch (error) {
      result.errors.push(error.message);
    }
    if (!result.manifest || result.errors.length > 0) {
      failed = true;
      io.stderr(`Proposal${result.manifest ? ` "${result.manifest.name}"` : ""} refused:
${result.errors.map((error) => `  - ${error}`).join("\n")}`);
      continue;
    }
    const manifest = result.manifest;
    if (values["dry-run"]) {
      io.stdout(JSON.stringify({ name: manifest.name, rubric: result.rubric, arms: manifest.arms.map((arm) => arm.name), cases: files.length }, null, 2));
      continue;
    }
    const created = await createExperiment(client, repo, { manifest, baseBranch: base2, config, files });
    knownNames.push(manifest.name);
    io.stdout(`Created ${created.trunk} (#${created.pullRequest}) at ${created.sha.slice(0, 7)}`);
    if (values["arm-workflow"]) {
      for (const arm of manifest.arms) {
        await client.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          ...repo,
          workflow_id: values["arm-workflow"],
          ref: base2,
          inputs: { experiment: manifest.name, arm: arm.name }
        });
        io.stdout(`Dispatched ${values["arm-workflow"]} for ${armBranch(manifest.name, arm.name)}`);
      }
    }
  }
  return failed ? 1 : 0;
}
async function collectCommand(args, io) {
  const { values } = parseArgs2({ args, strict: true, options: { ...COMMON, experiment: { type: "string" }, output: { type: "string", short: "o" }, "output-dir": { type: "string" } } });
  if (!values.output === !values["output-dir"]) throw new UsageError("collect needs exactly one of --output or --output-dir.");
  if (values.output && !values.experiment) throw new UsageError("--output needs --experiment; use --output-dir for every running experiment.");
  const config = await loadHillClimbConfig(io, values.config);
  const repo = repoFrom(values.repo, io);
  const client = githubClient(io);
  const now = io.now?.() ?? /* @__PURE__ */ new Date();
  for (const { state, manifest, error } of await runningExperiments(client, repo, config, values.experiment)) {
    if (!manifest) {
      io.stderr(`Skipping ${state.name}: ${error ?? "no manifest"}`);
      continue;
    }
    if (manifest.status !== "running") continue;
    const measurements = {
      ...await collectMeasurements(client, repo, { manifest, state, config, now }),
      needsCorpus: metricsFor(manifest, config).some((metric) => metric.source === "corpus")
    };
    const target = values.output ?? join6(values["output-dir"], `${manifest.name}.json`);
    await writeText(io, target, JSON.stringify(measurements, null, 2));
    io.stderr(`Collected ${manifest.name}: control + ${measurements.arms.length} arm(s) -> ${target}`);
  }
  return 0;
}
async function evaluateCommand(args, io) {
  const { values } = parseArgs2({
    args,
    strict: true,
    options: { ...COMMON, measurements: { type: "string" }, "repo-dir": { type: "string" }, engine: { type: "string" }, corpus: { type: "string" }, output: { type: "string", short: "o" } }
  });
  const config = await loadHillClimbConfig(io, values.config);
  if (values.engine) {
    const engine = await loadEngine(resolvePath(io, values.engine), ENGINE_API_VERSION);
    const cases = await loadCorpus(resolvePath(io, values.corpus ?? config.evaluation.corpus));
    const report = evaluateCorpus(engine, cases, { timingRuns: config.evaluation.timingRuns });
    await writeText(io, values.output, JSON.stringify(report, null, 2));
    return report.totals.errors > 0 ? 1 : 0;
  }
  if (!values.measurements) throw new UsageError("evaluate needs --measurements (worktree mode) or --engine (single build).");
  const files = await measurementFiles(io, values.measurements);
  for (const file of files) {
    const measurements = JSON.parse(await readFile4(file, "utf8"));
    if (measurements.needsCorpus === false) continue;
    const result = await evaluateBranches({
      root: resolvePath(io, values["repo-dir"] ?? "."),
      measurements,
      config,
      engineVersion: ENGINE_API_VERSION,
      exec: io.exec ?? shellExec,
      log: (message) => io.stderr(message)
    });
    await writeText(io, values.output && files.length === 1 ? values.output : file, JSON.stringify(result.measurements, null, 2));
  }
  return 0;
}
function judgments(items2) {
  return items2.flatMap((item) => {
    const list3 = structured(item.judgments);
    if (!Array.isArray(list3)) return [];
    return list3.flatMap((entry) => {
      const judgment = entry ?? {};
      const score = Number(judgment.score);
      if (typeof judgment.experiment !== "string" || typeof judgment.arm !== "string" || !Number.isFinite(score)) return [];
      return [{ experiment: judgment.experiment, arm: judgment.arm, score: Math.max(0, Math.min(1, score)), rationale: String(judgment.rationale ?? "").slice(0, 2e3) }];
    });
  });
}
async function decideCommand(args, io) {
  const { values } = parseArgs2({
    args,
    strict: true,
    options: { ...COMMON, measurements: { type: "string" }, "agent-output": { type: "string" }, apply: { type: "boolean", default: false } }
  });
  if (!values.measurements) throw new UsageError("decide needs --measurements <file|dir>.");
  const config = await loadHillClimbConfig(io, values.config);
  const repo = repoFrom(values.repo, io);
  const client = githubClient(io);
  const judged = values["agent-output"] ? judgments(await agentItems(io, values["agent-output"], "grade_experiments")) : [];
  const states = groupExperiments(await listExperimentPullRequests(client, repo, "open"));
  const now = io.now?.() ?? /* @__PURE__ */ new Date();
  const reports = [];
  for (const file of await measurementFiles(io, values.measurements)) {
    let measurements = JSON.parse(await readFile4(file, "utf8"));
    const name = measurements.experiment;
    const state = states.find((candidate) => candidate.name === name);
    if (!state?.trunk) {
      io.stderr(`Skipping ${name}: no open trunk pull request.`);
      continue;
    }
    const manifest = await loadManifest(client, repo, name, config);
    for (const judgment of judged.filter((candidate) => candidate.experiment === name && candidate.arm !== "trunk")) {
      if (measurements.arms.some((arm) => arm.arm === judgment.arm)) {
        measurements = { ...measurements, arms: measurements.arms.map((arm) => arm.arm === judgment.arm ? { ...arm, judge: { score: judgment.score, rationale: judgment.rationale } } : arm) };
      }
    }
    const decision = decide(manifest, measurements, config, { now, trunkRef: trunkBranch(name), armRef: (arm) => armBranch(name, arm) });
    reports.push(renderDecision(manifest, decision));
    if (values.apply) {
      const applied = await applyDecision(client, repo, { manifest, decision, state, config });
      io.stderr(`${name}: ${applied.action}${applied.merged ? ` (merged #${applied.merged})` : ""}${applied.closed.length ? `, closed ${applied.closed.map((n) => `#${n}`).join(", ")}` : ""}${applied.dispatched ? `, dispatched ${applied.dispatched} run(s)` : ""}${applied.notes.length ? `; ${applied.notes.join("; ")}` : ""}`);
    } else {
      io.stderr(`${name}: ${decision.action} (dry run; pass --apply to act)`);
    }
  }
  const summary2 = reports.join("\n\n---\n\n") || "No running experiments to grade.";
  io.stdout(summary2);
  if (io.env.GITHUB_STEP_SUMMARY) await appendFile(io.env.GITHUB_STEP_SUMMARY, `${summary2}
`, "utf8").catch(() => void 0);
  return 0;
}
var COMMANDS = {
  list: listCommand,
  context: contextCommand,
  create: createCommand,
  collect: collectCommand,
  evaluate: evaluateCommand,
  decide: decideCommand
};
async function experimentsCommand(args, io) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || rest.includes("--help") || rest.includes("-h")) {
    io.stdout(EXPERIMENTS_HELP);
    return command && !COMMANDS[command] && command !== "--help" && command !== "-h" ? 2 : 0;
  }
  const handler = COMMANDS[command];
  if (!handler) throw new UsageError(`Unknown experiments command "${command}". Commands: ${Object.keys(COMMANDS).join(", ")}.`);
  return handler(rest, io);
}

// src/cli/recipes.ts
import { readFile as readFile5 } from "node:fs/promises";
import { parseArgs as parseArgs3 } from "node:util";

// src/github/repository.ts
async function defaultBranch(client, repo) {
  const response = await client.request("GET /repos/{owner}/{repo}", { ...repo });
  return response.data.default_branch;
}
async function loadRemoteConfig(client, repo, ref) {
  for (const path of CONFIG_PATHS) {
    const text = await readFileAt(client, repo, path, ref);
    if (text === void 0) continue;
    const parsed2 = parseConfigText(text, allRules, path);
    return { config: parsed2.config, path, problems: parsed2.problems };
  }
  const parsed = parseConfigText("", allRules);
  return { config: parsed.config, problems: [] };
}
async function loadRepositorySnapshot(client, repo, options) {
  const commit = await client.request("GET /repos/{owner}/{repo}/commits/{ref}", { ...repo, ref: options.ref });
  const commitData = commit.data;
  const tree = await client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { ...repo, tree_sha: commitData.commit.tree.sha, recursive: "1" });
  const treeData = tree.data;
  const blobs = new Map(treeData.tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry]));
  const selection = selectInventory(
    [...blobs.values()].map((entry) => ({ path: entry.path, ...entry.size !== void 0 ? { size: entry.size } : {} })),
    options.config
  );
  const truncated = new Set(selection.truncated);
  const files = await mapLimit(selection.paths, options.concurrency ?? 8, async (path) => {
    if (path.endsWith(".lockb")) return { path, content: "" };
    const blob = await client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", { ...repo, file_sha: blobs.get(path).sha });
    const data = blob.data;
    const content = data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content;
    return { path, content: truncated.has(path) ? truncateContent(content) : content };
  });
  return {
    ref: options.ref,
    sha: commitData.sha,
    input: {
      files,
      mode: "repository",
      inventoryComplete: selection.complete && treeData.truncated !== true,
      truncated: selection.truncated,
      ...options.change ? { change: options.change } : {}
    }
  };
}

// src/fixes/plan.ts
var NO_DISMISSALS = { rules: /* @__PURE__ */ new Set(), groups: /* @__PURE__ */ new Set() };
function groupName(diagnostic, config) {
  for (const [name, group] of Object.entries(config.groups)) {
    if (group.rules?.includes(diagnostic.ruleId) || group.rulesets?.includes(diagnostic.ruleset)) return name;
  }
  return diagnostic.ruleset;
}
function ruleMatches(pattern, ruleId) {
  return pattern === ruleId || pattern.endsWith("/*") && ruleId.startsWith(pattern.slice(0, -1));
}
function isIgnored(diagnostic, config, dismissed = NO_DISMISSALS) {
  if (dismissed.rules.has(diagnostic.ruleId)) return true;
  return config.ignore.some(
    (entry) => ruleMatches(entry.rule, diagnostic.ruleId) && (!entry.paths || entry.paths.some((glob) => matchesGlob(diagnostic.path, glob)))
  );
}
function branchFor(group, config) {
  return `${config.branchPrefix}${group.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "")}`;
}
function computeFixChanges(options) {
  const dismissed = options.dismissed ?? NO_DISMISSALS;
  const maxPasses = options.maxPasses ?? 5;
  const original = new Map(options.input.files.map((file) => [file.path, file.content]));
  const eligible = (diagnostic, group) => diagnostic.fix !== void 0 && !isIgnored(diagnostic, options.config, dismissed) && !dismissed.groups.has(groupName(diagnostic, options.config)) && (group === void 0 || groupName(diagnostic, options.config) === group);
  const first = options.lint(options.input);
  const groups = [...new Set(first.diagnostics.filter((d) => eligible(d)).map((d) => groupName(d, options.config)))].sort();
  const changes = [];
  for (const group of groups) {
    let files = options.input.files;
    let result = first;
    const applied = [];
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const selected = result.diagnostics.filter((d) => eligible(d, group));
      if (selected.length === 0) break;
      const output2 = applyFixes(files, selected);
      if (output2.applied.length === 0) break;
      applied.push(...output2.applied);
      files = files.map((file) => output2.files.has(file.path) ? { path: file.path, content: output2.files.get(file.path) } : file);
      if (pass < maxPasses - 1) result = options.lint({ ...options.input, files });
    }
    const changed = files.filter((file) => original.get(file.path) !== file.content).sort((a, b) => a.path.localeCompare(b.path));
    if (changed.length === 0) continue;
    changes.push({
      group,
      branch: branchFor(group, options.config),
      files: changed,
      applied,
      rules: [...new Set(applied.map((d) => d.ruleId))].sort(),
      signature: signatureOf(changed.flatMap((file) => [file.path, file.content]))
    });
  }
  return changes;
}
function edited(pr) {
  return pr.commitSha !== void 0 && pr.headSha !== void 0 && pr.commitSha !== pr.headSha;
}
function planFixPullRequests(changes, existing, options) {
  const actions = [];
  const skipped = [];
  const newestFirst = [...existing].sort((a, b) => b.number - a.number);
  const wanted = new Set(changes.map((change) => change.group));
  let open = existing.filter((pr) => pr.state === "open").length;
  for (const pr of newestFirst) {
    if (pr.state !== "open" || wanted.has(pr.group)) continue;
    if (edited(pr) && !options.recreate?.has(pr.group)) {
      skipped.push({ group: pr.group, reason: "edited", number: pr.number });
      continue;
    }
    actions.push({
      type: "close",
      number: pr.number,
      group: pr.group,
      ...pr.branch !== void 0 ? { branch: pr.branch } : {},
      comment: "These fixes are no longer needed: the base branch already contains them, or the rules no longer apply. Closing."
    });
    open -= 1;
  }
  for (const change of changes) {
    const current = newestFirst.find((pr) => pr.group === change.group && pr.state === "open");
    if (current) {
      if (options.recreate?.has(change.group)) actions.push({ type: "update", number: current.number, change });
      else if (edited(current)) skipped.push({ group: change.group, reason: "edited", number: current.number });
      else if (current.signature === change.signature && !options.rebase?.has(change.group)) {
        skipped.push({ group: change.group, reason: "up-to-date", number: current.number });
      } else actions.push({ type: "update", number: current.number, change });
      continue;
    }
    const latest = newestFirst.find((pr) => pr.group === change.group);
    if (latest && !latest.merged && latest.signature === change.signature && !options.recreate?.has(change.group)) {
      skipped.push({ group: change.group, reason: "declined", number: latest.number });
      continue;
    }
    if (open >= options.openPullRequestsLimit) {
      skipped.push({ group: change.group, reason: "limit" });
      continue;
    }
    actions.push({ type: "create", change });
    open += 1;
  }
  const metadata = [];
  for (const pr of newestFirst) {
    if (pr.state !== "open") continue;
    const currentLabels = new Set((pr.labels ?? []).map((label) => label.toLowerCase()));
    const labels = [...new Set(options.labels ?? [])].filter((label) => !currentLabels.has(label.toLowerCase()));
    const closing = actions.some((action) => action.type === "close" && action.number === pr.number);
    const pending = closing || pr.draft ? [] : pr.pendingReviewers ?? [];
    if (labels.length === 0 && pending.length === 0) continue;
    metadata.push({
      type: "metadata",
      number: pr.number,
      group: pr.group,
      labels,
      reviewers: pending.filter((reviewer) => options.reviewers?.includes(reviewer))
    });
  }
  return { actions: [...metadata, ...actions], skipped };
}

// src/fixes/commands.ts
var COMMAND_HELP = [
  "<details>",
  "<summary>Commands</summary>",
  "",
  "You can trigger actions by commenting on this pull request:",
  "- `@cicd-optimizer rebase` rebuilds the fixes on the latest base branch (unless someone else pushed to it)",
  "- `@cicd-optimizer recreate` rebuilds the fixes, overwriting any edits made to this pull request",
  "- `@cicd-optimizer close` closes this pull request; it is not reopened for the same change",
  "- `@cicd-optimizer ignore this rule <rule-id>` stops proposing fixes for that rule (all rules in this pull request when omitted)",
  "- `@cicd-optimizer ignore this group` closes this pull request and stops proposing fixes for this group",
  "",
  "Ignores are remembered through the `cicd-optimizer:ignored` label; remove it from the pull request to undo. Use `fixes.ignore` in `.github/ci-cd-optimizer.yml` for permanent configuration.",
  "</details>"
].join("\n");

// src/fixes/render.ts
function fixTitle(change) {
  const count = change.applied.length;
  if (change.rules.length === 1) return `ci(${change.group}): fix ${change.rules[0]} (${count} ${count === 1 ? "change" : "changes"})`;
  return `ci(${change.group}): apply ${count} CI/CD optimizations`;
}
function commitMessage(change) {
  const lines = [fixTitle(change), ""];
  for (const diagnostic of change.applied) lines.push(`- ${diagnostic.ruleId}: ${diagnostic.fix?.description ?? diagnostic.message} (${diagnostic.path})`);
  return lines.join("\n");
}
function fixMarker(change, context) {
  return marker("fix", `group:${change.group}`, {
    signature: change.signature,
    commit: context.commitSha ?? "",
    rules: change.rules.join(","),
    ignored: (context.ignoredRules ?? []).join(",")
  });
}
function fixBody(change, context) {
  const byRule = /* @__PURE__ */ new Map();
  for (const diagnostic of change.applied) byRule.set(diagnostic.ruleId, [...byRule.get(diagnostic.ruleId) ?? [], diagnostic]);
  const lines = [
    fixMarker(change, context),
    `CI/CD Optimizer found deterministic, behavior-preserving fixes for the \`${change.group}\` group.`,
    "",
    "| Rule | Changes | Impact | Why |",
    "| --- | --- | --- | --- |"
  ];
  for (const [ruleId, diagnostics] of byRule) {
    const rule = context.rules.find((candidate) => candidate.meta.id === ruleId);
    const first = diagnostics[0];
    lines.push(`| [\`${ruleId}\`](${first.docsUrl}) | ${diagnostics.length} | ${first.impact} | ${(rule?.meta.rationale ?? first.message).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  }
  lines.push("", "### Changes", "");
  for (const file of change.files) {
    lines.push(`- \`${file.path}\``);
    for (const diagnostic of change.applied.filter((d) => d.path === file.path)) {
      lines.push(`  - L${diagnostic.line}: ${diagnostic.fix?.description ?? diagnostic.message}`);
    }
  }
  lines.push(
    "",
    "### Review notes",
    "",
    "- Each edit is generated by a rule's autofix and is limited to configuration that does not change what the pipeline builds or deploys.",
    "- CI runs on this pull request validate the change; compare the job durations with the base branch.",
    "- The pull request is rebuilt automatically when the fixes change and closed when they are no longer needed. Pushing your own commits stops automatic updates.",
    "",
    COMMAND_HELP
  );
  return lines.join("\n");
}

// src/fixes/github.ts
var IGNORED_LABEL = "cicd-optimizer:ignored";
var list = (value) => value ? value.split(",").filter(Boolean) : [];
async function listManagedPullRequests(client, repo, discovery) {
  const raw = await paginate(client, "GET /repos/{owner}/{repo}/issues", { ...repo, state: "all", labels: "cicd-optimizer" });
  const heads = /* @__PURE__ */ new Map();
  if (discovery) {
    const known2 = new Set(raw.map((issue) => issue.number));
    for (const group of new Set(discovery.groups)) {
      if (raw.some((issue) => issue.pull_request && issue.state === "open" && parseMarker(issue.body)?.fingerprint === `group:${group}`)) continue;
      const branch = branchFor(group, discovery);
      const pulls = await paginate(client, "GET /repos/{owner}/{repo}/pulls", {
        ...repo,
        state: "all",
        head: `${repo.owner}:${branch}`,
        base: discovery.baseBranch,
        sort: "created",
        direction: "desc"
      });
      if (pulls.length === 1e3) throw new Error(`Fix PR discovery reached its 1000-result limit for ${branch}; refusing an incomplete reconciliation.`);
      for (const pull of pulls) {
        if (known2.has(pull.number) || pull.head.repo?.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase() || pull.head.ref !== branch || pull.base.ref !== discovery.baseBranch) continue;
        const parsed = parseMarker(pull.body);
        if (parsed?.kind !== "fix" || parsed.fingerprint !== `group:${group}` || !parsed.attributes.signature || !parsed.attributes.commit) continue;
        raw.push({ ...pull, pull_request: { merged_at: pull.merged_at ?? null } });
        heads.set(pull.number, pull.head);
        known2.add(pull.number);
      }
    }
  }
  const result = [];
  for (const issue of raw) {
    if (!issue.pull_request) continue;
    const parsed = parseMarker(issue.body);
    if (!parsed || parsed.kind !== "fix" || !parsed.fingerprint.startsWith("group:")) continue;
    const pr = {
      number: issue.number,
      state: issue.state,
      merged: Boolean(issue.pull_request.merged_at),
      group: parsed.fingerprint.slice("group:".length),
      title: issue.title,
      body: issue.body ?? "",
      labels: (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name ?? ""),
      rules: list(parsed.attributes.rules),
      ignoredRules: list(parsed.attributes.ignored),
      ignoredGroup: parsed.attributes.ignoredGroup === "true",
      pendingReviewers: list(parsed.attributes.pendingReviewers),
      ...issue.draft !== void 0 ? { draft: issue.draft } : {},
      ...parsed.attributes.signature ? { signature: parsed.attributes.signature } : {},
      ...parsed.attributes.commit ? { commitSha: parsed.attributes.commit } : {}
    };
    if (pr.state === "open") {
      let head = heads.get(pr.number);
      if (!head) {
        const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pr.number });
        const pull = response.data;
        head = pull.head;
        if (pull.draft !== void 0) pr.draft = pull.draft;
      }
      if (head?.sha) pr.headSha = head.sha;
      if (head?.ref) pr.branch = head.ref;
    }
    result.push(pr);
  }
  return result;
}
function dismissalsFrom(prs) {
  const rules9 = /* @__PURE__ */ new Set();
  const groups = /* @__PURE__ */ new Set();
  for (const pr of prs) {
    if (!pr.labels.includes(IGNORED_LABEL)) continue;
    for (const rule of pr.ignoredRules) rules9.add(rule);
    if (pr.ignoredGroup) groups.add(pr.group);
  }
  return { rules: rules9, groups };
}
async function finishReviewRequests(client, repo, number, group, reviewers) {
  const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: number });
  const { body, draft } = response.data;
  const parsed = parseMarker(body);
  if (!parsed || parsed.kind !== "fix" || parsed.fingerprint !== `group:${group}`) {
    throw new Error(`Fix marker changed on PR #${number}; refusing to overwrite its body.`);
  }
  if (!parsed.attributes.pendingReviewers || draft) return;
  if (reviewers.length > 0) {
    const requested = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", { ...repo, pull_number: number });
    const current = requested.data;
    const users = new Set(current.users.map((user) => user.login.toLowerCase()));
    const teams = new Set(current.teams.map((team) => team.slug.toLowerCase()));
    const missingUsers = reviewers.filter((reviewer) => !reviewer.includes("/") && !users.has(reviewer.toLowerCase()));
    const missingTeams = reviewers.filter((reviewer) => reviewer.includes("/")).map((team) => team.split("/")[1]).filter((team) => !teams.has(team.toLowerCase()));
    if (missingUsers.length > 0 || missingTeams.length > 0) {
      await client.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
        ...repo,
        pull_number: number,
        reviewers: missingUsers,
        team_reviewers: missingTeams
      });
    }
  }
  await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...repo,
    pull_number: number,
    body: updateMarker(body ?? "", "fix", parsed.fingerprint, { pendingReviewers: "" })
  });
}
async function applyFixActions(client, repo, actions, options) {
  const labels = ["cicd-optimizer", ...options.config.labels];
  const neededLabels = actions.flatMap((action) => action.type === "create" ? labels : action.type === "metadata" ? action.labels : []);
  if (neededLabels.length > 0) await ensureLabels(client, repo, neededLabels);
  const applied = [];
  for (const action of actions) {
    if (action.type === "metadata") {
      if (action.labels.length > 0) {
        await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: action.number, labels: action.labels });
      }
      const previous2 = options.existing.find((pr) => pr.number === action.number);
      const closing = actions.some((candidate) => candidate.type === "close" && candidate.number === action.number);
      if (!closing && !previous2?.draft && previous2?.pendingReviewers?.length) await finishReviewRequests(client, repo, action.number, action.group, action.reviewers);
      applied.push({ action, number: action.number });
      continue;
    }
    if (action.type === "close") {
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: action.number, body: action.comment });
      await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: action.number, state: "closed" });
      await deleteBranch(client, repo, action.branch);
      applied.push({ action, number: action.number });
      continue;
    }
    const { change } = action;
    if (change.branch === options.baseBranch) throw new Error("A fix branch cannot be the repository's base branch.");
    let replaceExistingBranch = false;
    if (action.type === "create") {
      const response = await client.request("GET /repos/{owner}/{repo}/pulls", {
        ...repo,
        state: "open",
        head: `${repo.owner}:${change.branch}`,
        per_page: 100
      });
      if (response.data.some((pull) => pull.head.ref === change.branch && pull.head.repo?.full_name.toLowerCase() === `${repo.owner}/${repo.repo}`.toLowerCase())) {
        throw new Error(`An open PR already uses ${change.branch}; reconcile it before creating another. Its branch was not changed.`);
      }
      try {
        const currentSha = await branchSha(client, repo, change.branch);
        replaceExistingBranch = options.existing.some((pr) => pr.state === "closed" && pr.group === change.group && pr.commitSha === currentSha);
        if (!replaceExistingBranch) throw new Error(`Refusing to overwrite unrecognized or modified branch ${change.branch}; reconcile it before retrying.`);
      } catch (error) {
        if (httpStatus(error) !== 404) throw error;
      }
    }
    const commitSha = await commitFiles(client, repo, options.baseSha, change.files, commitMessage(change));
    await pushBranch(client, repo, change.branch, commitSha, action.type === "update" || replaceExistingBranch);
    const previous = action.type === "update" ? options.existing.find((pr) => pr.number === action.number) : void 0;
    const ignoredRules = previous?.ignoredRules ?? [];
    let body = options.render?.body ? options.render.body(change, { commitSha, ignoredRules }) : fixBody(change, { rules: options.rules, commitSha, ignoredRules });
    const title = options.render?.title ? options.render.title(change) : fixTitle(change);
    if (action.type === "update") {
      await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: action.number, title, body });
      applied.push({ action, number: action.number, commitSha });
      continue;
    }
    if (options.config.reviewers.length > 0) {
      body = updateMarker(body, "fix", `group:${change.group}`, { pendingReviewers: options.config.reviewers.join(",") });
    }
    const created = await client.request("POST /repos/{owner}/{repo}/pulls", {
      ...repo,
      title,
      head: change.branch,
      base: options.baseBranch,
      body,
      draft: options.config.draft,
      maintainer_can_modify: true
    });
    const number = created.data.number;
    await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: number, labels });
    if (options.config.reviewers.length > 0) {
      await finishReviewRequests(client, repo, number, change.group, options.config.reviewers);
    }
    applied.push({ action, number, commitSha });
  }
  return applied;
}

// src/issues/github.ts
var COPILOT_LOGIN = "copilot-swe-agent[bot]";
var COPILOT_READY_LABEL = "copilot:ready";
async function listManagedIssues(client, repo, kind) {
  const raw = await paginate(client, "GET /repos/{owner}/{repo}/issues", { ...repo, state: "all", labels: "cicd-optimizer" });
  const result = [];
  for (const issue of raw) {
    if (issue.pull_request) continue;
    const parsed = parseMarker(issue.body);
    if (!parsed || parsed.kind !== kind) continue;
    result.push({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      stateReason: issue.state_reason ?? null,
      closedAt: issue.closed_at ?? null,
      fingerprint: parsed.fingerprint,
      attributes: parsed.attributes,
      ...parsed.attributes.signature !== void 0 ? { signature: parsed.attributes.signature } : {}
    });
  }
  return result;
}
async function assignCopilot(issueClient, userClient, repo, issueNumber, assignment) {
  if (userClient) {
    try {
      await userClient.request("POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
        ...repo,
        issue_number: issueNumber,
        assignees: [COPILOT_LOGIN],
        agent_assignment: {
          target_repo: `${repo.owner}/${repo.repo}`,
          ...assignment.baseBranch ? { base_branch: assignment.baseBranch } : {},
          ...assignment.customInstructions ? { custom_instructions: assignment.customInstructions } : {},
          ...assignment.customAgent ? { custom_agent: assignment.customAgent } : {},
          ...assignment.model ? { model: assignment.model } : {}
        }
      });
      return "assigned";
    } catch (error) {
      if (![403, 404, 422].includes(httpStatus(error) ?? 0)) throw error;
    }
  }
  try {
    await issueClient.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      ...repo,
      issue_number: issueNumber,
      labels: [COPILOT_READY_LABEL]
    });
    return "labeled";
  } catch {
    return "failed";
  }
}
async function applyIssueActions(client, repo, actions, options = {}) {
  const labels = actions.flatMap((action) => action.type === "close" ? [] : action.desired.labels);
  if (actions.some((action) => action.type !== "close" && action.desired.assignCopilot)) labels.push(COPILOT_READY_LABEL);
  await ensureLabels(client, repo, labels);
  const applied = [];
  for (const action of actions) {
    if (action.type === "close") {
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: action.number, body: action.comment });
      await client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        ...repo,
        issue_number: action.number,
        state: "closed",
        state_reason: "completed"
      });
      applied.push({ action, number: action.number });
      continue;
    }
    const { desired } = action;
    let number;
    if (action.type === "create") {
      const response = await client.request("POST /repos/{owner}/{repo}/issues", {
        ...repo,
        title: desired.title,
        body: desired.body,
        labels: desired.labels,
        ...desired.assignees.length > 0 ? { assignees: desired.assignees } : {}
      });
      number = response.data.number;
    } else {
      number = action.number;
      await client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        ...repo,
        issue_number: number,
        title: desired.title,
        body: desired.body,
        labels: desired.labels,
        ...action.type === "reopen" ? { state: "open" } : {}
      });
      if (action.type === "update" && action.comment) {
        await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: number, body: action.comment });
      }
    }
    const result = { action, number };
    if (desired.assignCopilot && action.type !== "update") {
      result.copilot = await assignCopilot(client, options.copilotClient, repo, number, options.copilot ?? {});
    }
    applied.push(result);
  }
  return applied;
}

// src/issues/plan.ts
function planIssueSync(existing, desired, options) {
  const actions = [];
  const skipped = [];
  const byFingerprint = /* @__PURE__ */ new Map();
  for (const issue of [...existing].sort((a, b) => b.number - a.number)) {
    byFingerprint.set(issue.fingerprint, [...byFingerprint.get(issue.fingerprint) ?? [], issue]);
  }
  const wanted = new Set(desired.map((issue) => issue.fingerprint));
  let open = existing.filter((issue) => issue.state === "open").length;
  if (options.closeResolved) {
    for (const issue of existing) {
      if (issue.state !== "open" || wanted.has(issue.fingerprint)) continue;
      actions.push({
        type: "close",
        number: issue.number,
        fingerprint: issue.fingerprint,
        comment: options.resolvedComment ?? "CI/CD Optimizer no longer detects this finding, so this issue is resolved. :tada:"
      });
      open -= 1;
    }
  }
  const pending = [];
  for (const issue of desired) {
    const history = byFingerprint.get(issue.fingerprint) ?? [];
    const current = history.find((candidate) => candidate.state === "open");
    if (current) {
      if (current.signature !== issue.signature || current.title !== issue.title) {
        actions.push({ type: "update", number: current.number, desired: issue });
      }
      continue;
    }
    const latest = history[0];
    if (latest?.stateReason === "not_planned") {
      skipped.push({ fingerprint: issue.fingerprint, reason: "dismissed", number: latest.number });
      continue;
    }
    pending.push(issue);
  }
  for (const issue of pending.sort((a, b) => b.priority - a.priority || a.fingerprint.localeCompare(b.fingerprint))) {
    if (open >= options.maxOpen) {
      skipped.push({ fingerprint: issue.fingerprint, reason: "limit" });
      continue;
    }
    const latest = byFingerprint.get(issue.fingerprint)?.[0];
    actions.push(latest ? { type: "reopen", number: latest.number, desired: issue } : { type: "create", desired: issue });
    open += 1;
  }
  return { actions, skipped };
}

// src/recipes/compat.ts
function wilsonLowerBound(successes, total, z = 1.96) {
  if (total <= 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / (1 + z2 / total));
}
function compatibility(stats, minSamples = 5) {
  const total = stats.passed + stats.failed;
  const lowerBound = wilsonLowerBound(stats.passed, total);
  const sufficient = total >= minSamples;
  const percent = (value) => `${Math.round(value * 100)}%`;
  const rate = total > 0 ? stats.passed / total : void 0;
  const display = total === 0 ? "No data yet" : sufficient ? `${percent(rate)} (${stats.passed}/${total} repositories passed CI; 95% lower bound ${percent(lowerBound)})` : `Not enough data (${stats.passed}/${total} repositories passed CI)`;
  return { passed: stats.passed, failed: stats.failed, total, ...rate !== void 0 ? { rate } : {}, lowerBound, sufficient, display };
}
var FAILED2 = /* @__PURE__ */ new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
function classifyOutcome(checkRuns, pr) {
  if (pr.merged) return "passed";
  if (checkRuns.some((run3) => run3.conclusion !== null && FAILED2.has(run3.conclusion))) return "failed";
  if (checkRuns.some((run3) => run3.status !== "completed")) return "pending";
  if (checkRuns.length === 0) return "unknown";
  return "passed";
}
function classifyIssueOutcome(issue) {
  if (issue.state === "open") return "pending";
  return issue.stateReason === "not_planned" ? "failed" : "passed";
}

// src/recipes/recipe.ts
var import_yaml21 = __toESM(require_dist(), 1);
var RECIPES_DIR = "recipes";
var RECIPE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
var MAX_PATCH_CHARS = 6e4;
var recipePath = (id, dir = RECIPES_DIR) => `${dir.replace(/\/+$/, "")}/${id}.yml`;
var RISK_RANK = { low: 1, medium: 2, high: 3 };
var riskAtMost = (risk, max) => RISK_RANK[risk] <= RISK_RANK[max];
var MANIFEST = /(^|\/)(package\.json|pnpm-workspace\.yaml|go\.mod|Cargo\.toml|pyproject\.toml|setup\.py|setup\.cfg|Gemfile|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|[^/]+\.(csproj|fsproj|sln)|requirements[^/]*\.txt|nx\.json|turbo\.json|lerna\.json|WORKSPACE|MODULE\.bazel|BUILD(\.bazel)?)$/i;
var LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|uv\.lock|packages\.lock\.json|Gemfile\.lock)$/i;
var CONTAINER = /(^|\/)((Dockerfile|Containerfile)(\.[^/]+)?|[^/]+\.(dockerfile|containerfile)|\.dockerignore|(docker-)?compose\.ya?ml)$/i;
var PIPELINE = /^\.github\/(workflows\/[^/]+\.ya?ml|actions\/.+)$|(^|\/)action\.ya?ml$/;
function classifyRisk(paths) {
  if (paths.length > 10 || paths.some((path) => MANIFEST.test(path) || LOCKFILE.test(path))) return "high";
  if (paths.some((path) => CONTAINER.test(path) || !PIPELINE.test(path))) return "medium";
  return "low";
}
var DEFAULT_PATCH_EXCLUDES = ["experiments/**", "corpus/**", ".github/hill-climb.yml"];
function renderPatch(files, max = MAX_PATCH_CHARS) {
  let out = "";
  for (const file of files) {
    const from = file.status === "added" ? "/dev/null" : `a/${file.previous_filename ?? file.filename}`;
    const to = file.status === "removed" ? "/dev/null" : `b/${file.filename}`;
    const section = [`diff --git a/${file.previous_filename ?? file.filename} b/${file.filename}`, `--- ${from}`, `+++ ${to}`, file.patch ?? "(binary or too large to show)", ""].join("\n");
    if (out.length + section.length > max) return `${out}# \u2026 truncated; see the source pull request for the full change.
`;
    out += section;
  }
  return out;
}
var contentSignature = (recipe) => signatureOf([recipe.rules.join(","), recipe.files.join(","), recipe.patch ?? "", recipe.instructions]);
function buildRecipe(options) {
  const { manifest } = options;
  if (manifest.kind !== "pipeline") {
    return { skipped: true, error: `Experiment "${manifest.name}" changes the linter itself (kind: ${manifest.kind}); only pipeline experiments become recipes.` };
  }
  if (manifest.status !== "promoted" || !manifest.winner) return { skipped: true, error: `Experiment "${manifest.name}" has not been promoted (status: ${manifest.status}).` };
  const arm = manifest.arms.find((candidate) => candidate.name === manifest.winner);
  if (!arm) return { error: `Winning arm "${manifest.winner}" is not declared in the manifest.` };
  const excludes = options.excludes ?? DEFAULT_PATCH_EXCLUDES;
  const files = options.files.filter((file) => !excludes.some((glob) => matchesGlob(file.filename, glob)));
  const patchFiles = files.map((file) => file.filename).sort();
  const rules9 = [...manifest.applicability?.rules ?? []].sort();
  const globs = manifest.applicability?.files ?? [];
  if (rules9.length === 0 && globs.length === 0 && patchFiles.length === 0) {
    return { error: `Experiment "${manifest.name}" declares no applicability (rules or files) and its winning arm changed no files.` };
  }
  const patch = files.length > 0 ? renderPatch(files) : void 0;
  const draft = {
    schemaVersion: 1,
    id: manifest.name,
    revision: 1,
    title: manifest.title,
    summary: manifest.hypothesis,
    risk: classifyRisk(patchFiles),
    rules: rules9,
    // Without explicit globs, the files the winner touched decide applicability.
    files: globs.length > 0 ? [...globs] : rules9.length === 0 ? patchFiles : [],
    ...manifest.applicability?.description ? { description: manifest.applicability.description } : {},
    instructions: `${arm.title}: ${arm.approach}`,
    evidence: { improvement: manifest.evidence?.improvement ?? 0, metrics: manifest.evidence?.metrics.map((metric) => ({ ...metric })) ?? [] },
    source: {
      repository: options.repository,
      experiment: manifest.name,
      arm: arm.name,
      ...options.pullRequest !== void 0 ? { pullRequest: options.pullRequest } : {},
      ...options.promotedAt ? { promotedAt: options.promotedAt } : {}
    },
    ...patch ? { patch } : {},
    patchFiles,
    compatibility: { passed: 0, failed: 0 }
  };
  const previous = options.previous;
  if (!previous) return { recipe: draft, changed: true };
  const same = contentSignature(previous) === contentSignature(draft);
  const recipe = { ...draft, revision: same ? previous.revision : previous.revision + 1, compatibility: same ? previous.compatibility : { passed: 0, failed: 0 } };
  return { recipe, changed: serializeRecipe(recipe) !== serializeRecipe(previous) };
}
function serializeRecipe(recipe) {
  return (0, import_yaml21.stringify)(recipe, { lineWidth: 0 });
}
var isRecord2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
var num = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
function parseRecipe(text) {
  let raw;
  try {
    raw = (0, import_yaml21.parse)(text, { maxAliasCount: 100 });
  } catch (error) {
    return { problems: [`Invalid YAML: ${error.message}`] };
  }
  if (!isRecord2(raw)) return { problems: ["A recipe must be a mapping."] };
  const problems = [];
  if (raw.schemaVersion !== 1) problems.push("schemaVersion must be 1.");
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!RECIPE_ID.test(id)) problems.push("id must be lowercase letters, digits and dashes.");
  for (const key of ["title", "summary", "instructions"]) if (typeof raw[key] !== "string" || !raw[key]) problems.push(`${key} is required.`);
  if (!RECIPE_RISKS.includes(raw.risk)) problems.push(`risk must be one of ${RECIPE_RISKS.join(", ")}.`);
  const source = isRecord2(raw.source) ? raw.source : {};
  if (typeof source.repository !== "string" || typeof source.experiment !== "string" || typeof source.arm !== "string") {
    problems.push("source.repository, source.experiment and source.arm are required.");
  }
  const rules9 = strings(raw.rules);
  const files = strings(raw.files);
  if (rules9.length === 0 && files.length === 0) problems.push("A recipe needs rules or files to decide where it applies.");
  if (problems.length > 0) return { problems };
  const evidence2 = isRecord2(raw.evidence) ? raw.evidence : {};
  const compatibility2 = isRecord2(raw.compatibility) ? raw.compatibility : {};
  const pullRequest = num(source.pullRequest);
  return {
    problems,
    recipe: {
      schemaVersion: 1,
      id,
      revision: Math.max(1, Math.floor(num(raw.revision) ?? 1)),
      title: raw.title,
      summary: raw.summary,
      risk: raw.risk,
      rules: rules9,
      files,
      ...typeof raw.description === "string" ? { description: raw.description } : {},
      instructions: raw.instructions,
      evidence: {
        improvement: num(evidence2.improvement) ?? 0,
        metrics: (Array.isArray(evidence2.metrics) ? evidence2.metrics : []).filter(isRecord2).map((metric) => ({
          metric: String(metric.metric ?? ""),
          delta: num(metric.delta) ?? 0,
          ...num(metric.control) !== void 0 ? { control: num(metric.control) } : {},
          ...num(metric.arm) !== void 0 ? { arm: num(metric.arm) } : {},
          ...num(metric.pValue) !== void 0 ? { pValue: num(metric.pValue) } : {}
        }))
      },
      source: {
        repository: source.repository,
        experiment: source.experiment,
        arm: source.arm,
        ...pullRequest !== void 0 ? { pullRequest } : {},
        ...typeof source.promotedAt === "string" ? { promotedAt: source.promotedAt } : {}
      },
      ...typeof raw.patch === "string" && raw.patch ? { patch: raw.patch } : {},
      patchFiles: strings(raw.patchFiles),
      compatibility: { passed: Math.max(0, num(compatibility2.passed) ?? 0), failed: Math.max(0, num(compatibility2.failed) ?? 0) }
    }
  };
}
function sourceUrl(recipe, server = "https://github.com") {
  const base2 = `${server}/${recipe.source.repository}`;
  return recipe.source.pullRequest !== void 0 ? `${base2}/pull/${recipe.source.pullRequest}` : base2;
}

// src/recipes/apply.ts
var recipeGroup = (recipe) => `recipe-${recipe.id}`;
function isOff(setting) {
  return setting === "off" || Array.isArray(setting) && setting[0] === "off";
}
function activeRecipeRules(recipe, config) {
  return recipe.rules.filter((id) => {
    if (isOff(config.rules[id])) return false;
    const ruleset = allRules.find((rule) => rule.meta.id === id)?.meta.ruleset ?? id.split("/")[0];
    return !(ruleset !== void 0 && config.rulesets[ruleset] === "off" && config.rules[id] === void 0);
  });
}
function recipeLintConfig(rules9, config) {
  const settings = {};
  for (const id of rules9) {
    const current = config.rules[id];
    settings[id] = Array.isArray(current) ? ["warn", current[1]] : "warn";
  }
  return { ...config, enabled: true, extends: [], rulesets: {}, rules: settings };
}
function planRecipe(options) {
  const { recipe, input: input2, config } = options;
  const empty = { rules: [], remaining: [], matchedFiles: [] };
  if (!config.enabled || !config.recipes.enabled) return { ...empty, status: "ignored", reason: "Recipes are disabled in this repository." };
  if (config.recipes.ignore.includes(recipe.id)) return { ...empty, status: "ignored", reason: `\`recipes.ignore\` lists "${recipe.id}".` };
  if (!riskAtMost(recipe.risk, config.recipes.maxRisk)) {
    return { ...empty, status: "too-risky", reason: `Recipe risk is ${recipe.risk}; \`recipes.maxRisk\` is ${config.recipes.maxRisk}.` };
  }
  const matchedFiles = input2.files.map((file) => file.path).filter((path) => recipe.files.some((glob) => matchesGlob(path, glob)));
  if (recipe.rules.length === 0) {
    return matchedFiles.length > 0 ? { rules: [], remaining: [], matchedFiles, status: "adapt", reason: `${matchedFiles.length} file(s) match the recipe; the change must be adapted.` } : { ...empty, status: "not-applicable", reason: "No files match the recipe." };
  }
  const rules9 = activeRecipeRules(recipe, config);
  if (rules9.length === 0) return { ...empty, status: "ignored", reason: "All of the recipe's rules are turned off in this repository." };
  const lintConfig = recipeLintConfig(rules9, config);
  const run3 = options.lint ?? ((target, effective) => lint2({ input: target, config: effective }));
  const relevant = (result) => ({
    ...result,
    diagnostics: result.diagnostics.filter((d) => rules9.includes(d.ruleId) && !isIgnored(d, config.fixes))
  });
  const lint3 = (target) => relevant(run3(target, lintConfig));
  const findings = lint3(input2).diagnostics;
  if (findings.length === 0) return { rules: rules9, remaining: [], matchedFiles, status: "not-applicable", reason: "No findings for the recipe's rules." };
  const group = recipeGroup(recipe);
  const fixes = { ...config.fixes, groups: { [group]: { rules: rules9 } } };
  const change = computeFixChanges({ input: input2, lint: lint3, config: fixes }).find((candidate) => candidate.group === group);
  if (!change) return { rules: rules9, remaining: findings, matchedFiles, status: "adapt", reason: `${findings.length} finding(s) need an adapted change (no autofix applies).` };
  const updated = new Map(change.files.map((file) => [file.path, file.content]));
  const remaining = lint3({ ...input2, files: input2.files.map((file) => ({ path: file.path, content: updated.get(file.path) ?? file.content })) }).diagnostics;
  return remaining.length === 0 ? { rules: rules9, change, remaining, matchedFiles, status: "autofix", reason: `Autofixes resolve all ${findings.length} finding(s).` } : { rules: rules9, change, remaining, matchedFiles, status: "partial", reason: `Autofixes resolve ${findings.length - remaining.length} of ${findings.length} finding(s).` };
}
var pct2 = (value) => `${value >= 0 ? "" : "\u2212"}${Math.abs(Math.round(value * 1e3) / 10)}%`;
function evidenceLines(recipe, context) {
  const lines = [
    `**Risk:** ${recipe.risk} \xB7 **Expected improvement:** ${pct2(recipe.evidence.improvement)} \xB7 **Compatibility:** ${context.compatibility.display}`,
    ""
  ];
  if (recipe.evidence.metrics.length > 0) {
    lines.push("| Metric | Control | Winner | Change | p-value |", "| --- | --- | --- | --- | --- |");
    for (const metric of recipe.evidence.metrics) {
      const value = (n) => n === void 0 ? "\u2013" : String(Math.round(n * 100) / 100);
      lines.push(`| ${metric.metric} | ${value(metric.control)} | ${value(metric.arm)} | ${pct2(metric.delta)} | ${metric.pValue === void 0 ? "\u2013" : metric.pValue.toPrecision(2)} |`);
    }
    lines.push("");
  }
  lines.push(
    `Measured in [\`${recipe.source.repository}\`](${sourceUrl(recipe, context.server)}) by experiment \`${recipe.source.experiment}\` (winning arm \`${recipe.source.arm}\`).`
  );
  return lines;
}
function recipeTitle(recipe) {
  return `ci: ${recipe.title.replace(/\.$/, "")} (recipe ${recipe.id})`;
}
function recipePullRequestBody(recipe, change, context) {
  const lines = [
    fixMarker(change, context),
    `${marker("recipe", recipe.id, { revision: String(recipe.revision) })}`,
    `## \u267B\uFE0F CI/CD recipe: ${recipe.title}`,
    "",
    recipe.summary,
    "",
    ...evidenceLines(recipe, context),
    "",
    "### Changes",
    ""
  ];
  for (const file of change.files) {
    lines.push(`- \`${file.path}\``);
    for (const diagnostic of change.applied.filter((d) => d.path === file.path)) lines.push(`  - L${diagnostic.line} \`${diagnostic.ruleId}\`: ${diagnostic.fix?.description ?? diagnostic.message}`);
  }
  lines.push(
    "",
    "### Review notes",
    "",
    "- The edits are the deterministic autofixes of the rules this recipe resolves, computed against this repository (not a copied diff).",
    "- Merge when CI passes; the outcome feeds the recipe's compatibility score that gates rollout to more repositories.",
    `- Add \`${recipe.id}\` to \`recipes.ignore\` in \`.github/ci-cd-optimizer.yml\` to stop receiving this recipe.`,
    "",
    COMMAND_HELP
  );
  return lines.join("\n");
}
function recipeIssue(recipe, plan, options) {
  const signature = signatureOf([String(recipe.revision), plan.status, ...plan.remaining.map((d) => d.fingerprint).sort(), ...plan.matchedFiles]);
  const server = options.server ?? "https://github.com";
  const link = (path, line) => `${server}/${options.owner}/${options.repo}/blob/${options.sha}/${path}${line ? `#L${line}` : ""}`;
  const lines = [
    marker("recipe", recipe.id, { revision: String(recipe.revision), signature }),
    `## \u267B\uFE0F Adapt CI/CD recipe: ${recipe.title}`,
    "",
    recipe.summary,
    "",
    ...evidenceLines(recipe, options),
    ""
  ];
  if (plan.status === "partial" && options.pullRequest !== void 0) {
    lines.push(`Deterministic parts of this recipe are in #${options.pullRequest}; this issue covers what could not be fixed automatically.`, "");
  }
  if (plan.remaining.length > 0) {
    lines.push("### Findings to resolve", "");
    for (const diagnostic of plan.remaining.slice(0, 50)) {
      lines.push(`- [ ] [\`${diagnostic.path}:${diagnostic.line}\`](${link(diagnostic.path, diagnostic.line)}) \`${diagnostic.ruleId}\`: ${diagnostic.message}`);
      if (diagnostic.suggestion) lines.push(`  - **Suggested fix:** ${diagnostic.suggestion}`);
    }
    if (plan.remaining.length > 50) lines.push(`- _\u2026and ${plan.remaining.length - 50} more._`);
    lines.push("");
  } else if (plan.matchedFiles.length > 0) {
    lines.push("### Files in scope", "", ...plan.matchedFiles.slice(0, 50).map((path) => `- [\`${path}\`](${link(path)})`), "");
  }
  lines.push("### Approach that won the experiment", "", recipe.instructions, "");
  if (recipe.description) lines.push(recipe.description, "");
  if (recipe.patch) {
    const fence = recipe.patch.includes("```") ? "````" : "```";
    lines.push(
      "<details><summary>Reference change from the source repository</summary>",
      "",
      "Adapt this to this repository's layout, tool versions and package manager; do not copy it verbatim.",
      "",
      `${fence}diff`,
      recipe.patch.replace(/\n$/, ""),
      fence,
      "",
      "</details>",
      ""
    );
  }
  lines.push(
    "### Instructions for coding agents",
    "",
    "1. Apply the approach above with the smallest behavior-preserving change for this repository.",
    ...plan.rules.length > 0 ? [`2. Verify: \`npx ci-cd-optimizer lint ${plan.rules.map((rule) => `--rule ${rule}=error`).join(" ")}\` reports no findings for ${plan.rules.map((rule) => `\`${rule}\``).join(", ")}, and existing CI passes.`] : ["2. Verify that existing CI passes and that the job durations do not regress."],
    "3. Never add top-level `on.pull_request.paths` filters to workflows that provide required checks, never enable `cancel-in-progress` on deploy/release workflows, and do not weaken permissions or action pinning.",
    "4. Report the CI duration before and after in the pull request description.",
    "",
    `<sub>Opened by CI/CD Optimizer (recipe \`${recipe.id}\`, revision ${recipe.revision}). Close as **not planned** to decline this recipe, or add it to \`recipes.ignore\`.</sub>`
  );
  return {
    fingerprint: recipe.id,
    signature,
    title: `CI/CD recipe: ${recipe.title.replace(/\.$/, "")}`,
    body: lines.join("\n"),
    labels: [.../* @__PURE__ */ new Set(["cicd-optimizer", `recipe:${recipe.id}`, ...options.config.recipes.labels])],
    assignees: [],
    assignCopilot: options.config.recipes.assignCopilot,
    priority: { low: 1, medium: 2, high: 3 }[recipe.risk]
  };
}

// src/recipes/github.ts
async function publishRecipe(client, repo, options) {
  let manifest = options.manifest;
  if (!manifest) {
    const ref = options.ref ?? await defaultBranch(client, repo);
    const text = await readFileAt(client, repo, manifestPath(options.experiment), ref);
    if (text === void 0) return { error: `${manifestPath(options.experiment)} was not found on ${ref}.` };
    const parsed = parseManifest2(text, { config: options.config });
    if (!parsed.manifest) return { error: `Invalid manifest: ${parsed.problems.map((problem) => `${problem.path}: ${problem.message}`).join("; ")}` };
    manifest = parsed.manifest;
  }
  const pulls = await listExperimentPullRequests(client, repo, "all");
  const winner = pulls.find((pull) => pull.experiment === manifest.name && pull.arm === manifest.winner && pull.merged);
  const files = winner ? await paginate(client, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { ...repo, pull_number: winner.number }, 3) : [];
  return buildRecipe({
    manifest,
    repository: `${repo.owner}/${repo.repo}`,
    files,
    ...winner ? { pullRequest: winner.number } : {},
    ...winner?.closedAt ? { promotedAt: winner.closedAt } : {},
    ...options.previous ? { previous: options.previous } : {}
  });
}
async function applyRecipe(client, target, recipe, options = {}) {
  const name = `${target.owner}/${target.repo}`;
  const branch = await defaultBranch(client, target);
  const remote = await loadRemoteConfig(client, target, branch);
  if (remote.problems.length > 0) {
    return {
      repo: name,
      attempted: false,
      plan: { status: "ignored", reason: `Invalid ${remote.path ?? "configuration"}; fix it before recipes can be applied.`, rules: [], remaining: [], matchedFiles: [] },
      configProblems: remote.problems.map((problem) => `${problem.path}: ${problem.message}`)
    };
  }
  const config = remote.config;
  const snapshot = await loadRepositorySnapshot(client, target, { ref: branch, config });
  const plan = planRecipe({ recipe, input: snapshot.input, config });
  const result = { repo: name, plan, attempted: false };
  if (options.dryRun) return result;
  const compat = compatibility(options.compatibility ?? recipe.compatibility);
  const render = { compatibility: compat, ...options.server ? { server: options.server } : {} };
  const group = recipeGroup(recipe);
  const existingPulls = (await listManagedPullRequests(client, target, {
    baseBranch: branch,
    branchPrefix: config.fixes.branchPrefix,
    groups: [group]
  })).filter((pr) => pr.group === group);
  const fixes = { ...config.fixes, labels: [.../* @__PURE__ */ new Set([...config.fixes.labels, `recipe:${recipe.id}`, ...config.recipes.labels])] };
  const fixPlan = planFixPullRequests(plan.change ? [plan.change] : [], existingPulls, {
    openPullRequestsLimit: 1,
    labels: ["cicd-optimizer", ...fixes.labels],
    reviewers: fixes.reviewers
  });
  const appliedPulls = await applyFixActions(client, target, fixPlan.actions, {
    baseBranch: branch,
    baseSha: snapshot.sha,
    config: fixes,
    rules: allRules,
    existing: existingPulls,
    render: {
      title: () => recipeTitle(recipe),
      body: (change, context) => recipePullRequestBody(recipe, change, { ...render, ...context })
    }
  });
  const pull = appliedPulls.find((applied) => applied.action.type !== "close")?.number ?? fixPlan.skipped.find((skip) => skip.number !== void 0)?.number;
  if (pull !== void 0 && plan.change) result.pullRequest = pull;
  const wantsIssue = plan.status === "adapt" || plan.status === "partial";
  const existingIssues = (await listManagedIssues(client, target, "recipe")).filter((issue2) => issue2.fingerprint === recipe.id);
  const desired = wantsIssue ? [recipeIssue(recipe, plan, { ...render, config, owner: target.owner, repo: target.repo, sha: snapshot.sha, ...result.pullRequest !== void 0 ? { pullRequest: result.pullRequest } : {} })] : [];
  const issuePlan = planIssueSync(existingIssues, desired, {
    maxOpen: 1,
    closeResolved: true,
    resolvedComment: "This recipe no longer applies here (it was applied, the findings are gone, or the repository opted out)."
  });
  const appliedIssues = await applyIssueActions(client, target, issuePlan.actions, {
    ...options.copilotClient ? { copilotClient: options.copilotClient } : {},
    copilot: config.issues.copilot
  });
  const issue = appliedIssues.find((applied) => applied.action.type !== "close");
  if (issue) {
    result.issue = issue.number;
    if (issue.copilot) result.copilot = issue.copilot;
  } else if (wantsIssue) {
    const open = existingIssues.find((candidate) => candidate.state === "open");
    if (open) result.issue = open.number;
  }
  result.attempted = result.pullRequest !== void 0 || result.issue !== void 0;
  return result;
}
async function recipeStatus(client, target, recipe, server = "https://github.com") {
  const name = `${target.owner}/${target.repo}`;
  const group = recipeGroup(recipe);
  const revision = String(recipe.revision);
  const pulls = (await listManagedPullRequests(client, target)).filter((pr) => pr.group === group && (pr.state === "open" || findMarker(pr.body, "recipe")?.attributes.revision === revision)).sort((a, b) => b.number - a.number);
  const pull = pulls[0];
  if (pull) {
    const url = `${server}/${name}/pull/${pull.number}`;
    if (pull.merged) return { repo: name, state: "passed", number: pull.number, url };
    const sha = pull.headSha ?? pull.commitSha;
    let runs = [];
    if (sha) {
      const response = await client.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...target, ref: sha, per_page: 100 });
      runs = response.data.check_runs ?? [];
    }
    const state = classifyOutcome(runs.filter((run3) => run3.name !== "CI/CD Optimizer"), pull);
    return { repo: name, state: pull.state === "closed" && state === "unknown" ? "failed" : state, number: pull.number, url };
  }
  const issues = (await listManagedIssues(client, target, "recipe")).filter((issue2) => issue2.fingerprint === recipe.id && (issue2.state === "open" || issue2.attributes.revision === revision)).sort((a, b) => b.number - a.number);
  const issue = issues[0];
  if (issue) return { repo: name, state: classifyIssueOutcome(issue), number: issue.number, url: `${server}/${name}/issues/${issue.number}` };
  return { repo: name, state: "untouched" };
}

// src/recipes/rollout.ts
var import_yaml22 = __toESM(require_dist(), 1);
var DEFAULT_ROLLOUT = { waves: [1, 3, "25%", "100%"], minSamples: 5, minCompatibility: 0.7 };
var REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
function parseRolloutTargets(text) {
  const problems = [];
  let raw;
  try {
    raw = (0, import_yaml22.parse)(text);
  } catch (error) {
    return { repositories: [], canaries: [], config: DEFAULT_ROLLOUT, problems: [`Invalid YAML: ${error.message}`] };
  }
  const root = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
  const names = (key) => {
    const value = root[key];
    if (value === void 0) return [];
    if (!Array.isArray(value)) {
      problems.push(`${key} must be a list of owner/name repositories.`);
      return [];
    }
    const valid = value.filter((item) => typeof item === "string" && REPO_NAME.test(item));
    if (valid.length !== value.length) problems.push(`${key} must only contain owner/name repositories.`);
    return [...new Set(valid)];
  };
  const repositories = names("repositories");
  const canaries = names("canaries");
  if (repositories.length === 0 && problems.length === 0) problems.push("repositories must list at least one owner/name repository.");
  for (const canary of canaries) if (!repositories.includes(canary)) problems.push(`canary ${canary} is not in repositories.`);
  const rollout = typeof root.rollout === "object" && root.rollout !== null ? root.rollout : {};
  const config = { ...DEFAULT_ROLLOUT, waves: [...DEFAULT_ROLLOUT.waves] };
  if (rollout.waves !== void 0) {
    const waves = Array.isArray(rollout.waves) ? rollout.waves.map(parseWaveSize) : [void 0];
    if (waves.length === 0 || waves.some((wave) => wave === void 0)) problems.push('rollout.waves must be a non-empty list of positive integers or percentages such as "25%".');
    else config.waves = waves;
  }
  if (rollout.minSamples !== void 0) {
    if (typeof rollout.minSamples === "number" && Number.isInteger(rollout.minSamples) && rollout.minSamples >= 1) config.minSamples = rollout.minSamples;
    else problems.push("rollout.minSamples must be a positive integer.");
  }
  if (rollout.minCompatibility !== void 0) {
    if (typeof rollout.minCompatibility === "number" && rollout.minCompatibility >= 0 && rollout.minCompatibility <= 1) config.minCompatibility = rollout.minCompatibility;
    else problems.push("rollout.minCompatibility must be a number between 0 and 1.");
  }
  return { repositories, canaries, config, problems };
}
function fnv1a(text) {
  let hash2 = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash2 ^= text.charCodeAt(index);
    hash2 = Math.imul(hash2, 16777619) >>> 0;
  }
  return hash2;
}
function rolloutOrder(id, repositories, canaries = []) {
  const unique = [...new Set(repositories)];
  const first = canaries.filter((repo, index) => unique.includes(repo) && canaries.indexOf(repo) === index);
  const rest = unique.filter((repo) => !first.includes(repo)).sort((a, b) => fnv1a(`${id}:${a}`) - fnv1a(`${id}:${b}`) || a.localeCompare(b));
  return [...first, ...rest];
}
function parseWaveSize(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^\d+(\.\d+)?%$/.test(value)) {
    const percent = Number(value.slice(0, -1));
    if (percent > 0 && percent <= 100) return value;
  }
  return void 0;
}
function waveSizes(waves, total) {
  const sizes = [];
  let previous = 0;
  for (const wave of waves) {
    const size = typeof wave === "number" ? wave : Math.ceil(Number(wave.slice(0, -1)) / 100 * total);
    previous = Math.min(total, Math.max(previous, size));
    sizes.push(previous);
  }
  if (sizes.length === 0 || sizes[sizes.length - 1] < total) sizes.push(total);
  return sizes;
}
function planRollout(options) {
  const config = options.config ?? DEFAULT_ROLLOUT;
  const counts = { untouched: 0, "not-applicable": 0, passed: 0, failed: 0, pending: 0, unknown: 0 };
  const state = /* @__PURE__ */ new Map();
  for (const target of options.targets) {
    state.set(target.repo, target.state);
    counts[target.state] += 1;
  }
  const order = rolloutOrder(
    options.id,
    options.targets.filter((target) => target.state !== "not-applicable").map((target) => target.repo),
    options.canaries
  );
  const candidates = order.filter((repo) => state.get(repo) === "untouched");
  const attempted = order.length - candidates.length;
  const compat = compatibility({ passed: counts.passed, failed: counts.failed }, config.minSamples);
  const sizes = waveSizes(config.waves, order.length);
  const reached = Math.max(0, sizes.findIndex((size) => size >= attempted));
  const base2 = { order, counts, compatibility: compat, candidates, slots: 0, wave: reached };
  if (order.length === 0) return { ...base2, action: "complete", reason: "No applicable repositories." };
  if (candidates.length === 0) return { ...base2, action: "complete", reason: `Applied to all ${order.length} applicable repositories.` };
  if (counts.pending > 0) return { ...base2, action: "wait", reason: `${counts.pending} change(s) still running CI or awaiting review.` };
  const resolved = counts.passed + counts.failed;
  if (attempted > 0 && resolved === 0) {
    return { ...base2, action: "halt", reason: "Changes were opened but produced no CI evidence (no check runs); add CI to the targets or review manually." };
  }
  if (resolved < config.minSamples) {
    if (counts.failed > 0) return { ...base2, action: "halt", reason: `${counts.failed} of ${resolved} change(s) failed before the minimum of ${config.minSamples} samples.` };
  } else if (compat.lowerBound < config.minCompatibility) {
    return {
      ...base2,
      action: "halt",
      reason: `Compatibility lower bound ${Math.round(compat.lowerBound * 100)}% is below the required ${Math.round(config.minCompatibility * 100)}%.`
    };
  }
  const wave = sizes.findIndex((size) => size > attempted);
  const slots = sizes[wave] - attempted;
  return { ...base2, action: "advance", wave, slots, reason: `Opening wave ${wave + 1} of ${sizes.length}: ${slots} more repositor${slots === 1 ? "y" : "ies"}.` };
}

// src/cli/recipes.ts
var RECIPES_HELP = `Usage: ci-cd-optimizer recipes <command> [options]

Reusable fixes built from promoted pipeline experiments, rolled out to other repositories
Dependabot-style with a CI-based compatibility score (see docs/recipes.md).

Commands:
  publish     Build recipes/<id>.yml from a promoted experiment and its merged winning arm
  apply       Open (or sync) the recipe's pull request / adaptation issue in one repository
  status      Show the recipe's state in each target and the rollout decision
  rollout     Apply the recipe to the next wave of targets when the previous wave proved compatible

Options:
      --repo <owner/name>     Source repository for publish (default: $GITHUB_REPOSITORY)
      --recipe <file>         Recipe file (apply, status, rollout)
      --targets <file>        Targets file: repositories, canaries, rollout waves (status, rollout)
      --repos <a,b>           Comma-separated targets instead of --targets
      --canary <a,b>          Repositories to roll out to first
      --format text|json      Output format (default: text)
      --dry-run               Plan without opening or updating pull requests and issues

publish:  --experiment <name> [--manifest <file>] [--ref <branch>] [--output-dir ${RECIPES_DIR}] [--config <file>]
apply:    --recipe <file> --target <owner/name> [--dry-run]
status:   --recipe <file> (--targets <file> | --repos <a,b>) [--write]
rollout:  --recipe <file> (--targets <file> | --repos <a,b>) [--canary <a,b>] [--max-scan <n>] [--write] [--summary <file>] [--dry-run]

--write stores the current compatibility counts in the recipe file (commit it to publish the score).
Cross-repository writes need a token that can open pull requests in the targets, such as a GitHub App
installation token. Set COPILOT_ASSIGN_TOKEN to assign adaptation issues to the Copilot coding agent.
`;
var COMMON2 = {
  format: { type: "string", short: "f", default: "text" },
  "dry-run": { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false }
};
async function readText2(io, path) {
  try {
    return await readFile5(resolvePath(io, path), "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read ${path}: ${error.message}`);
  }
}
async function loadRecipe(io, path) {
  if (!path) throw new UsageError("--recipe <file> is required.");
  const parsed = parseRecipe(await readText2(io, path));
  if (!parsed.recipe) throw new UsageError(`Invalid recipe ${path}:
${parsed.problems.map((problem) => `  ${problem}`).join("\n")}`);
  return parsed.recipe;
}
var list2 = (value) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
function checkRepos(names, flag) {
  for (const name of names) {
    try {
      parseRepo(name);
    } catch {
      throw new UsageError(`${flag}: "${name}" is not an owner/name repository.`);
    }
  }
  return [...new Set(names)];
}
async function loadTargets(io, values) {
  if (values.targets && values.repos) throw new UsageError("Use either --targets or --repos, not both.");
  let targets;
  if (values.targets) {
    const parsed = parseRolloutTargets(await readText2(io, values.targets));
    if (parsed.problems.length > 0) throw new UsageError(`Invalid ${values.targets}:
${parsed.problems.map((problem) => `  ${problem}`).join("\n")}`);
    targets = parsed;
  } else if (values.repos) {
    targets = { repositories: checkRepos(list2(values.repos), "--repos"), canaries: [], config: DEFAULT_ROLLOUT };
  } else {
    throw new UsageError("--targets <file> or --repos <a,b> is required.");
  }
  if (values.canary) {
    const canaries = checkRepos(list2(values.canary), "--canary");
    const unknown2 = canaries.filter((canary) => !targets.repositories.includes(canary));
    if (unknown2.length > 0) throw new UsageError(`--canary: ${unknown2.join(", ")} not in the targets.`);
    targets = { ...targets, canaries };
  }
  return targets;
}
function format2(value) {
  if (value === "text" || value === "json") return value;
  throw new UsageError(`Unknown format "${value}". Use text or json.`);
}
async function loadHillClimbConfig2(io, explicit) {
  const path = resolvePath(io, explicit ?? HILL_CLIMB_CONFIG_PATH);
  const text = await readFile5(path, "utf8").catch((error) => {
    if (error.code === "ENOENT" && !explicit) return void 0;
    throw new UsageError(`Cannot read ${path}: ${error.message}`);
  });
  const parsed = parseHillClimbConfig(text);
  if (parsed.problems.length > 0) throw new UsageError(`Invalid ${path}:
${parsed.problems.map((p) => `  ${p.path || "(root)"}: ${p.message}`).join("\n")}`);
  return parsed.config;
}
async function publishCommand(args, io) {
  const { values } = parseArgs3({
    args,
    strict: true,
    options: { ...COMMON2, repo: { type: "string" }, config: { type: "string" }, experiment: { type: "string" }, manifest: { type: "string" }, ref: { type: "string" }, "output-dir": { type: "string", default: RECIPES_DIR } }
  });
  const outputFormat = format2(values.format);
  const config = await loadHillClimbConfig2(io, values.config);
  let manifest;
  if (values.manifest) {
    const parsed = parseManifest2(await readText2(io, values.manifest), { config });
    if (!parsed.manifest) throw new UsageError(`Invalid ${values.manifest}:
${parsed.problems.map((p) => `  ${p.path}: ${p.message}`).join("\n")}`);
    manifest = parsed.manifest;
  }
  const experiment = values.experiment ?? manifest?.name;
  if (!experiment) throw new UsageError("--experiment <name> or --manifest <file> is required.");
  if (manifest && manifest.name !== experiment) throw new UsageError(`--manifest is for "${manifest.name}", not "${experiment}".`);
  const repo = repoFrom(values.repo, io);
  const outputDir = values["output-dir"] ?? RECIPES_DIR;
  const target = resolvePath(io, recipePath(experiment, outputDir));
  const existing = await readFile5(target, "utf8").catch(() => void 0);
  const previous = existing === void 0 ? void 0 : parseRecipe(existing).recipe;
  const built = await publishRecipe(githubClient(io), repo, {
    experiment,
    config,
    ...manifest ? { manifest } : {},
    ...values.ref ? { ref: values.ref } : {},
    ...previous ? { previous } : {}
  });
  if ("error" in built) {
    if (built.skipped) {
      io.stderr(`Skipped: ${built.error}`);
      if (outputFormat === "json") io.stdout(JSON.stringify({ experiment, skipped: true, reason: built.error }, null, 2));
      return 0;
    }
    throw new Error(built.error);
  }
  const path = recipePath(built.recipe.id, outputDir);
  if (built.changed && !values["dry-run"]) await writeText(io, path, serializeRecipe(built.recipe));
  if (outputFormat === "json") {
    io.stdout(JSON.stringify({ id: built.recipe.id, revision: built.recipe.revision, risk: built.recipe.risk, changed: built.changed, path, written: built.changed && !values["dry-run"] }, null, 2));
  } else {
    const verb = !built.changed ? "unchanged" : values["dry-run"] ? "would write" : "wrote";
    io.stdout(`${path}: ${verb} (revision ${built.recipe.revision}, risk ${built.recipe.risk}, ${built.recipe.rules.length} rule(s), ${built.recipe.patchFiles.length} file(s))`);
    if (values["dry-run"] && built.changed) io.stdout(serializeRecipe(built.recipe));
  }
  return 0;
}
function describeApply(result) {
  const links = [
    result.pullRequest !== void 0 ? `PR #${result.pullRequest}` : "",
    result.issue !== void 0 ? `issue #${result.issue}${result.copilot ? ` (assigned to ${result.copilot})` : ""}` : ""
  ].filter(Boolean);
  const problems = result.configProblems?.length ? `
  ${result.configProblems.join("\n  ")}` : "";
  return `${result.repo}: ${result.plan.status}${links.length ? ` \u2192 ${links.join(", ")}` : ""} - ${result.plan.reason}${problems}`;
}
function applySummary(result) {
  return {
    repo: result.repo,
    status: result.plan.status,
    reason: result.plan.reason,
    attempted: result.attempted,
    rules: result.plan.rules,
    remaining: result.plan.remaining.map((diagnostic) => ({ ruleId: diagnostic.ruleId, path: diagnostic.path, line: diagnostic.line })),
    ...result.pullRequest !== void 0 ? { pullRequest: result.pullRequest } : {},
    ...result.issue !== void 0 ? { issue: result.issue } : {},
    ...result.copilot ? { copilot: result.copilot } : {},
    ...result.configProblems ? { configProblems: result.configProblems } : {}
  };
}
async function applyCommand(args, io) {
  const { values } = parseArgs3({ args, strict: true, options: { ...COMMON2, recipe: { type: "string" }, target: { type: "string" } } });
  const outputFormat = format2(values.format);
  const recipe = await loadRecipe(io, values.recipe);
  if (!values.target) throw new UsageError("--target <owner/name> is required.");
  const target = repoFrom(values.target, io);
  const copilot = copilotClient(io);
  const result = await applyRecipe(githubClient(io), target, recipe, {
    dryRun: values["dry-run"],
    ...copilot ? { copilotClient: copilot } : {},
    ...io.env.GITHUB_SERVER_URL ? { server: io.env.GITHUB_SERVER_URL } : {}
  });
  io.stdout(outputFormat === "json" ? JSON.stringify(applySummary(result), null, 2) : describeApply(result));
  return result.configProblems ? 1 : 0;
}
async function collectStatuses(client, recipe, repositories, server) {
  const statuses = [];
  for (const name of repositories) statuses.push(await recipeStatus(client, parseRepo(name), recipe, server));
  return statuses;
}
async function storeCompatibility(io, path, recipe, plan) {
  const next = { passed: plan.counts.passed, failed: plan.counts.failed };
  if (next.passed === recipe.compatibility.passed && next.failed === recipe.compatibility.failed) return false;
  await writeText(io, path, serializeRecipe({ ...recipe, compatibility: next }));
  return true;
}
function renderStatus(recipe, statuses, plan, applied = []) {
  const lines = [
    `## \u267B\uFE0F Recipe rollout: ${recipe.title} (\`${recipe.id}\` r${recipe.revision})`,
    "",
    `**Decision:** ${plan.action} - ${plan.reason}`,
    "",
    `**Compatibility:** ${plan.compatibility.display}`,
    "",
    "| Repository | State | Change |",
    "| --- | --- | --- |"
  ];
  for (const status of statuses) {
    const change = status.number !== void 0 ? status.url ? `[#${status.number}](${status.url})` : `#${status.number}` : "";
    lines.push(`| ${status.repo} | ${status.state} | ${change} |`);
  }
  if (applied.length > 0) {
    lines.push("", "### This run", "");
    for (const result of applied) lines.push(`- ${describeApply(result)}`);
  }
  return lines.join("\n");
}
async function statusCommand(args, io) {
  const { values } = parseArgs3({ args, strict: true, options: { ...COMMON2, recipe: { type: "string" }, targets: { type: "string" }, repos: { type: "string" }, canary: { type: "string" }, write: { type: "boolean", default: false } } });
  const outputFormat = format2(values.format);
  const recipe = await loadRecipe(io, values.recipe);
  const targets = await loadTargets(io, values);
  const server = io.env.GITHUB_SERVER_URL ?? "https://github.com";
  const statuses = await collectStatuses(githubClient(io), recipe, targets.repositories, server);
  const plan = planRollout({ id: recipe.id, targets: statuses, config: targets.config, canaries: targets.canaries });
  if (values.write) await storeCompatibility(io, values.recipe, recipe, plan);
  io.stdout(outputFormat === "json" ? JSON.stringify({ recipe: recipe.id, revision: recipe.revision, statuses, plan }, null, 2) : renderStatus(recipe, statuses, plan));
  return 0;
}
async function rolloutCommand(args, io) {
  const { values } = parseArgs3({
    args,
    strict: true,
    options: {
      ...COMMON2,
      recipe: { type: "string" },
      targets: { type: "string" },
      repos: { type: "string" },
      canary: { type: "string" },
      write: { type: "boolean", default: false },
      summary: { type: "string" },
      "max-scan": { type: "string", default: "50" }
    }
  });
  const outputFormat = format2(values.format);
  const maxScan = Number(values["max-scan"]);
  if (!Number.isInteger(maxScan) || maxScan < 1) throw new UsageError("--max-scan must be a positive integer.");
  const recipe = await loadRecipe(io, values.recipe);
  const targets = await loadTargets(io, values);
  const client = githubClient(io);
  const server = io.env.GITHUB_SERVER_URL ?? "https://github.com";
  const statuses = await collectStatuses(client, recipe, targets.repositories, server);
  const plan = planRollout({ id: recipe.id, targets: statuses, config: targets.config, canaries: targets.canaries });
  const applied = [];
  if (plan.action === "advance") {
    const copilot = copilotClient(io);
    let opened = 0;
    let scanned = 0;
    for (const name of plan.candidates) {
      if (opened >= plan.slots || scanned >= maxScan) break;
      scanned += 1;
      try {
        const result = await applyRecipe(client, parseRepo(name), recipe, {
          dryRun: values["dry-run"],
          compatibility: { passed: plan.counts.passed, failed: plan.counts.failed },
          ...copilot ? { copilotClient: copilot } : {},
          server
        });
        applied.push(result);
        const opens = values["dry-run"] ? ["autofix", "partial", "adapt"].includes(result.plan.status) : result.attempted;
        if (opens) opened += 1;
      } catch (error) {
        applied.push({
          repo: name,
          attempted: false,
          plan: { status: "ignored", reason: `Failed: ${error.message}`, rules: [], remaining: [], matchedFiles: [] }
        });
      }
    }
  }
  if (values.write && !values["dry-run"]) await storeCompatibility(io, values.recipe, recipe, plan);
  const markdown2 = renderStatus(recipe, statuses, plan, applied);
  if (values.summary) await writeText(io, values.summary, markdown2);
  io.stdout(
    outputFormat === "json" ? JSON.stringify({ recipe: recipe.id, revision: recipe.revision, plan, statuses, applied: applied.map(applySummary) }, null, 2) : markdown2
  );
  return 0;
}
var COMMANDS2 = {
  publish: publishCommand,
  apply: applyCommand,
  status: statusCommand,
  rollout: rolloutCommand
};
async function recipesCommand(args, io) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || rest.includes("--help") || rest.includes("-h")) {
    io.stdout(RECIPES_HELP);
    return command && !COMMANDS2[command] && command !== "--help" && command !== "-h" ? 2 : 0;
  }
  const handler = COMMANDS2[command];
  if (!handler) throw new UsageError(`Unknown recipes command "${command}". Commands: ${Object.keys(COMMANDS2).join(", ")}.`);
  return handler(rest, io);
}

// src/cli/scan.ts
import { parseArgs as parseArgs4 } from "node:util";

// src/github/code-scanning.ts
import { gzipSync } from "node:zlib";
async function uploadSarif(client, repo, options) {
  const text = typeof options.sarif === "string" ? options.sarif : JSON.stringify(options.sarif);
  try {
    const response = await client.request("POST /repos/{owner}/{repo}/code-scanning/sarifs", {
      ...repo,
      commit_sha: options.commitSha,
      ref: options.ref.startsWith("refs/") ? options.ref : `refs/heads/${options.ref}`,
      sarif: gzipSync(Buffer.from(text, "utf8")).toString("base64"),
      tool_name: options.toolName ?? "CI/CD Optimizer"
    });
    const id = response.data?.id;
    return id ? { status: "uploaded", id } : { status: "uploaded" };
  } catch (error) {
    const status = httpStatus(error);
    if (status === 403 || status === 404) {
      return { status: "unavailable", reason: "Code scanning is not enabled for this repository (requires GitHub Advanced Security for private repositories)." };
    }
    if (status === 413) return { status: "unavailable", reason: "SARIF payload exceeds the code scanning size limit." };
    throw error;
  }
}

// src/issues/render.ts
var IMPACT_RANK = { low: 1, medium: 2, high: 3 };
var SEVERITY_RANK2 = { info: 1, warn: 2, error: 3 };
function qualifies(diagnostic, config) {
  const override = config.rules[diagnostic.ruleId];
  if (override !== void 0) return override;
  return atLeast(diagnostic.severity, config.minSeverity) && IMPACT_RANK[diagnostic.impact] >= IMPACT_RANK[config.minImpact];
}
function permalink(context, diagnostic) {
  return `https://github.com/${context.owner}/${context.repo}/blob/${context.sha}/${diagnostic.path}#L${diagnostic.line}`;
}
function labelsFor(diagnostics, config) {
  const first = diagnostics[0];
  const severity = diagnostics.reduce((max, d) => SEVERITY_RANK2[d.severity] > SEVERITY_RANK2[max] ? d.severity : max, first.severity);
  const impact = diagnostics.reduce((max, d) => IMPACT_RANK[d.impact] > IMPACT_RANK[max] ? d.impact : max, first.impact);
  return [.../* @__PURE__ */ new Set(["cicd-optimizer", `ruleset:${first.ruleset}`, `severity:${severity}`, `impact:${impact}`, ...config.labels])];
}
function priority(diagnostics) {
  return Math.max(...diagnostics.map((d) => SEVERITY_RANK2[d.severity] * 10 + IMPACT_RANK[d.impact])) * 1e3 + diagnostics.length;
}
function agentInstructions(ruleId, rule) {
  return [
    "### Instructions for coding agents",
    "",
    "This issue is written to be picked up by a background coding agent (for example the Copilot coding agent).",
    "",
    "1. Fix every unchecked finding above with the smallest behavior-preserving change; follow **Suggested fix**.",
    `2. Verify: the **CI/CD Optimizer** check on your pull request reports no \`${ruleId}\` findings (or run \`ci-cd-optimizer lint --rule ${ruleId}\` locally), and the repository's existing CI passes.`,
    "3. Do not add top-level `on.pull_request.paths` filters to workflows that provide required checks, never enable `cancel-in-progress` on deploy/release workflows, and do not weaken security settings (permissions, pinning).",
    "4. Describe measured or expected CI time savings in the pull request description.",
    ...rule?.meta.fixable ? ["", `_Some findings have deterministic autofixes: \`ci-cd-optimizer lint --fix --rule ${ruleId}\`._`] : []
  ];
}
function renderRuleIssue(ruleId, diagnostics, context) {
  const rule = context.rules.find((candidate) => candidate.meta.id === ruleId);
  const first = diagnostics[0];
  const title = `CI/CD: ${rule?.meta.description.replace(/\.$/, "") ?? ruleId} (${diagnostics.length} finding${diagnostics.length === 1 ? "" : "s"})`;
  const lines = [
    `## \`${ruleId}\``,
    "",
    `**Severity:** ${first.severity} \xB7 **Impact:** ${first.impact} \xB7 **Ruleset:** \`${first.ruleset}\` \xB7 **Kind:** ${first.kind}`,
    "",
    "### Why this matters",
    "",
    rule?.meta.rationale ?? first.message,
    "",
    "### Findings",
    ""
  ];
  for (const diagnostic of diagnostics.slice(0, 50)) {
    lines.push(`- [ ] [\`${diagnostic.path}:${diagnostic.line}\`](${permalink(context, diagnostic)}): ${diagnostic.message}`);
    if (diagnostic.suggestion) lines.push(`  - **Suggested fix:** ${diagnostic.suggestion}`);
  }
  if (diagnostics.length > 50) lines.push(`- _\u2026and ${diagnostics.length - 50} more._`);
  if (rule?.meta.example) {
    lines.push("", "### Example", "", "Before:", "", "```yaml", rule.meta.example.bad, "```", "", "After:", "", "```yaml", rule.meta.example.good, "```");
  }
  lines.push("", ...agentInstructions(ruleId, rule), "", `[Rule documentation](${first.docsUrl})`);
  if (rule && rule.meta.references.length > 0) lines.push("", ...rule.meta.references.map((reference) => `- <${reference}>`));
  lines.push(
    "",
    "<sub>Opened by CI/CD Optimizer. It updates this issue as findings change and closes it when they are resolved. Close it as **not planned** to dismiss this rule's findings.</sub>"
  );
  return { title, body: lines.join("\n") };
}
function desiredIssues(diagnostics, config, context) {
  const selected = diagnostics.filter((diagnostic) => qualifies(diagnostic, config));
  const groups = /* @__PURE__ */ new Map();
  for (const diagnostic of selected) {
    const key = config.groupBy === "rule" ? `rule:${diagnostic.ruleId}` : `finding:${diagnostic.fingerprint}`;
    groups.set(key, [...groups.get(key) ?? [], diagnostic]);
  }
  return [...groups.entries()].map(([fingerprint2, group]) => {
    const ruleId = group[0].ruleId;
    const signature = signatureOf(group.map((d) => `${d.fingerprint}|${d.severity}|${d.message}|${d.suggestion ?? ""}`).sort());
    const rendered = renderRuleIssue(ruleId, group, context);
    return {
      fingerprint: fingerprint2,
      signature,
      title: rendered.title,
      body: `${marker("finding", fingerprint2, { signature, rule: ruleId })}
${rendered.body}`,
      labels: labelsFor(group, config),
      assignees: config.assignees,
      assignCopilot: config.assignCopilot,
      priority: priority(group)
    };
  });
}

// src/service/scan.ts
var isRecipeGroup = (group) => group.startsWith("recipe-");
async function scanRepository(client, repo, options = {}) {
  const name = `${repo.owner}/${repo.repo}`;
  const branch = await defaultBranch(client, repo);
  const ref = options.ref ?? branch;
  const remote = await loadRemoteConfig(client, repo, branch);
  if (remote.problems.length > 0) {
    return { repo: name, ref, status: "invalid-config", configProblems: remote.problems.map((problem) => `${problem.path}: ${problem.message}`) };
  }
  const config = remote.config;
  if (!config.enabled) return { repo: name, ref, status: "disabled" };
  const snapshot = await loadRepositorySnapshot(client, repo, { ref, config });
  const { input: input2 } = snapshot;
  const truncated = new Set(input2.truncated);
  const result = lint2({ input: input2, config });
  const scan = {
    repo: name,
    ref,
    sha: snapshot.sha,
    status: "scanned",
    result,
    inventoryComplete: input2.inventoryComplete,
    truncated: input2.truncated
  };
  if (options.uploadSarif) {
    scan.sarif = options.dryRun ? { status: "skipped" } : await uploadSarif(client, repo, { sarif: sarif(result, allRules, VERSION), commitSha: snapshot.sha, ref: ref === snapshot.sha ? branch : ref });
  }
  const onDefaultBranch = ref === branch || ref === `refs/heads/${branch}`;
  if (onDefaultBranch && options.issues !== false && config.issues.enabled) {
    const existing = await listManagedIssues(client, repo, "finding");
    const desired = desiredIssues(result.diagnostics, config.issues, { owner: repo.owner, repo: repo.repo, sha: snapshot.sha, rules: allRules });
    const plan = planIssueSync(existing, desired, { maxOpen: config.issues.maxOpen, closeResolved: config.issues.closeResolved && input2.inventoryComplete });
    const applied = options.dryRun ? [] : await applyIssueActions(client, repo, plan.actions, { ...options.copilotClient ? { copilotClient: options.copilotClient } : {}, copilot: config.issues.copilot });
    scan.issues = { ...plan, applied };
  }
  if (onDefaultBranch && options.fixes !== false && config.fixes.enabled) {
    const existing = (await listManagedPullRequests(client, repo, {
      baseBranch: branch,
      branchPrefix: config.fixes.branchPrefix,
      groups: [...Object.keys(config.fixes.groups), ...allRules.map((rule) => rule.meta.ruleset)]
    })).filter((pr) => !isRecipeGroup(pr.group));
    const changes = computeFixChanges({
      input: input2,
      // Fixing a file the inventory only partly read would truncate it.
      lint: (next) => {
        const linted = lint2({ input: next, config });
        return { ...linted, diagnostics: linted.diagnostics.filter((diagnostic) => !truncated.has(diagnostic.path)) };
      },
      config: config.fixes,
      dismissed: dismissalsFrom(existing)
    });
    const plan = planFixPullRequests(changes, existing, {
      openPullRequestsLimit: config.fixes.openPullRequestsLimit,
      labels: ["cicd-optimizer", ...config.fixes.labels],
      reviewers: config.fixes.reviewers,
      ...options.rebase ? { rebase: options.rebase } : {},
      ...options.recreate ? { recreate: options.recreate } : {}
    });
    const applied = options.dryRun ? [] : await applyFixActions(client, repo, plan.actions, { baseBranch: branch, baseSha: snapshot.sha, config: config.fixes, rules: allRules, existing });
    scan.fixes = { ...plan, applied };
  }
  return scan;
}
function describeScan(scan) {
  if (scan.status === "disabled") return `${scan.repo}: disabled by configuration.`;
  if (scan.status === "invalid-config") return `${scan.repo}: invalid configuration \u2014 ${scan.configProblems?.join("; ")}`;
  const counts = { error: 0, warn: 0, info: 0 };
  for (const diagnostic of scan.result?.diagnostics ?? []) counts[diagnostic.severity] += 1;
  const parts = [`${scan.repo}@${scan.ref}: ${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} info`];
  if (scan.sarif) parts.push(`SARIF ${scan.sarif.status}`);
  if (scan.issues) parts.push(`issues: ${tally(scan.issues.actions)}${scan.issues.skipped.length ? `, ${scan.issues.skipped.length} skipped` : ""}`);
  if (scan.fixes) parts.push(`fix PRs: ${tally(scan.fixes.actions)}${scan.fixes.skipped.length ? `, ${scan.fixes.skipped.length} skipped` : ""}`);
  if (scan.inventoryComplete === false) parts.push(`inventory truncated (${scan.truncated?.length ?? 0} file(s))`);
  return parts.join(" \xB7 ");
}
function tally(actions) {
  if (actions.length === 0) return "no changes";
  const counts = /* @__PURE__ */ new Map();
  for (const action of actions) counts.set(action.type, (counts.get(action.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => `${count} ${type}`).join(", ");
}

// src/cli/scan.ts
var SCAN_HELP = `Usage: ci-cd-optimizer scan [options]

Scans a repository through the GitHub API exactly as the GitHub App does on push: lints the default branch with
its .github/ci-cd-optimizer.yml, optionally uploads SARIF to code scanning, and syncs finding issues and autofix
pull requests when the configuration enables them. Idempotent; schedule it to run without installing the App.

Options:
      --repo <owner/name>   Repository to scan (default: $GITHUB_REPOSITORY)
      --ref <ref>           Branch or commit (default: the default branch; issues and fix PRs only sync there)
      --upload-sarif        Upload findings to code scanning (needs security-events: write)
      --no-issues           Do not open, update, or close finding issues
      --no-fixes            Do not open or update autofix pull requests
      --dry-run             Plan everything, write nothing
      --fail-on <sev>       Exit 1 when findings reach: info | warn | error | never (default: never)
  -f, --format text|json    Output format (default: text)
  -o, --output <file>       Write the output to a file

Set COPILOT_ASSIGN_TOKEN (a Copilot-licensed user's token) to assign finding issues to the Copilot coding agent.
`;
var FAIL_ON = /* @__PURE__ */ new Set(["info", "warn", "error", "never"]);
function issueAction(action) {
  if (action.type === "close") return { type: action.type, number: action.number, fingerprint: action.fingerprint };
  return { type: action.type, ..."number" in action ? { number: action.number } : {}, fingerprint: action.desired.fingerprint, title: action.desired.title };
}
function fixAction(action) {
  if (action.type === "metadata") return action;
  if (action.type === "close") return { type: action.type, number: action.number, group: action.group };
  return { type: action.type, ..."number" in action ? { number: action.number } : {}, group: action.change.group, rules: action.change.rules };
}
function summary(scan) {
  return {
    repo: scan.repo,
    ref: scan.ref,
    ...scan.sha ? { sha: scan.sha } : {},
    status: scan.status,
    ...scan.configProblems ? { configProblems: scan.configProblems } : {},
    ...scan.result ? { diagnostics: scan.result.diagnostics } : {},
    ...scan.inventoryComplete !== void 0 ? { inventoryComplete: scan.inventoryComplete } : {},
    ...scan.sarif ? { sarif: scan.sarif } : {},
    ...scan.issues ? {
      issues: {
        actions: scan.issues.actions.map(issueAction),
        skipped: scan.issues.skipped.length,
        applied: scan.issues.applied.map((item) => ({ type: item.action.type, number: item.number, ...item.copilot ? { copilot: item.copilot } : {} }))
      }
    } : {},
    ...scan.fixes ? {
      fixes: {
        actions: scan.fixes.actions.map(fixAction),
        skipped: scan.fixes.skipped.length,
        applied: scan.fixes.applied.map((item) => ({ type: item.action.type, number: item.number }))
      }
    } : {}
  };
}
async function scanCommand(args, io) {
  const { values } = parseArgs4({
    args,
    strict: true,
    options: {
      repo: { type: "string" },
      ref: { type: "string" },
      "upload-sarif": { type: "boolean", default: false },
      "no-issues": { type: "boolean", default: false },
      "no-fixes": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "fail-on": { type: "string", default: "never" },
      format: { type: "string", short: "f", default: "text" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h", default: false }
    }
  });
  if (values.help) {
    io.stdout(SCAN_HELP);
    return 0;
  }
  if (values.format !== "text" && values.format !== "json") throw new UsageError(`Unknown format "${values.format}". Use text or json.`);
  if (!FAIL_ON.has(values["fail-on"])) throw new UsageError("--fail-on must be info, warn, error, or never.");
  const repo = repoFrom(values.repo, io);
  const copilot = copilotClient(io);
  const scan = await scanRepository(githubClient(io), repo, {
    dryRun: values["dry-run"],
    uploadSarif: values["upload-sarif"],
    issues: !values["no-issues"],
    fixes: !values["no-fixes"],
    ...values.ref ? { ref: values.ref } : {},
    ...copilot ? { copilotClient: copilot } : {}
  });
  await writeText(io, values.output, values.format === "json" ? JSON.stringify(summary(scan), null, 2) : describeScan(scan));
  if (scan.status === "invalid-config") return 2;
  return exceedsThreshold(scan.result?.diagnostics ?? [], values["fail-on"]) ? 1 : 0;
}

// src/cli/telemetry.ts
import { appendFile as appendFile2, mkdir as mkdir3 } from "node:fs/promises";
import { dirname as dirname3 } from "node:path";
import { parseArgs as parseArgs5 } from "node:util";

// src/alerts/anomaly.ts
function seriesFingerprint(series) {
  return `duration:${series.workflowId}/${series.jobKey ?? "*"}`;
}
function slowestPerKey(jobs) {
  const byKey = /* @__PURE__ */ new Map();
  for (const job of jobs) {
    if (job.conclusion !== "success") continue;
    const current = byKey.get(job.key);
    if (!current || job.durationMs > current.durationMs) byKey.set(job.key, job);
  }
  return [...byKey.values()];
}
function buildSeries(snapshots) {
  const ordered = [...snapshots].filter((snapshot) => snapshot.conclusion === "success").sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.runId - b.runId);
  const byKey = /* @__PURE__ */ new Map();
  const push = (key, base2, point) => {
    const series = byKey.get(key) ?? { ...base2, points: [] };
    series.points.push(point);
    byKey.set(key, series);
  };
  for (const snapshot of ordered) {
    const point = { runId: snapshot.runId, completedAt: snapshot.completedAt, headSha: snapshot.headSha };
    push(`${snapshot.workflowId}/*`, { workflowId: snapshot.workflowId, workflowName: snapshot.workflowName }, { ...point, durationMs: snapshot.durationMs });
    for (const job of slowestPerKey(snapshot.jobs)) {
      push(
        `${snapshot.workflowId}/${job.key}`,
        { workflowId: snapshot.workflowId, workflowName: snapshot.workflowName, jobKey: job.key, jobName: job.name },
        { ...point, durationMs: job.durationMs }
      );
    }
  }
  return [...byKey.values()];
}
function magnitude(observed, baseline, settings) {
  const increaseMs = observed - baseline;
  const increasePercent = baseline > 0 ? increaseMs / baseline * 100 : Number.POSITIVE_INFINITY;
  const material = increaseMs >= settings.minIncreaseSeconds * 1e3 && increasePercent >= settings.minIncreasePercent;
  return { increaseMs, increasePercent, material };
}
function base(series, kind) {
  return {
    kind,
    fingerprint: seriesFingerprint(series),
    workflowId: series.workflowId,
    workflowName: series.workflowName,
    ...series.jobKey !== void 0 ? { jobKey: series.jobKey } : {},
    ...series.jobName !== void 0 ? { jobName: series.jobName } : {}
  };
}
function madFloor(center) {
  return Math.max(center * 0.02, 1e3);
}
function detectSpike(series, settings) {
  const latest = series.points.at(-1);
  const history = series.points.slice(0, -1).slice(-settings.window).map((point) => point.durationMs);
  if (!latest || history.length < settings.minSamples) return void 0;
  const center = median(history);
  const deviation = mad(history, center);
  const z = robustZ(latest.durationMs, center, deviation, madFloor(center));
  const { increaseMs, increasePercent, material } = magnitude(latest.durationMs, center, settings);
  if (z <= settings.zThreshold || !material) return void 0;
  return {
    ...base(series, "spike"),
    // Severity follows magnitude: with the MAD floor, any material increase on a stable series has a large z.
    severity: increasePercent >= 100 ? "critical" : "warning",
    runId: latest.runId,
    observedMs: latest.durationMs,
    baselineMedianMs: center,
    baselineMadMs: deviation,
    increaseMs,
    increasePercent,
    zScore: z,
    baselineSamples: history.length,
    recentRunIds: [latest.runId]
  };
}
function detectRegression(series, settings) {
  const recent = series.points.slice(-settings.regressionWindow);
  const reference = series.points.slice(0, -settings.regressionWindow).slice(-settings.window);
  if (recent.length < settings.regressionWindow || reference.length < settings.minSamples) return void 0;
  const recentValues = recent.map((point) => point.durationMs);
  const referenceValues = reference.map((point) => point.durationMs);
  const center = median(referenceValues);
  const observed = median(recentValues);
  const { increaseMs, increasePercent, material } = magnitude(observed, center, settings);
  if (!material) return void 0;
  const test = mannWhitneyGreater(recentValues, referenceValues);
  if (test.pValue >= settings.pValue) return void 0;
  const latest = recent.at(-1);
  return {
    ...base(series, "regression"),
    severity: increasePercent >= 50 ? "critical" : "warning",
    runId: latest.runId,
    observedMs: observed,
    baselineMedianMs: center,
    baselineMadMs: mad(referenceValues, center),
    increaseMs,
    increasePercent,
    pValue: test.pValue,
    baselineSamples: referenceValues.length,
    recentRunIds: recent.map((point) => point.runId)
  };
}
function detectAnomalies(series, settings) {
  const alerts = [];
  for (const entry of series) {
    const alert = detectRegression(entry, settings) ?? detectSpike(entry, settings);
    if (alert) alerts.push(alert);
  }
  return alerts.sort((a, b) => b.increasePercent - a.increasePercent);
}
function hasRecovered(series, baselineMedianMs, settings) {
  const recent = series.points.slice(-settings.recoveryRuns);
  if (recent.length < settings.recoveryRuns) return false;
  return recent.every((point) => !magnitude(point.durationMs, baselineMedianMs, settings).material);
}

// src/alerts/render.ts
function formatDuration(ms) {
  const totalSeconds = Math.round(Math.abs(ms) / 1e3);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds2 = totalSeconds % 60;
  const sign = ms < 0 ? "-" : "";
  if (hours > 0) return `${sign}${hours}h ${minutes}m`;
  if (minutes > 0) return `${sign}${minutes}m ${seconds2}s`;
  return `${sign}${seconds2}s`;
}
function seriesKey(alert) {
  return alert.jobKey ?? "*";
}
function scope(alert) {
  return alert.jobKey === void 0 ? "Workflow total" : `Job \`${alert.jobName ?? alert.jobKey}\``;
}
function runUrl(context, runId) {
  return `https://github.com/${context.owner}/${context.repo}/actions/runs/${runId}`;
}
function evidence(alert) {
  if (alert.kind === "regression") {
    return `Mann-Whitney U p=${(alert.pValue ?? 1).toPrecision(2)} (${alert.recentRunIds.length} recent vs ${alert.baselineSamples} baseline runs)`;
  }
  return `robust z=${(alert.zScore ?? 0).toFixed(1)} vs ${alert.baselineSamples} runs (MAD ${formatDuration(alert.baselineMadMs)})`;
}
function primaryAlert(alerts) {
  return [...alerts].sort((a, b) => Number(a.jobKey !== void 0) - Number(b.jobKey !== void 0) || b.increasePercent - a.increasePercent)[0];
}
function chart(series, baselineMs, title) {
  const points = series.points.slice(-30);
  if (points.length < 2) return [];
  const minutes = (ms) => Number((ms / 6e4).toFixed(2));
  const values = points.map((point) => minutes(point.durationMs));
  const max = Math.max(...values, minutes(baselineMs));
  return [
    "```mermaid",
    "xychart-beta",
    `  title "${title.replace(/"/g, "'")}"`,
    `  x-axis "Runs (oldest to newest)" 1 --> ${points.length}`,
    `  y-axis "Minutes" 0 --> ${Math.max(1, Math.ceil(max * 1.15))}`,
    `  line [${values.join(", ")}]`,
    `  line [${points.map(() => minutes(baselineMs)).join(", ")}]`,
    "```",
    "",
    "_Lower line: baseline median. Only successful runs are plotted._"
  ];
}
function suspectRange(alert, series) {
  if (!series) return {};
  const firstSlowRun = alert.kind === "regression" ? alert.recentRunIds[0] : alert.runId;
  const index = series.points.findIndex((point) => point.runId === firstSlowRun);
  if (index < 0) return {};
  return {
    ...index > 0 ? { good: series.points[index - 1] } : {},
    bad: series.points[index]
  };
}
function renderAlertIssue(workflowName, alerts, context) {
  const primary = primaryAlert(alerts);
  const critical = alerts.some((alert) => alert.severity === "critical");
  const what = primary.jobKey === void 0 ? `"${workflowName}"` : `job "${primary.jobName ?? primary.jobKey}" in "${workflowName}"`;
  const title = `CI slowdown: ${what} is ${Math.round(primary.increasePercent)}% slower (${primary.kind})`;
  const primarySeries = context.series.get(seriesFingerprint(primary));
  const baselineOf = (alert) => context.baselines?.[seriesKey(alert)] ?? alert.baselineMedianMs;
  const lines = [
    `## CI duration ${primary.kind} in \`${workflowName}\``,
    "",
    `**Severity:** ${critical ? "critical" : "warning"} \xB7 **Latest run:** [#${primary.runId}](${runUrl(context, primary.runId)})${context.branch ? ` \xB7 **Branch:** \`${context.branch}\`` : ""}`,
    "",
    primary.kind === "regression" ? "Recent runs are **consistently** slower than the baseline (a step change), not just a single noisy run." : "The latest run took **significantly** longer than the recent baseline.",
    "",
    "| Scope | Kind | Baseline (median) | Observed | Change | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...[...alerts].sort((a, b) => b.increasePercent - a.increasePercent).map(
      (alert) => `| ${scope(alert)} | ${alert.kind} | ${formatDuration(baselineOf(alert))} | ${formatDuration(alert.observedMs)} | +${Math.round(alert.increasePercent)}% (+${formatDuration(alert.increaseMs)}) | ${evidence(alert)} |`
    ),
    ""
  ];
  if (primarySeries) {
    lines.push("### Duration history", "", ...chart(primarySeries, baselineOf(primary), `${primary.jobName ?? workflowName} duration`), "");
  }
  const { good, bad } = suspectRange(primary, primarySeries);
  lines.push("### Where to look", "");
  if (good?.headSha && bad?.headSha && good.headSha !== bad.headSha) {
    lines.push(
      `- **Suspect commits:** [\`${good.headSha.slice(0, 7)}...${bad.headSha.slice(0, 7)}\`](https://github.com/${context.owner}/${context.repo}/compare/${good.headSha}...${bad.headSha}) (between the last normal run and the first slow run).`
    );
  }
  if (good) lines.push(`- Last normal run: [#${good.runId}](${runUrl(context, good.runId)}) (${formatDuration(good.durationMs)})`);
  if (bad) lines.push(`- First slow run: [#${bad.runId}](${runUrl(context, bad.runId)}) (${formatDuration(bad.durationMs)})`);
  lines.push(
    "- Common causes: cache misses or evicted caches (check `cache-hit` outputs and the 10 GB cache quota), changed lockfiles that bust dependency/Docker layer caches, new or slower tests, runner image updates (`*-latest` labels), larger checkouts, and queueing on self-hosted runners.",
    "",
    "### Instructions for coding agents",
    "",
    "1. Compare per-step timings of the first slow run with the last normal run (`gh run view <run-id> --json jobs`) and identify the steps whose duration grew.",
    "2. Inspect the suspect commits for changes to workflows, lockfiles, Dockerfiles, test suites, or build configuration that explain the growth.",
    "3. Propose the smallest change that restores the previous duration (for example restore cache keys, add a missing cache, split or shard the slow job). Report before/after timings in the pull request.",
    "4. If the slowdown is expected and accepted (for example, new tests were added intentionally), explain why in a comment instead of changing code.",
    ""
  );
  if (context.previousIssue) lines.push(`_This workflow previously regressed in #${context.previousIssue}._`, "");
  lines.push(
    `<sub>Opened by CI/CD Optimizer from Actions run telemetry. It closes automatically after ${context.recoveryRuns} consecutive runs are back within the baseline. Close as **not planned** to snooze alerts for this workflow for ${context.snoozeDays} days.</sub>`
  );
  return { title, body: lines.join("\n") };
}

// src/alerts/sync.ts
function alertIssueFingerprint(workflowId) {
  return `duration:${workflowId}`;
}
function readBaselines(issue) {
  if (!issue?.attributes.baselines) return {};
  try {
    const parsed = JSON.parse(issue.attributes.baselines);
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}
function shapeOf(alerts) {
  return alerts.map((alert) => `${seriesKey(alert)}:${alert.kind}:${alert.severity}`).sort().join(",");
}
function planAlertSync(input2) {
  const fingerprint2 = alertIssueFingerprint(input2.workflowId);
  const seriesMap = new Map(input2.series.map((series) => [seriesFingerprint(series), series]));
  const alerts = detectAnomalies(input2.series, input2.config);
  const history = input2.existing.filter((issue) => issue.fingerprint === fingerprint2).sort((a, b) => b.number - a.number);
  const open = history.find((issue) => issue.state === "open");
  const latestClosed = history.find((issue) => issue.state === "closed");
  const actions = [];
  const plan = { actions, skipped: [], alerts };
  if (alerts.length === 0) {
    if (!open) return plan;
    const baselines2 = readBaselines(open);
    const keys = Object.keys(baselines2);
    const recovered = keys.length > 0 && keys.every((key) => {
      const series = seriesMap.get(seriesFingerprint({ workflowId: input2.workflowId, ...key === "*" ? {} : { jobKey: key } }));
      return !series || hasRecovered(series, baselines2[key], input2.config);
    });
    if (recovered) {
      actions.push({
        type: "close",
        number: open.number,
        fingerprint: fingerprint2,
        comment: `Durations are back within the baseline for the last ${input2.config.recoveryRuns} runs (${keys.map((key) => `${key === "*" ? "workflow" : `\`${key}\``} \u2264 ${formatDuration(baselines2[key])} + tolerance`).join(", ")}). Closing this alert. :tada:`
      });
    }
    return plan;
  }
  if (!open && latestClosed?.stateReason === "not_planned" && latestClosed.closedAt) {
    const snoozedUntil = Date.parse(latestClosed.closedAt) + input2.config.snoozeDays * 864e5;
    if (input2.now.getTime() < snoozedUntil) {
      plan.skipped.push({ fingerprint: fingerprint2, reason: "dismissed", number: latestClosed.number });
      return plan;
    }
  }
  const baselines = readBaselines(open);
  for (const alert of alerts) baselines[seriesKey(alert)] ??= Math.round(alert.baselineMedianMs);
  const shape = shapeOf(alerts);
  const latestRun = Math.max(...alerts.map((alert) => alert.runId));
  const rendered = renderAlertIssue(input2.workflowName, alerts, {
    owner: input2.owner,
    repo: input2.repo,
    ...input2.branch !== void 0 ? { branch: input2.branch } : {},
    series: seriesMap,
    recoveryRuns: input2.config.recoveryRuns,
    snoozeDays: input2.config.snoozeDays,
    baselines,
    ...!open && latestClosed ? { previousIssue: latestClosed.number } : {}
  });
  const signature = signatureOf([shape, String(latestRun)]);
  const critical = alerts.some((alert) => alert.severity === "critical");
  const desired = {
    fingerprint: fingerprint2,
    signature,
    title: rendered.title,
    body: `${marker("alert", fingerprint2, { signature, shape, workflow: String(input2.workflowId), baselines: JSON.stringify(baselines) })}
${rendered.body}`,
    labels: [.../* @__PURE__ */ new Set(["cicd-optimizer", "alert:duration", critical ? "severity:error" : "severity:warn", ...input2.config.labels])],
    assignees: input2.config.assignees,
    assignCopilot: input2.config.assignCopilot,
    priority: critical ? 2 : 1
  };
  if (!open) {
    actions.push({ type: "create", desired });
    return plan;
  }
  if (open.signature === signature) return plan;
  const changed = open.attributes.shape !== shape;
  actions.push({
    type: "update",
    number: open.number,
    desired,
    ...changed ? {
      comment: `The anomaly changed on run [#${latestRun}](https://github.com/${input2.owner}/${input2.repo}/actions/runs/${latestRun}): ${alerts.map((alert) => `${alert.jobKey === void 0 ? "workflow" : `\`${alert.jobName ?? alert.jobKey}\``} ${alert.kind} +${Math.round(alert.increasePercent)}% (${alert.severity})`).join("; ")}.`
    } : {}
  });
  return plan;
}

// src/telemetry/baseline.ts
function computeBaseline(history, snapshot, limit = 20) {
  const runs = history.filter(
    (item) => item.runId !== snapshot.runId && item.owner === snapshot.owner && item.repo === snapshot.repo && item.workflowId === snapshot.workflowId && item.branch === snapshot.branch && item.conclusion === "success"
  ).sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.runId - b.runId).slice(-limit);
  if (runs.length === 0) return void 0;
  const jobDurations = /* @__PURE__ */ new Map();
  for (const run3 of runs) {
    for (const job of slowestPerKey(run3.jobs)) {
      jobDurations.set(job.key, [...jobDurations.get(job.key) ?? [], job.durationMs]);
    }
  }
  return {
    sampleCount: runs.length,
    medianDurationMs: median(runs.map((item) => item.durationMs)),
    medianQueueMs: median(runs.map((item) => item.queueMs)),
    jobs: Object.fromEntries([...jobDurations].map(([key, values]) => [key, median(values)]))
  };
}

// src/telemetry/report.ts
var QUEUE_THRESHOLD_MS = 5e3;
function createTelemetryReport(snapshot, baseline) {
  const criticalPath = calculateCriticalPath(snapshot.jobs);
  const slowest = [...snapshot.jobs].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  const comparison = baseline ? compare2(snapshot.durationMs, baseline.medianDurationMs, baseline.sampleCount) : "No historical baseline exists yet; this run establishes the first snapshot.";
  return [
    `## ${snapshot.workflowName} performance snapshot`,
    "",
    `**Run:** ${formatDuration2(snapshot.durationMs)} \xB7 **Queue:** ${formatDuration2(snapshot.queueMs)} \xB7 **Jobs:** ${snapshot.jobs.length}`,
    "",
    comparison,
    "",
    `**Estimated critical path:** ${formatDuration2(criticalPath.durationMs)} \u2014 ${criticalPath.jobKeys.join(" \u2192 ") || "unavailable"}`,
    "",
    "### Timeline",
    "",
    createGantt(snapshot, criticalPath.jobKeys),
    "",
    "### Job dependencies",
    "",
    createDependencyGraph(snapshot.jobs, criticalPath.jobKeys),
    "",
    "### Longest jobs",
    "",
    "| Job | Duration | Share of run |",
    "|---|---:|---:|",
    ...slowest.map(
      (job) => `| ${escapeCell(job.name)} | ${formatDuration2(job.durationMs)} | ${percentage(job.durationMs, snapshot.durationMs)} |`
    ),
    "",
    ...slowestSteps(snapshot),
    ...jobRegressions(snapshot, baseline),
    ...recommendations(snapshot, criticalPath, baseline)
  ].join("\n");
}
function calculateCriticalPath(jobs) {
  const byKey = new Map(jobs.map((job) => [job.key, job]));
  const memo = /* @__PURE__ */ new Map();
  const visiting = /* @__PURE__ */ new Set();
  function visit2(key) {
    const cached = memo.get(key);
    if (cached) return cached;
    const job = byKey.get(key);
    if (!job || visiting.has(key)) return { durationMs: 0, jobKeys: [] };
    visiting.add(key);
    const parentPaths = job.needs.map(visit2);
    const longestParent = parentPaths.reduce(
      (longest, candidate) => candidate.durationMs > longest.durationMs ? candidate : longest,
      { durationMs: 0, jobKeys: [] }
    );
    visiting.delete(key);
    const result = {
      durationMs: longestParent.durationMs + job.durationMs,
      jobKeys: [...longestParent.jobKeys, key]
    };
    memo.set(key, result);
    return result;
  }
  return jobs.reduce(
    (longest, job) => {
      const candidate = visit2(job.key);
      return candidate.durationMs > longest.durationMs ? candidate : longest;
    },
    { durationMs: 0, jobKeys: [] }
  );
}
function createGantt(snapshot, criticalKeys) {
  const critical = new Set(criticalKeys);
  const jobs = [...snapshot.jobs].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)
  );
  const waits = jobs.filter((job) => job.queuedAt && (job.queueMs ?? 0) >= QUEUE_THRESHOLD_MS);
  const tags = (job) => [critical.has(job.key) ? "crit" : "", job.conclusion === "success" ? "done" : job.conclusion === "failure" ? "active" : ""].filter(Boolean).map((tag) => `${tag}, `).join("");
  return [
    "```mermaid",
    "gantt",
    `    title ${sanitizeMermaid(snapshot.workflowName)} run ${snapshot.runId}`,
    "    dateFormat  YYYY-MM-DDTHH:mm:ss",
    "    axisFormat  %H:%M:%S",
    ...waits.length > 0 ? [
      "    section Runner queue",
      ...waits.map(
        (job, index) => `    ${sanitizeMermaid(job.name)} wait :q${index}, ${withoutMillis(job.queuedAt)}, ${withoutMillis(job.startedAt)}`
      )
    ] : [],
    "    section Jobs",
    ...jobs.map(
      (job, index) => `    ${sanitizeMermaid(job.name)} :${tags(job)}j${index}, ${withoutMillis(job.startedAt)}, ${withoutMillis(job.completedAt)}`
    ),
    "```",
    "",
    "_Red bars are on the critical path; the runner queue lane shows time jobs spent waiting for a runner._"
  ].join("\n");
}
function slowestSteps(snapshot, limit = 10) {
  const steps2 = snapshot.jobs.flatMap((job) => (job.steps ?? []).map((step) => ({ job, step }))).sort((a, b) => b.step.durationMs - a.step.durationMs).slice(0, limit);
  if (steps2.length === 0) return [];
  return [
    "### Slowest steps",
    "",
    "| Job | Step | Duration | Share of job |",
    "|---|---|---:|---:|",
    ...steps2.map(
      ({ job, step }) => `| ${escapeCell(job.name)} | ${escapeCell(step.name)} | ${formatDuration2(step.durationMs)} | ${percentage(step.durationMs, job.durationMs)} |`
    ),
    ""
  ];
}
function jobRegressions(snapshot, baseline) {
  if (!baseline?.jobs) return [];
  const rows = snapshot.jobs.map((job) => ({ job, median: baseline.jobs?.[job.key] })).filter(
    (row) => row.median !== void 0 && row.job.durationMs - row.median >= 3e4 && row.job.durationMs > row.median * 1.25
  ).sort((a, b) => b.job.durationMs - b.median - (a.job.durationMs - a.median));
  if (rows.length === 0) return [];
  return [
    "### Jobs slower than baseline",
    "",
    "| Job | This run | Median | Delta |",
    "|---|---:|---:|---:|",
    ...rows.map(
      ({ job, median: median2 }) => `| ${escapeCell(job.name)} | ${formatDuration2(job.durationMs)} | ${formatDuration2(median2)} | +${formatDuration2(job.durationMs - median2)} |`
    ),
    ""
  ];
}
function createDependencyGraph(jobs, criticalKeys) {
  const identifiers = new Map(jobs.map((job, index) => [job.key, `J${index}`]));
  const critical = new Set(criticalKeys);
  const nodes = jobs.map(
    (job) => `    ${identifiers.get(job.key)}["${sanitizeMermaid(job.name)}<br/>${formatDuration2(job.durationMs)}"]`
  );
  const edges = jobs.flatMap(
    (job) => job.needs.filter((dependency) => identifiers.has(dependency)).map(
      (dependency) => `    ${identifiers.get(dependency)} --> ${identifiers.get(job.key)}`
    )
  );
  const styles = jobs.filter((job) => critical.has(job.key)).map((job) => `    style ${identifiers.get(job.key)} stroke:#d1242f,stroke-width:3px`);
  return ["```mermaid", "flowchart LR", ...nodes, ...edges, ...styles, "```"].join("\n");
}
function recommendations(snapshot, criticalPath, baseline) {
  const messages = ["### Observations", ""];
  const longest = [...snapshot.jobs].sort((a, b) => b.durationMs - a.durationMs)[0];
  if (longest && longest.durationMs > snapshot.durationMs * 0.5) {
    messages.push(
      `- **${longest.name} dominates the run** at ${percentage(longest.durationMs, snapshot.durationMs)}. Profile its internal steps, then consider test sharding, incremental builds, or a larger runner.`
    );
  }
  const waits = snapshot.jobs.filter((job) => (job.queueMs ?? 0) >= 6e4);
  if (waits.length > 0) {
    const worst = waits.reduce((a, b) => (a.queueMs ?? 0) >= (b.queueMs ?? 0) ? a : b);
    messages.push(
      `- **${waits.length} job(s) waited over a minute for a runner** (worst: ${worst.name}, ${formatDuration2(worst.queueMs ?? 0)}${worst.labels ? ` on \`${worst.labels.join(", ")}\`` : ""}). Check runner pool capacity or move short jobs to a less contended label.`
    );
  }
  if (snapshot.queueMs > 6e4) {
    messages.push(
      `- **Runner queueing added ${formatDuration2(snapshot.queueMs)}.** Review runner concurrency, autoscaling latency, labels, and peak utilization.`
    );
  }
  if (criticalPath.durationMs > 0 && criticalPath.durationMs < snapshot.durationMs * 0.7) {
    messages.push(
      "- **The dependency graph leaves material orchestration overhead.** Inspect setup/teardown gaps and jobs not represented by explicit `needs` relationships."
    );
  }
  if (baseline && snapshot.durationMs > baseline.medianDurationMs * 1.2) {
    messages.push(
      `- **This run regressed by more than 20%** versus the ${baseline.sampleCount}-run median. Compare changed build inputs, cache hits, and runner type.`
    );
  }
  if (messages.length === 2) {
    messages.push(
      "- No strong timing anomaly was detected. Accumulate more snapshots to improve trend confidence."
    );
  }
  return messages;
}
function compare2(current, median2, samples) {
  if (median2 === 0) return `Compared with ${samples} prior successful runs.`;
  const delta = (current - median2) / median2 * 100;
  const direction = delta > 0 ? "slower" : "faster";
  return `Compared with the median of ${samples} prior successful runs, this run is **${Math.abs(delta).toFixed(1)}% ${direction}** (${formatDuration2(median2)} baseline).`;
}
function percentage(part, whole) {
  return whole > 0 ? `${(part / whole * 100).toFixed(0)}%` : "0%";
}
function formatDuration2(milliseconds) {
  const seconds2 = Math.round(milliseconds / 1e3);
  const minutes = Math.floor(seconds2 / 60);
  const remainder = seconds2 % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
function withoutMillis(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "");
}
function sanitizeMermaid(value) {
  return value.replace(/["`:;#]/g, "").replace(/\r?\n/g, " ").slice(0, 120);
}
function escapeCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// src/telemetry/snapshot.ts
var import_yaml23 = __toESM(require_dist(), 1);
function workflowPath(path) {
  return path.replace(/@.*$/, "");
}
function parseJobDefinitions(text) {
  let document;
  try {
    document = (0, import_yaml23.parse)(text);
  } catch {
    return /* @__PURE__ */ new Map();
  }
  if (!isRecord3(document) || !isRecord3(document.jobs)) return /* @__PURE__ */ new Map();
  const definitions = /* @__PURE__ */ new Map();
  for (const [key, value] of Object.entries(document.jobs)) {
    if (!isRecord3(value)) continue;
    definitions.set(key, { ...typeof value.name === "string" ? { name: value.name } : {}, needs: parseNeeds(value.needs) });
  }
  return definitions;
}
async function loadJobDefinitions(client, repo, path, ref) {
  try {
    const text = await readFileAt(client, repo, workflowPath(path), ref);
    return text === void 0 ? /* @__PURE__ */ new Map() : parseJobDefinitions(text);
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
async function listRunJobs(client, repo, runId, maxPages = 5) {
  const jobs = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
      ...repo,
      run_id: runId,
      filter: "latest",
      per_page: 100,
      page
    });
    const batch = response.data.jobs ?? [];
    jobs.push(...batch);
    if (batch.length < 100) break;
  }
  return jobs;
}
async function buildWorkflowSnapshot(client, repo, run3, options = {}) {
  const [jobs, definitions] = await Promise.all([
    listRunJobs(client, repo, run3.id),
    options.definitions ? Promise.resolve(options.definitions) : loadJobDefinitions(client, repo, run3.path, run3.head_sha)
  ]);
  return snapshotFromRun(repo, run3, jobs, definitions);
}
function snapshotFromRun(repo, run3, apiJobs, definitions) {
  const jobs = apiJobs.filter((job) => job.started_at && job.completed_at).map((job) => jobSnapshot(job, definitions));
  const startedAt = run3.run_started_at ?? run3.created_at;
  const lastJob = jobs.map((job) => job.completedAt).sort().at(-1);
  const completedAt = lastJob && Date.parse(lastJob) > Date.parse(startedAt) ? lastJob : run3.updated_at;
  return {
    owner: repo.owner,
    repo: repo.repo,
    workflowId: run3.workflow_id,
    workflowName: run3.name ?? workflowPath(run3.path),
    path: workflowPath(run3.path),
    runId: run3.id,
    runAttempt: run3.run_attempt ?? 1,
    headSha: run3.head_sha,
    branch: run3.head_branch,
    event: run3.event,
    conclusion: run3.conclusion,
    createdAt: run3.created_at,
    startedAt,
    completedAt,
    queueMs: elapsed(run3.created_at, startedAt),
    durationMs: elapsed(startedAt, completedAt),
    ...run3.html_url ? { htmlUrl: run3.html_url } : {},
    jobs
  };
}
function jobSnapshot(job, definitions) {
  const key = matchJobKey(job.name, definitions);
  const startedAt = job.started_at;
  const completedAt = job.completed_at;
  const steps2 = (job.steps ?? []).filter((step) => step.started_at && step.completed_at).map(
    (step) => ({
      number: step.number,
      name: step.name,
      conclusion: step.conclusion,
      startedAt: step.started_at,
      completedAt: step.completed_at,
      durationMs: elapsed(step.started_at, step.completed_at)
    })
  );
  return {
    id: job.id,
    key: key ?? job.name,
    name: job.name,
    conclusion: job.conclusion,
    startedAt,
    completedAt,
    durationMs: elapsed(startedAt, completedAt),
    needs: key ? definitions.get(key)?.needs ?? [] : [],
    ...job.created_at ? { queuedAt: job.created_at, queueMs: elapsed(job.created_at, startedAt) } : {},
    ...job.runner_name ? { runnerName: job.runner_name } : {},
    ...job.labels && job.labels.length > 0 ? { labels: job.labels } : {},
    ...steps2.length > 0 ? { steps: steps2 } : {}
  };
}
function matchJobKey(jobName, definitions) {
  for (const [key, definition] of definitions) {
    for (const candidate of [key, definition.name]) {
      if (!candidate) continue;
      if (jobName === candidate || jobName.startsWith(`${candidate} (`) || jobName.startsWith(`${candidate} / `)) return key;
      if (candidate.includes("${{") && templatePattern(candidate).test(jobName)) return key;
    }
  }
  return void 0;
}
function templatePattern(template) {
  const source = template.split(/\$\{\{[^}]*\}\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}(?: \\(.*\\)| / .*)?$`);
}
async function loadRunHistory(client, repo, options) {
  const response = await client.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
    ...repo,
    workflow_id: options.workflowId,
    status: "completed",
    per_page: Math.min(100, options.limit + 1),
    ...options.branch ? { branch: options.branch } : {}
  });
  const runs = (response.data.workflow_runs ?? []).filter((run3) => run3.id !== options.excludeRunId).slice(0, options.limit);
  const snapshots = await mapLimit(
    runs,
    options.concurrency ?? 4,
    async (run3) => snapshotFromRun(repo, run3, await listRunJobs(client, repo, run3.id, 1), options.definitions)
  );
  return snapshots.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.runId - b.runId);
}
function parseNeeds(value) {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function elapsed(start, end) {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/service/checks.ts
var TELEMETRY_CHECK_PREFIX = "CI/CD Telemetry";
var MAX_OUTPUT_LENGTH = 65535;
var ANNOTATIONS_PER_REQUEST = 50;
var MAX_ANNOTATIONS = 500;
function truncate(text, max = MAX_OUTPUT_LENGTH) {
  if (text.length <= max) return text;
  const note = "\n\n_\u2026truncated._";
  return `${text.slice(0, max - note.length)}${note}`;
}
function output(value, annotations) {
  return {
    title: truncate(value.title, 255),
    summary: truncate(value.summary),
    ...value.text ? { text: truncate(value.text) } : {},
    ...annotations.length > 0 ? { annotations } : {}
  };
}
async function publishCheck(client, repo, options) {
  const annotations = (options.annotations ?? []).slice(0, MAX_ANNOTATIONS);
  const batches = chunk(annotations, ANNOTATIONS_PER_REQUEST);
  const response = await client.request("POST /repos/{owner}/{repo}/check-runs", {
    ...repo,
    name: options.name,
    head_sha: options.headSha,
    status: "completed",
    conclusion: options.conclusion,
    completed_at: (/* @__PURE__ */ new Date()).toISOString(),
    ...options.detailsUrl ? { details_url: options.detailsUrl } : {},
    output: output(options, batches[0] ?? [])
  });
  const id = response.data.id;
  for (const batch of batches.slice(1)) {
    await client.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", { ...repo, check_run_id: id, output: output(options, batch) });
  }
  return id;
}
function chunk(items2, size) {
  const batches = [];
  for (let index = 0; index < items2.length; index += size) batches.push(items2.slice(index, index + size));
  return batches;
}

// src/service/workflow-run.ts
var PULL_REQUEST_EVENTS = /* @__PURE__ */ new Set(["pull_request", "pull_request_target"]);
function alertsApply(run3, branches, defaultBranchName) {
  if (PULL_REQUEST_EVENTS.has(run3.event) || !run3.head_branch) return false;
  const patterns = branches.length > 0 ? branches : [defaultBranchName];
  return patterns.some((pattern) => matchesGlob(run3.head_branch, pattern));
}
function historyLimit(config) {
  return Math.max(config.alerts.window + config.alerts.regressionWindow, 20);
}
async function processWorkflowRun(client, repo, run3, options = {}) {
  if (run3.status && run3.status !== "completed") return { status: "skipped", reason: `Run is ${run3.status}.` };
  const branch = await defaultBranch(client, repo);
  const remote = await loadRemoteConfig(client, repo, branch);
  const config = remote.config;
  if (!config.enabled) return { status: "disabled" };
  const definitions = await loadJobDefinitions(client, repo, run3.path, run3.head_sha);
  const snapshot = await buildWorkflowSnapshot(client, repo, run3, { definitions });
  if (snapshot.jobs.length === 0) return { status: "skipped", reason: "The run has no completed jobs.", snapshot };
  const history = await loadHistory(client, repo, run3, snapshot, definitions, { limit: historyLimit(config), minSamples: config.alerts.minSamples }, options);
  const prior = history.filter((item) => item.runId !== snapshot.runId);
  const baseline = computeBaseline(prior, snapshot);
  const report = createTelemetryReport(snapshot, baseline);
  const result = { status: "processed", snapshot, samples: prior.length, report, ...baseline ? { baseline } : {} };
  if (options.alerts !== false && config.alerts.enabled && remote.problems.length === 0 && alertsApply(run3, config.alerts.branches, branch)) {
    const series = buildSeries([...prior, snapshot]);
    const existing = await listManagedIssues(client, repo, "alert");
    const plan = planAlertSync({
      owner: repo.owner,
      repo: repo.repo,
      branch: run3.head_branch,
      workflowId: snapshot.workflowId,
      workflowName: snapshot.workflowName,
      series,
      existing,
      config: config.alerts,
      now: options.now ?? /* @__PURE__ */ new Date()
    });
    const applied = options.dryRun ? [] : await applyIssueActions(client, repo, plan.actions, { ...options.copilotClient ? { copilotClient: options.copilotClient } : {}, copilot: config.issues.copilot });
    result.alerts = { detected: plan.alerts, actions: plan.actions, skipped: plan.skipped, applied };
  }
  if (options.check !== false && !options.dryRun) {
    result.checkRunId = await publishCheck(client, repo, {
      name: `${TELEMETRY_CHECK_PREFIX} (${snapshot.workflowName})`,
      headSha: snapshot.headSha,
      conclusion: "neutral",
      title: headline(snapshot, baseline),
      summary: report,
      ...snapshot.htmlUrl ? { detailsUrl: snapshot.htmlUrl } : {}
    });
  }
  return result;
}
async function loadHistory(client, repo, run3, snapshot, definitions, { limit, minSamples }, options) {
  const query = { owner: repo.owner, repo: repo.repo, workflowId: snapshot.workflowId, branch: snapshot.branch, limit: limit + 1 };
  const backfill = () => loadRunHistory(client, repo, { workflowId: snapshot.workflowId, branch: snapshot.branch, limit, definitions, excludeRunId: run3.id });
  const store = options.store;
  if (!store) return merge2(await backfill(), [snapshot], limit + 1);
  if (!options.dryRun) await store.save(snapshot);
  let history = await store.history(query);
  if (history.filter((item) => item.runId !== snapshot.runId).length < minSamples) {
    const fetched = await backfill();
    const known2 = new Set(history.map((item) => item.runId));
    if (!options.dryRun) {
      for (const item of fetched) if (!known2.has(item.runId)) await store.save(item);
    }
    history = merge2(history, fetched, limit + 1);
  }
  return merge2(history, [snapshot], limit + 1);
}
function merge2(left, right, limit) {
  const byRun = /* @__PURE__ */ new Map();
  for (const item of [...left, ...right]) byRun.set(item.runId, item);
  return [...byRun.values()].sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.runId - b.runId).slice(-limit);
}
function headline(snapshot, baseline) {
  const minutes = (snapshot.durationMs / 6e4).toFixed(1);
  if (!baseline || baseline.medianDurationMs === 0) return `${minutes} min (no baseline yet)`;
  const delta = (snapshot.durationMs - baseline.medianDurationMs) / baseline.medianDurationMs * 100;
  return `${minutes} min (${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% vs ${baseline.sampleCount}-run median)`;
}

// src/telemetry/store.ts
import { mkdir as mkdir2, readFile as readFile6, rename, writeFile as writeFile3 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
var byCompletion = (a, b) => a.completedAt.localeCompare(b.completedAt) || a.runId - b.runId;
function selectHistory(snapshots, query) {
  return snapshots.filter(
    (item) => item.owner === query.owner && item.repo === query.repo && item.workflowId === query.workflowId && (query.branch === void 0 || item.branch === query.branch)
  ).sort(byCompletion).slice(-query.limit);
}
var FileTelemetryStore = class {
  constructor(path, retain = 200) {
    this.path = path;
    this.retain = retain;
  }
  path;
  retain;
  snapshots;
  async initialize() {
    await this.load();
  }
  async save(snapshot) {
    const all = (await this.load()).filter((item) => item.runId !== snapshot.runId);
    all.push(snapshot);
    const groups = /* @__PURE__ */ new Map();
    for (const item of all) {
      const key = `${item.owner}/${item.repo}#${item.workflowId}@${item.branch ?? ""}`;
      groups.set(key, [...groups.get(key) ?? [], item]);
    }
    this.snapshots = [...groups.values()].flatMap((items2) => items2.sort(byCompletion).slice(-this.retain)).sort(byCompletion);
    await mkdir2(dirname2(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile3(temporary, this.snapshots.map((item) => `${JSON.stringify(item)}
`).join(""), "utf8");
    await rename(temporary, this.path);
  }
  async history(query) {
    return selectHistory(await this.load(), query);
  }
  async load() {
    if (this.snapshots) return this.snapshots;
    const text = await readFile6(this.path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    this.snapshots = text.split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const parsed = JSON.parse(line);
        return typeof parsed.runId === "number" && typeof parsed.completedAt === "string" ? [parsed] : [];
      } catch {
        return [];
      }
    });
    return this.snapshots;
  }
};

// src/cli/telemetry.ts
var TELEMETRY_HELP = `Usage: ci-cd-optimizer telemetry --run-id <id> [options]

Snapshots a completed workflow run (jobs, steps, runner queue time), compares it with prior runs of the same
workflow and branch, renders the report (Gantt timeline, job dependency graph, critical path, slowest steps, jobs
slower than baseline), and opens, updates, or resolves duration alert issues for statistically significant spikes
and sustained regressions. Run it from a workflow triggered by \`workflow_run: types: [completed]\`.

Options:
      --repo <owner/name>   Repository (default: $GITHUB_REPOSITORY)
      --run-id <id>         The completed workflow run to analyze (e.g. github.event.workflow_run.id)
      --store <file>        JSON Lines snapshot store kept between runs (persist it with actions/cache);
                            without one, history is rebuilt from the Actions API on every run
      --summary <file>      Append the markdown report (default: $GITHUB_STEP_SUMMARY when set; "-" to disable)
      --check               Also publish the report as a neutral check run on the run's head commit
      --no-alerts           Do not open or update duration alert issues
      --dry-run             Analyze and report, but write nothing to GitHub or the store
  -f, --format markdown|json  Output format (default: markdown)
  -o, --output <file>       Write the output to a file

Needs actions: read, and issues: write for alerts (checks: write with --check).
`;
function runSummary(result, repo) {
  return {
    repo,
    status: result.status,
    ...result.reason ? { reason: result.reason } : {},
    ...result.snapshot ? { snapshot: result.snapshot } : {},
    ...result.baseline ? { baseline: result.baseline } : {},
    ...result.samples !== void 0 ? { samples: result.samples } : {},
    ...result.alerts ? {
      alerts: {
        detected: result.alerts.detected,
        actions: result.alerts.actions.map((action) => ({ type: action.type, ..."number" in action ? { number: action.number } : {} })),
        applied: result.alerts.applied.map((item) => ({ type: item.action.type, number: item.number }))
      }
    } : {},
    ...result.checkRunId !== void 0 ? { checkRunId: result.checkRunId } : {}
  };
}
async function telemetryCommand(args, io) {
  const { values } = parseArgs5({
    args,
    strict: true,
    options: {
      repo: { type: "string" },
      "run-id": { type: "string" },
      store: { type: "string" },
      summary: { type: "string" },
      check: { type: "boolean", default: false },
      "no-alerts": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      format: { type: "string", short: "f", default: "markdown" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h", default: false }
    }
  });
  if (values.help) {
    io.stdout(TELEMETRY_HELP);
    return 0;
  }
  if (values.format !== "markdown" && values.format !== "json") throw new UsageError(`Unknown format "${values.format}". Use markdown or json.`);
  const runId = Number(values["run-id"]);
  if (!values["run-id"] || !Number.isSafeInteger(runId) || runId <= 0) throw new UsageError("--run-id <id> is required (a positive workflow run id).");
  const repo = repoFrom(values.repo, io);
  const client = githubClient(io);
  let run3;
  try {
    run3 = (await client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", { owner: repo.owner, repo: repo.repo, run_id: runId })).data;
  } catch (error) {
    if (httpStatus(error) === 404) throw new UsageError(`Workflow run ${runId} not found in ${repo.owner}/${repo.repo}.`);
    throw error;
  }
  const store = values.store ? new FileTelemetryStore(resolvePath(io, values.store)) : void 0;
  await store?.initialize();
  const copilot = copilotClient(io);
  const result = await processWorkflowRun(client, repo, run3, {
    dryRun: values["dry-run"],
    check: values.check,
    alerts: !values["no-alerts"],
    ...store ? { store } : {},
    ...copilot ? { copilotClient: copilot } : {},
    ...io.now ? { now: io.now() } : {}
  });
  const name = `${repo.owner}/${repo.repo}`;
  const markdown2 = result.report ?? `Telemetry ${result.status} for run ${runId}${result.reason ? `: ${result.reason}` : "."}`;
  const summaryPath = values.summary ?? io.env.GITHUB_STEP_SUMMARY;
  if (summaryPath && summaryPath !== "-" && result.report) {
    const target = resolvePath(io, summaryPath);
    await mkdir3(dirname3(target), { recursive: true });
    await appendFile2(target, `${result.report}
`, "utf8");
  }
  await writeText(io, values.output, values.format === "json" ? JSON.stringify(runSummary(result, name), null, 2) : markdown2);
  return 0;
}

// src/cli/index.ts
var HELP2 = `ci-cd-optimizer ${VERSION} - a CI/CD performance linter and optimizer for GitHub repositories

Usage: ci-cd-optimizer <command> [options]

Commands:
  lint [dir]            Lint workflows, Dockerfiles, and package manifests (default command)
  rules                 List rules (--format json|markdown)
  scan                  Scan a repository via the API like the App: SARIF, finding issues, autofix PRs
  telemetry             Report on a completed workflow run (Gantt, critical path) and raise duration alerts
  experiments <cmd>     Hill-climbing experiments: list, context, create, collect, evaluate, decide
  recipes <cmd>         Reusable fixes from promoted experiments: publish, apply, status, rollout
  help [command]        Show help
  version               Print the version

Exit codes: 0 success, 1 findings at or above --fail-on (or a failed operation), 2 usage or configuration error.
`;
var RULES_HELP = `Usage: ci-cd-optimizer rules [--format text|json|markdown] [--output <file>]`;
async function rulesCommand(args, io) {
  const { values } = parseArgs6({ args, strict: true, options: { format: { type: "string", short: "f", default: "text" }, output: { type: "string", short: "o" }, help: { type: "boolean", short: "h", default: false } } });
  if (values.help) {
    io.stdout(RULES_HELP);
    return 0;
  }
  let text;
  if (values.format === "markdown") text = renderRulesMarkdown(allRules);
  else if (values.format === "json") text = JSON.stringify(allRules.map((rule) => rule.meta), null, 2);
  else if (values.format === "text") {
    const width = Math.max(...allRules.map((rule) => rule.meta.id.length));
    text = allRules.map((rule) => `${rule.meta.id.padEnd(width)}  ${rule.meta.defaultSeverity.padEnd(5)}  ${rule.meta.fixable ? "fix" : "   "}  ${rule.meta.description}`).join("\n");
  } else throw new UsageError(`Unknown format "${values.format}". Use text, json, or markdown.`);
  await writeText(io, values.output, text);
  return 0;
}
var COMMANDS3 = {
  lint: { run: lintCommand, help: LINT_HELP },
  rules: { run: rulesCommand, help: RULES_HELP },
  experiments: { run: experimentsCommand, help: EXPERIMENTS_HELP },
  recipes: { run: recipesCommand, help: RECIPES_HELP },
  scan: { run: scanCommand, help: SCAN_HELP },
  telemetry: { run: telemetryCommand, help: TELEMETRY_HELP }
};
async function run2(argv, io) {
  const [first, ...rest] = argv;
  try {
    if (first === "version" || first === "--version" || first === "-v") {
      io.stdout(VERSION);
      return 0;
    }
    if (first === "help" || first === "--help" || first === "-h") {
      const topic = rest[0] ? COMMANDS3[rest[0]] : void 0;
      io.stdout(topic?.help ?? HELP2);
      return 0;
    }
    const command = first ? COMMANDS3[first] : void 0;
    if (command) return await command.run(rest, io);
    if (first && !first.startsWith("-") && /^[a-z]+$/.test(first) && !await isDirectory(io, first)) {
      throw new UsageError(`Unknown command "${first}". Commands: ${Object.keys(COMMANDS3).join(", ")}, help, version.`);
    }
    return await lintCommand(argv, io);
  } catch (error) {
    if (error instanceof UsageError || isArgError(error)) {
      io.stderr(`ci-cd-optimizer: ${error.message}`);
      return 2;
    }
    io.stderr(`ci-cd-optimizer: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return 1;
  }
}
function isArgError(error) {
  const code2 = error?.code;
  return typeof code2 === "string" && code2.startsWith("ERR_PARSE_ARGS");
}
async function isDirectory(io, path) {
  const { stat: stat4 } = await import("node:fs/promises");
  const { resolve: resolve3 } = await import("node:path");
  return stat4(resolve3(io.cwd, path)).then((info) => info.isDirectory(), () => false);
}

// src/action.ts
var write = (stream) => (text) => stream.write(text.endsWith("\n") ? text : `${text}
`);
var code;
try {
  const { argv, cwd, env } = actionInvocation(process.argv.slice(2), process.env, process.cwd());
  code = await run2(argv, { cwd, env, stdout: write(process.stdout), stderr: write(process.stderr) });
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`::error::${error.message}
`);
  code = 2;
}
if (process.env.GITHUB_OUTPUT && process.argv.length <= 2) await appendFile3(process.env.GITHUB_OUTPUT, `exit-code=${code}
`);
process.exitCode = code;
