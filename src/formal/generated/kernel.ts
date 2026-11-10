// @ts-nocheck
// GENERATED: npm run formal:generate; do not edit.
// Dafny program Kernel.dfy compiled into JavaScript
// Copyright by the contributors to the Dafny Project
// SPDX-License-Identifier: MIT

import { BigNumber } from "bignumber.js";
BigNumber.config({ MODULO_MODE: BigNumber.EUCLID })
let _dafny = (function() {
  let $module: any = {};
  $module.areEqual = function(a, b) {
    if (typeof a === 'string' && b instanceof _dafny.Seq) {
      // Seq.equals(string) works as expected,
      // and the catch-all else block handles that direction.
      // But the opposite direction doesn't work; handle it here.
      return b.equals(a);
    } else if (typeof a === 'number' && BigNumber.isBigNumber(b)) {
      // This conditional would be correct even without the `typeof a` part,
      // but in most cases it's probably faster to short-circuit on a `typeof`
      // than to call `isBigNumber`. (But it remains to properly test this.)
      return b.isEqualTo(a);
    } else if (typeof a !== 'object' || a === null || b === null) {
      return a === b;
    } else if (BigNumber.isBigNumber(a)) {
      return a.isEqualTo(b);
    } else if (a._tname !== undefined || (Array.isArray(a) && a.constructor.name == "Array")) {
      return a === b;  // pointer equality
    } else {
      return a.equals(b);  // value-type equality
    }
  }
  $module.toString = function(a) {
    if (a === null) {
      return "null";
    } else if (typeof a === "number") {
      return a.toFixed();
    } else if (BigNumber.isBigNumber(a)) {
      return a.toFixed();
    } else if (a._tname !== undefined) {
      return a._tname;
    } else {
      return a.toString();
    }
  }
  $module.escapeCharacter = function(cp) {
    let s = String.fromCodePoint(cp.value)
    switch (s) {
      case '\n': return "\\n";
      case '\r': return "\\r";
      case '\t': return "\\t";
      case '\0': return "\\0";
      case '\'': return "\\'";
      case '\"': return "\\\"";
      case '\\': return "\\\\";
      default: return s;
    };
  }
  $module.NewObject = function() {
    return { _tname: "object" };
  }
  $module.InstanceOfTrait = function(obj, trait) {
    return obj._parentTraits !== undefined && obj._parentTraits().includes(trait);
  }
  $module.Rtd_bool = class {
    static get Default() { return false; }
  }
  $module.Rtd_char = class {
    static get Default() { return 'D'; }  // See CharType.DefaultValue in Dafny source code
  }
  $module.Rtd_codepoint = class {
    static get Default() { return new _dafny.CodePoint('D'.codePointAt(0)); }
  }
  $module.Rtd_int = class {
    static get Default() { return BigNumber(0); }
  }
  $module.Rtd_number = class {
    static get Default() { return 0; }
  }
  $module.Rtd_ref = class {
    static get Default() { return null; }
  }
  $module.Rtd_array = class {
    static get Default() { return []; }
  }
  $module.ZERO = new BigNumber(0);
  $module.ONE = new BigNumber(1);
  $module.NUMBER_LIMIT = new BigNumber(0x20).multipliedBy(0x1000000000000);  // 2^53
  $module.Tuple = class Tuple extends Array {
    constructor(...elems) {
      super(...elems);
    }
    toString() {
      return "(" + arrayElementsToString(this) + ")";
    }
    equals(other) {
      if (this === other) {
        return true;
      }
      for (let i = 0; i < this.length; i++) {
        if (!_dafny.areEqual(this[i], other[i])) {
          return false;
        }
      }
      return true;
    }
    static Default(...values) {
      return Tuple.of(...values);
    }
    static Rtd(...rtdArgs) {
      return {
        Default: Tuple.from(rtdArgs, rtd => rtd.Default)
      };
    }
  }
  $module.Set = class Set extends Array {
    constructor() {
      super();
    }
    static get Default() {
      return Set.Empty;
    }
    toString() {
      return "{" + arrayElementsToString(this) + "}";
    }
    static get Empty() {
      if (this._empty === undefined) {
        this._empty = new Set();
      }
      return this._empty;
    }
    static fromElements(...elmts) {
      let s = new Set();
      for (let k of elmts) {
        s.add(k);
      }
      return s;
    }
    contains(k) {
      for (let i = 0; i < this.length; i++) {
        if (_dafny.areEqual(this[i], k)) {
          return true;
        }
      }
      return false;
    }
    add(k) {  // mutates the Set; use only during construction
      if (!this.contains(k)) {
        this.push(k);
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.length !== other.length) {
        return false;
      }
      for (let e of this) {
        if (!other.contains(e)) {
          return false;
        }
      }
      return true;
    }
    get Elements() {
      return this;
    }
    Union(that) {
      if (this.length === 0) {
        return that;
      } else if (that.length === 0) {
        return this;
      } else {
        let s = Set.of(...this);
        for (let k of that) {
          s.add(k);
        }
        return s;
      }
    }
    Intersect(that) {
      if (this.length === 0) {
        return this;
      } else if (that.length === 0) {
        return that;
      } else {
        let s = new Set();
        for (let k of this) {
          if (that.contains(k)) {
            s.push(k);
          }
        }
        return s;
      }
    }
    Difference(that) {
      if (this.length == 0 || that.length == 0) {
        return this;
      } else {
        let s = new Set();
        for (let k of this) {
          if (!that.contains(k)) {
            s.push(k);
          }
        }
        return s;
      }
    }
    IsDisjointFrom(that) {
      for (let k of this) {
        if (that.contains(k)) {
          return false;
        }
      }
      return true;
    }
    IsSubsetOf(that) {
      if (that.length < this.length) {
        return false;
      }
      for (let k of this) {
        if (!that.contains(k)) {
          return false;
        }
      }
      return true;
    }
    IsProperSubsetOf(that) {
      if (that.length <= this.length) {
        return false;
      }
      for (let k of this) {
        if (!that.contains(k)) {
          return false;
        }
      }
      return true;
    }
    get AllSubsets() {
      return this.AllSubsets_();
    }
    *AllSubsets_() {
      // Start by putting all set elements into a list, but don't include null
      let elmts = Array.of(...this);
      let n = elmts.length;
      let which = new Array(n);
      which.fill(false);
      let a = [];
      while (true) {
        yield Set.of(...a);
        // "add 1" to "which", as if doing a carry chain.  For every digit changed, change the membership of the corresponding element in "a".
        let i = 0;
        for (; i < n && which[i]; i++) {
          which[i] = false;
          // remove elmts[i] from a
          for (let j = 0; j < a.length; j++) {
            if (_dafny.areEqual(a[j], elmts[i])) {
              // move the last element of a into slot j
              a[j] = a[-1];
              a.pop();
              break;
            }
          }
        }
        if (i === n) {
          // we have cycled through all the subsets
          break;
        }
        which[i] = true;
        a.push(elmts[i]);
      }
    }
  }
  $module.MultiSet = class MultiSet extends Array {
    constructor() {
      super();
    }
    static get Default() {
      return MultiSet.Empty;
    }
    toString() {
      let s = "multiset{";
      let sep = "";
      for (let e of this) {
        let [k, n] = e;
        let ks = _dafny.toString(k);
        while (!n.isZero()) {
          n = n.minus(1);
          s += sep + ks;
          sep = ", ";
        }
      }
      s += "}";
      return s;
    }
    static get Empty() {
      if (this._empty === undefined) {
        this._empty = new MultiSet();
      }
      return this._empty;
    }
    static fromElements(...elmts) {
      let s = new MultiSet();
      for (let e of elmts) {
        s.add(e, _dafny.ONE);
      }
      return s;
    }
    static FromArray(arr) {
      let s = new MultiSet();
      for (let e of arr) {
        s.add(e, _dafny.ONE);
      }
      return s;
    }
    cardinality() {
      let c = _dafny.ZERO;
      for (let e of this) {
        let [k, n] = e;
        c = c.plus(n);
      }
      return c;
    }
    clone() {
      let s = new MultiSet();
      for (let e of this) {
        let [k, n] = e;
        s.push([k, n]);  // make sure to create a new array [k, n] here
      }
      return s;
    }
    findIndex(k) {
      for (let i = 0; i < this.length; i++) {
        if (_dafny.areEqual(this[i][0], k)) {
          return i;
        }
      }
      return this.length;
    }
    get(k) {
      let i = this.findIndex(k);
      if (i === this.length) {
        return _dafny.ZERO;
      } else {
        return this[i][1];
      }
    }
    contains(k) {
      return !this.get(k).isZero();
    }
    add(k, n) {
      let i = this.findIndex(k);
      if (i === this.length) {
        this.push([k, n]);
      } else {
        let m = this[i][1];
        this[i] = [k, m.plus(n)];
      }
    }
    update(k, n) {
      let i = this.findIndex(k);
      if (i < this.length && this[i][1].isEqualTo(n)) {
        return this;
      } else if (i === this.length && n.isZero()) {
        return this;
      } else if (i === this.length) {
        let m = this.slice();
        m.push([k, n]);
        return m;
      } else {
        let m = this.slice();
        m[i] = [k, n];
        return m;
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      }
      for (let e of this) {
        let [k, n] = e;
        let m = other.get(k);
        if (!n.isEqualTo(m)) {
          return false;
        }
      }
      return this.cardinality().isEqualTo(other.cardinality());
    }
    get Elements() {
      return this.Elements_();
    }
    *Elements_() {
      for (let i = 0; i < this.length; i++) {
        let [k, n] = this[i];
        while (!n.isZero()) {
          yield k;
          n = n.minus(1);
        }
      }
    }
    get UniqueElements() {
      return this.UniqueElements_();
    }
    *UniqueElements_() {
      for (let e of this) {
        let [k, n] = e;
        if (!n.isZero()) {
          yield k;
        }
      }
    }
    Union(that) {
      if (this.length === 0) {
        return that;
      } else if (that.length === 0) {
        return this;
      } else {
        let s = this.clone();
        for (let e of that) {
          let [k, n] = e;
          s.add(k, n);
        }
        return s;
      }
    }
    Intersect(that) {
      if (this.length === 0) {
        return this;
      } else if (that.length === 0) {
        return that;
      } else {
        let s = new MultiSet();
        for (let e of this) {
          let [k, n] = e;
          let m = that.get(k);
          if (!m.isZero()) {
            s.push([k, m.isLessThan(n) ? m : n]);
          }
        }
        return s;
      }
    }
    Difference(that) {
      if (this.length === 0 || that.length === 0) {
        return this;
      } else {
        let s = new MultiSet();
        for (let e of this) {
          let [k, n] = e;
          let d = n.minus(that.get(k));
          if (d.isGreaterThan(0)) {
            s.push([k, d]);
          }
        }
        return s;
      }
    }
    IsDisjointFrom(that) {
      let intersection = this.Intersect(that);
      return intersection.cardinality().isZero();
    }
    IsSubsetOf(that) {
      for (let e of this) {
        let [k, n] = e;
        let m = that.get(k);
        if (!n.isLessThanOrEqualTo(m)) {
          return false;
        }
      }
      return true;
    }
    IsProperSubsetOf(that) {
      return this.IsSubsetOf(that) && this.cardinality().isLessThan(that.cardinality());
    }
  }
  $module.CodePoint = class CodePoint {
    constructor(value) {
      this.value = value
    }
    equals(other) {
      if (this === other) {
        return true;
      }
      return this.value === other.value
    }
    isLessThan(other) {
      return this.value < other.value
    }
    isLessThanOrEqual(other) {
      return this.value <= other.value
    }
    toString() {
      return "'" + $module.escapeCharacter(this) + "'";
    }
    static isCodePoint(i) {
      return (
        (_dafny.ZERO.isLessThanOrEqualTo(i) && i.isLessThan(new BigNumber(0xD800))) ||
        (new BigNumber(0xE000).isLessThanOrEqualTo(i) && i.isLessThan(new BigNumber(0x11_0000))))
    }
  }
  $module.Seq = class Seq extends Array {
    constructor(...elems) {
      super(...elems);
    }
    static get Default() {
      return Seq.of();
    }
    static Create(n, init) {
      return Seq.from({length: n}, (_, i) => init(new BigNumber(i)));
    }
    static UnicodeFromString(s) {
      return new Seq(...([...s].map(c => new _dafny.CodePoint(c.codePointAt(0)))))
    }
    toString() {
      return "[" + arrayElementsToString(this) + "]";
    }
    toVerbatimString(asLiteral) {
      if (asLiteral) {
        return '"' + this.map(c => _dafny.escapeCharacter(c)).join("") + '"';
      } else {
        return this.map(c => String.fromCodePoint(c.value)).join("");
      }
    }
    static update(s, i, v) {
      if (typeof s === "string") {
        let p = s.slice(0, i);
        let q = s.slice(i.toNumber() + 1);
        return p.concat(v, q);
      } else {
        let t = s.slice();
        t[i] = v;
        return t;
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.length !== other.length) {
        return false;
      }
      for (let i = 0; i < this.length; i++) {
        if (!_dafny.areEqual(this[i], other[i])) {
          return false;
        }
      }
      return true;
    }
    static contains(s, k) {
      if (typeof s === "string") {
        return s.includes(k);
      } else {
        for (let x of s) {
          if (_dafny.areEqual(x, k)) {
            return true;
          }
        }
        return false;
      }
    }
    get Elements() {
      return this;
    }
    get UniqueElements() {
      return _dafny.Set.fromElements(...this);
    }
    static Concat(a, b) {
      if (typeof a === "string" || typeof b === "string") {
        // string concatenation, so make sure both operands are strings before concatenating
        if (typeof a !== "string") {
          // a must be a Seq
          a = a.join("");
        }
        if (typeof b !== "string") {
          // b must be a Seq
          b = b.join("");
        }
        return a + b;
      } else {
        // ordinary concatenation
        let r = Seq.of(...a);
        r.push(...b);
        return r;
      }
    }
    static JoinIfPossible(x) {
      try { return x.join(""); } catch(_error) { return x; }
    }
    static IsPrefixOf(a, b) {
      if (b.length < a.length) {
        return false;
      }
      for (let i = 0; i < a.length; i++) {
        if (!_dafny.areEqual(a[i], b[i])) {
          return false;
        }
      }
      return true;
    }
    static IsProperPrefixOf(a, b) {
      if (b.length <= a.length) {
        return false;
      }
      for (let i = 0; i < a.length; i++) {
        if (!_dafny.areEqual(a[i], b[i])) {
          return false;
        }
      }
      return true;
    }
  }
  $module.Map = class Map extends Array {
    constructor() {
      super();
    }
    static get Default() {
      return Map.of();
    }
    toString() {
      return "map[" + this.map(maplet => _dafny.toString(maplet[0]) + " := " + _dafny.toString(maplet[1])).join(", ") + "]";
    }
    static get Empty() {
      if (this._empty === undefined) {
        this._empty = new Map();
      }
      return this._empty;
    }
    findIndex(k) {
      for (let i = 0; i < this.length; i++) {
        if (_dafny.areEqual(this[i][0], k)) {
          return i;
        }
      }
      return this.length;
    }
    get(k) {
      let i = this.findIndex(k);
      if (i === this.length) {
        return undefined;
      } else {
        return this[i][1];
      }
    }
    contains(k) {
      return this.findIndex(k) < this.length;
    }
    update(k, v) {
      let m = this.slice();
      m.updateUnsafe(k, v);
      return m;
    }
    // Similar to update, but make the modification in-place.
    // Meant to be used in the map constructor.
    updateUnsafe(k, v) {
      let m = this;
      let i = m.findIndex(k);
      m[i] = [k, v];
      return m;
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.length !== other.length) {
        return false;
      }
      for (let e of this) {
        let [k, v] = e;
        let w = other.get(k);
        if (w === undefined || !_dafny.areEqual(v, w)) {
          return false;
        }
      }
      return true;
    }
    get Keys() {
      let s = new _dafny.Set();
      for (let e of this) {
        let [k, v] = e;
        s.push(k);
      }
      return s;
    }
    get Values() {
      let s = new _dafny.Set();
      for (let e of this) {
        let [k, v] = e;
        s.add(v);
      }
      return s;
    }
    get Items() {
      let s = new _dafny.Set();
      for (let e of this) {
        let [k, v] = e;
        s.push(_dafny.Tuple.of(k, v));
      }
      return s;
    }
    Merge(that) {
      let m = that.slice();
      for (let e of this) {
        let [k, v] = e;
        let i = m.findIndex(k);
        if (i == m.length) {
          m[i] = [k, v];
        }
      }
      return m;
    }
    Subtract(keys) {
      if (this.length === 0 || keys.length === 0) {
        return this;
      }
      let m = new Map();
      for (let e of this) {
        let [k, v] = e;
        if (!keys.contains(k)) {
          m[m.length] = e;
        }
      }
      return m;
    }
  }
  $module.newArray = function(initValue, ...dims) {
    return { dims: dims, elmts: buildArray(initValue, ...dims) };
  }
  $module.BigOrdinal = class BigOrdinal {
    static get Default() {
      return _dafny.ZERO;
    }
    static IsLimit(ord) {
      return ord.isZero();
    }
    static IsSucc(ord) {
      return ord.isGreaterThan(0);
    }
    static Offset(ord) {
      return ord;
    }
    static IsNat(ord) {
      return true;  // at run time, every ORDINAL is a natural number
    }
  }
  $module.BigRational = class BigRational {
    static get ZERO() {
      if (this._zero === undefined) {
        this._zero = new BigRational(_dafny.ZERO);
      }
      return this._zero;
    }
    constructor (n, d) {
      // requires d === undefined || 1 <= d
      this.num = n;
      this.den = d === undefined ? _dafny.ONE : d;
      // invariant 1 <= den || (num == 0 && den == 0)
    }
    static get Default() {
      return _dafny.BigRational.ZERO;
    }
    // We need to deal with the special case `num == 0 && den == 0`, because
    // that's what C#'s default struct constructor will produce for BigRational. :(
    // To deal with it, we ignore `den` when `num` is 0.
    toString() {
      if (this.num.isZero() || this.den.isEqualTo(1)) {
        return this.num.toFixed() + ".0";
      }
      let answer = this.dividesAPowerOf10(this.den);
      if (answer !== undefined) {
        let n = this.num.multipliedBy(answer[0]);
        let log10 = answer[1];
        let sign, digits;
        if (this.num.isLessThan(0)) {
          sign = "-"; digits = n.negated().toFixed();
        } else {
          sign = ""; digits = n.toFixed();
        }
        if (log10 < digits.length) {
          let digitCount = digits.length - log10;
          return sign + digits.slice(0, digitCount) + "." + digits.slice(digitCount);
        } else {
          return sign + "0." + "0".repeat(log10 - digits.length) + digits;
        }
      } else {
        return "(" + this.num.toFixed() + ".0 / " + this.den.toFixed() + ".0)";
      }
    }
    isPowerOf10(x) {
      if (x.isZero()) {
        return undefined;
      }
      let log10 = 0;
      while (true) {  // invariant: x != 0 && x * 10^log10 == old(x)
        if (x.isEqualTo(1)) {
          return log10;
        } else if (x.mod(10).isZero()) {
          log10++;
          x = x.dividedToIntegerBy(10);
        } else {
          return undefined;
        }
      }
    }
    dividesAPowerOf10(i) {
      let factor = _dafny.ONE;
      let log10 = 0;
      if (i.isLessThanOrEqualTo(_dafny.ZERO)) {
        return undefined;
      }

      // invariant: 1 <= i && i * 10^log10 == factor * old(i)
      while (i.mod(10).isZero()) {
        i = i.dividedToIntegerBy(10);
       log10++;
      }

      while (i.mod(5).isZero()) {
        i = i.dividedToIntegerBy(5);
        factor = factor.multipliedBy(2);
        log10++;
      }
      while (i.mod(2).isZero()) {
        i = i.dividedToIntegerBy(2);
        factor = factor.multipliedBy(5);
        log10++;
      }

      if (i.isEqualTo(_dafny.ONE)) {
        return [factor, log10];
      } else {
        return undefined;
      }
    }
    toBigNumber() {
      if (this.num.isZero() || this.den.isEqualTo(1)) {
        return this.num;
      } else if (this.num.isGreaterThan(0)) {
        return this.num.dividedToIntegerBy(this.den);
      } else {
        return this.num.minus(this.den).plus(1).dividedToIntegerBy(this.den);
      }
    }
    isInteger() {
      return this.equals(new _dafny.BigRational(this.toBigNumber(), _dafny.ONE));
    }
    // Returns values such that aa/dd == a and bb/dd == b.
    normalize(b) {
      let a = this;
      let aa, bb, dd;
      if (a.num.isZero()) {
        aa = a.num;
        bb = b.num;
        dd = b.den;
      } else if (b.num.isZero()) {
        aa = a.num;
        dd = a.den;
        bb = b.num;
      } else {
        let gcd = BigNumberGcd(a.den, b.den);
        let xx = a.den.dividedToIntegerBy(gcd);
        let yy = b.den.dividedToIntegerBy(gcd);
        // We now have a == a.num / (xx * gcd) and b == b.num / (yy * gcd).
        aa = a.num.multipliedBy(yy);
        bb = b.num.multipliedBy(xx);
        dd = a.den.multipliedBy(yy);
      }
      return [aa, bb, dd];
    }
    compareTo(that) {
      // simple things first
      let asign = this.num.isZero() ? 0 : this.num.isLessThan(0) ? -1 : 1;
      let bsign = that.num.isZero() ? 0 : that.num.isLessThan(0) ? -1 : 1;
      if (asign < 0 && 0 <= bsign) {
        return -1;
      } else if (asign <= 0 && 0 < bsign) {
        return -1;
      } else if (bsign < 0 && 0 <= asign) {
        return 1;
      } else if (bsign <= 0 && 0 < asign) {
        return 1;
      }
      let [aa, bb, dd] = this.normalize(that);
      if (aa.isLessThan(bb)) {
        return -1;
      } else if (aa.isEqualTo(bb)){
        return 0;
      } else {
        return 1;
      }
    }
    equals(that) {
      return this.compareTo(that) === 0;
    }
    isLessThan(that) {
      return this.compareTo(that) < 0;
    }
    isAtMost(that) {
      return this.compareTo(that) <= 0;
    }
    plus(b) {
      let [aa, bb, dd] = this.normalize(b);
      return new BigRational(aa.plus(bb), dd);
    }
    minus(b) {
      let [aa, bb, dd] = this.normalize(b);
      return new BigRational(aa.minus(bb), dd);
    }
    negated() {
      return new BigRational(this.num.negated(), this.den);
    }
    multipliedBy(b) {
      return new BigRational(this.num.multipliedBy(b.num), this.den.multipliedBy(b.den));
    }
    dividedBy(b) {
      let a = this;
      // Compute the reciprocal of b
      let bReciprocal;
      if (b.num.isGreaterThan(0)) {
        bReciprocal = new BigRational(b.den, b.num);
      } else {
        // this is the case b.num < 0
        bReciprocal = new BigRational(b.den.negated(), b.num.negated());
      }
      return a.multipliedBy(bReciprocal);
    }
  }
  $module.EuclideanDivisionNumber = function(a, b) {
    if (0 <= a) {
      if (0 <= b) {
        // +a +b: a/b
        return Math.floor(a / b);
      } else {
        // +a -b: -(a/(-b))
        return -Math.floor(a / -b);
      }
    } else {
      if (0 <= b) {
        // -a +b: -((-a-1)/b) - 1
        return -Math.floor((-a-1) / b) - 1;
      } else {
        // -a -b: ((-a-1)/(-b)) + 1
        return Math.floor((-a-1) / -b) + 1;
      }
    }
  }
  $module.EuclideanDivision = function(a, b) {
    if (a.isGreaterThanOrEqualTo(0)) {
      if (b.isGreaterThanOrEqualTo(0)) {
        // +a +b: a/b
        return a.dividedToIntegerBy(b);
      } else {
        // +a -b: -(a/(-b))
        return a.dividedToIntegerBy(b.negated()).negated();
      }
    } else {
      if (b.isGreaterThanOrEqualTo(0)) {
        // -a +b: -((-a-1)/b) - 1
        return a.negated().minus(1).dividedToIntegerBy(b).negated().minus(1);
      } else {
        // -a -b: ((-a-1)/(-b)) + 1
        return a.negated().minus(1).dividedToIntegerBy(b.negated()).plus(1);
      }
    }
  }
  $module.EuclideanModuloNumber = function(a, b) {
    let bp = Math.abs(b);
    if (0 <= a) {
      // +a: a % bp
      return a % bp;
    } else {
      // c = ((-a) % bp)
      // -a: bp - c if c > 0
      // -a: 0 if c == 0
      let c = (-a) % bp;
      return c === 0 ? c : bp - c;
    }
  }
  $module.ShiftLeft = function(b, n) {
    return b.multipliedBy(new BigNumber(2).exponentiatedBy(n));
  }
  $module.ShiftRight = function(b, n) {
    return b.dividedToIntegerBy(new BigNumber(2).exponentiatedBy(n));
  }
  $module.RotateLeft = function(b, n, w) {  // truncate(b << n) | (b >> (w - n))
    let x = _dafny.ShiftLeft(b, n).mod(new BigNumber(2).exponentiatedBy(w));
    let y = _dafny.ShiftRight(b, w - n);
    return x.plus(y);
  }
  $module.RotateRight = function(b, n, w) {  // (b >> n) | truncate(b << (w - n))
    let x = _dafny.ShiftRight(b, n);
    let y = _dafny.ShiftLeft(b, w - n).mod(new BigNumber(2).exponentiatedBy(w));;
    return x.plus(y);
  }
  $module.BitwiseAnd = function(a, b) {
    let r = _dafny.ZERO;
    const m = _dafny.NUMBER_LIMIT;  // 2^53
    let h = _dafny.ONE;
    while (!a.isZero() && !b.isZero()) {
      let a0 = a.mod(m);
      let b0 = b.mod(m);
      r = r.plus(h.multipliedBy(a0 & b0));
      a = a.dividedToIntegerBy(m);
      b = b.dividedToIntegerBy(m);
      h = h.multipliedBy(m);
    }
    return r;
  }
  $module.BitwiseOr = function(a, b) {
    let r = _dafny.ZERO;
    const m = _dafny.NUMBER_LIMIT;  // 2^53
    let h = _dafny.ONE;
    while (!a.isZero() && !b.isZero()) {
      let a0 = a.mod(m);
      let b0 = b.mod(m);
      r = r.plus(h.multipliedBy(a0 | b0));
      a = a.dividedToIntegerBy(m);
      b = b.dividedToIntegerBy(m);
      h = h.multipliedBy(m);
    }
    r = r.plus(h.multipliedBy(a | b));
    return r;
  }
  $module.BitwiseXor = function(a, b) {
    let r = _dafny.ZERO;
    const m = _dafny.NUMBER_LIMIT;  // 2^53
    let h = _dafny.ONE;
    while (!a.isZero() && !b.isZero()) {
      let a0 = a.mod(m);
      let b0 = b.mod(m);
      r = r.plus(h.multipliedBy(a0 ^ b0));
      a = a.dividedToIntegerBy(m);
      b = b.dividedToIntegerBy(m);
      h = h.multipliedBy(m);
    }
    r = r.plus(h.multipliedBy(a | b));
    return r;
  }
  $module.BitwiseNot = function(a, bits) {
    let r = _dafny.ZERO;
    let h = _dafny.ONE;
    for (let i = 0; i < bits; i++) {
      let bit = a.mod(2);
      if (bit.isZero()) {
        r = r.plus(h);
      }
      a = a.dividedToIntegerBy(2);
      h = h.multipliedBy(2);
    }
    return r;
  }
  $module.Quantifier = function(vals, frall, pred) {
    for (let u of vals) {
      if (pred(u) !== frall) { return !frall; }
    }
    return frall;
  }
  $module.PlusChar = function(a, b) {
    return String.fromCharCode(a.charCodeAt(0) + b.charCodeAt(0));
  }
  $module.UnicodePlusChar = function(a, b) {
    return new _dafny.CodePoint(a.value + b.value);
  }
  $module.MinusChar = function(a, b) {
    return String.fromCharCode(a.charCodeAt(0) - b.charCodeAt(0));
  }
  $module.UnicodeMinusChar = function(a, b) {
    return new _dafny.CodePoint(a.value - b.value);
  }
  $module.AllBooleans = function*() {
    yield false;
    yield true;
  }
  $module.AllChars = function*() {
    for (let i = 0; i < 0x10000; i++) {
      yield String.fromCharCode(i);
    }
  }
  $module.AllUnicodeChars = function*() {
    for (let i = 0; i < 0xD800; i++) {
      yield new _dafny.CodePoint(i);
    }
    for (let i = 0xE0000; i < 0x110000; i++) {
      yield new _dafny.CodePoint(i);
    }
  }
  $module.AllIntegers = function*() {
    yield _dafny.ZERO;
    for (let j = _dafny.ONE;; j = j.plus(1)) {
      yield j;
      yield j.negated();
    }
  }
  $module.IntegerRange = function*(lo, hi) {
    if (lo === null) {
      while (true) {
        hi = hi.minus(1);
        yield hi;
      }
    } else if (hi === null) {
      while (true) {
        yield lo;
        lo = lo.plus(1);
      }
    } else {
      while (lo.isLessThan(hi)) {
        yield lo;
        lo = lo.plus(1);
      }
    }
  }
  $module.SingleValue = function*(v) {
    yield v;
  }
  $module.HaltException = class HaltException extends Error {
    constructor(message) {
      super(message)
    }
  }
  $module.HandleHaltExceptions = function(f) {
    try {
      f()
    } catch (e) {
      if (e instanceof _dafny.HaltException) {
        process.stdout.write("[Program halted] " + e.message + "\n")
        process.exitCode = 1
      } else {
        throw e
      }
    }
  }
  $module.FromMainArguments = function(args) {
    var a = [...args];
    a.splice(0, 2, args[0] + " " + args[1]);
    return a;
  }
  $module.UnicodeFromMainArguments = function(args) {
    return $module.FromMainArguments(args).map(_dafny.Seq.UnicodeFromString);
  }
  return $module;

  // What follows are routines private to the Dafny runtime
  function buildArray(initValue, ...dims) {
    if (dims.length === 0) {
      return initValue;
    } else {
      let a = Array(dims[0].toNumber());
      let b = Array.from(a, (x) => buildArray(initValue, ...dims.slice(1)));
      return b;
    }
  }
  function arrayElementsToString(a) {
    // like `a.join(", ")`, but calling _dafny.toString(x) on every element x instead of x.toString()
    let s = "";
    let sep = "";
    for (let x of a) {
      s += sep + _dafny.toString(x);
      sep = ", ";
    }
    return s;
  }
  function BigNumberGcd(a, b){  // gcd of two non-negative BigNumber's
    while (true) {
      if (a.isZero()) {
        return b;
      } else if (b.isZero()) {
        return a;
      }
      if (a.isLessThan(b)) {
        b = b.modulo(a);
      } else {
        a = a.modulo(b);
      }
    }
  }
})();
// Dafny program systemModulePopulator.dfy compiled into JavaScript
let _System = (function() {
  let $module: any = {};

  $module.nat = class nat {
    constructor () {
    }
    static get Default() {
      return _dafny.ZERO;
    }
    static _Is(__source) {
      let _0_x = (__source);
      return (_dafny.ZERO).isLessThanOrEqualTo(_0_x);
    }
  };

  return $module;
})(); // end of module _System
let CiPolicy = (function() {
  let $module: any = {};

  $module.__default = class __default {
    constructor () {
      this._tname = "CiPolicy._default";
    }
    _parentTraits() {
      return [];
    }
    static ValidMode(mode) {
      return ((((_dafny.ONE).isLessThanOrEqualTo((mode).dtor_duration)) && (((mode).dtor_duration).isLessThanOrEqualTo(CiPolicy.__default.MaxDuration))) && (((_dafny.ZERO).isLessThanOrEqualTo((mode).dtor_cost)) && (((mode).dtor_cost).isLessThanOrEqualTo(CiPolicy.__default.MaxModeCost)))) && (((_dafny.ONE).isLessThanOrEqualTo((mode).dtor_demand)) && (((mode).dtor_demand).isLessThanOrEqualTo(CiPolicy.__default.MaxCapacity)));
    };
    static Valid(environment) {
      return (((((new BigNumber(((environment).dtor_jobs).length)).isLessThanOrEqualTo(CiPolicy.__default.MaxJobs)) && (((_dafny.ONE).isLessThanOrEqualTo((environment).dtor_horizon)) && (((environment).dtor_horizon).isLessThanOrEqualTo(CiPolicy.__default.MaxHorizon)))) && (((_dafny.ONE).isLessThanOrEqualTo((environment).dtor_capacity)) && (((environment).dtor_capacity).isLessThanOrEqualTo(CiPolicy.__default.MaxCapacity)))) && (((_dafny.ZERO).isLessThanOrEqualTo((environment).dtor_costLimit)) && (((environment).dtor_costLimit).isLessThanOrEqualTo((CiPolicy.__default.MaxJobs).multipliedBy(CiPolicy.__default.MaxModeCost))))) && (_dafny.Quantifier(_dafny.IntegerRange(_dafny.ZERO, new BigNumber(((environment).dtor_jobs).length)), true, function (_forall_var_0) {
        let _0_j = _forall_var_0;
        return !(((_dafny.ZERO).isLessThanOrEqualTo(_0_j)) && ((_0_j).isLessThan(new BigNumber(((environment).dtor_jobs).length)))) || (((((_dafny.ONE).isLessThanOrEqualTo(new BigNumber(((((environment).dtor_jobs)[_0_j]).dtor_modes).length))) && ((new BigNumber(((((environment).dtor_jobs)[_0_j]).dtor_modes).length)).isLessThanOrEqualTo(CiPolicy.__default.MaxModes))) && (_dafny.Quantifier(((((environment).dtor_jobs)[_0_j]).dtor_modes).UniqueElements, true, function (_forall_var_1) {
          let _1_mode = _forall_var_1;
          return !(_dafny.Seq.contains((((environment).dtor_jobs)[_0_j]).dtor_modes, _1_mode)) || (CiPolicy.__default.ValidMode(_1_mode));
        }))) && (_dafny.Quantifier(((((environment).dtor_jobs)[_0_j]).dtor_needs).UniqueElements, true, function (_forall_var_2) {
          let _2_dependency = _forall_var_2;
          return !(_dafny.Seq.contains((((environment).dtor_jobs)[_0_j]).dtor_needs, _2_dependency)) || (((_dafny.ZERO).isLessThanOrEqualTo(_2_dependency)) && ((_2_dependency).isLessThan(_0_j)));
        })));
      }));
    };
    static DomainParameters(jobs, horizon) {
      return ((_dafny.ZERO).isLessThan(horizon)) && (_dafny.Quantifier((jobs).UniqueElements, true, function (_forall_var_0) {
        let _0_job = _forall_var_0;
        return !(_dafny.Seq.contains(jobs, _0_job)) || ((_dafny.ZERO).isLessThan(new BigNumber(((_0_job).dtor_modes).length)));
      }));
    };
    static Choices(jobs, policy) {
      return ((new BigNumber((jobs).length)).isEqualTo(new BigNumber((policy).length))) && (_dafny.Quantifier(_dafny.IntegerRange(_dafny.ZERO, new BigNumber((jobs).length)), true, function (_forall_var_0) {
        let _0_j = _forall_var_0;
        return !(((_dafny.ZERO).isLessThanOrEqualTo(_0_j)) && ((_0_j).isLessThan(new BigNumber((jobs).length)))) || (((_dafny.ZERO).isLessThanOrEqualTo(((policy)[_0_j]).dtor_mode)) && ((((policy)[_0_j]).dtor_mode).isLessThan(new BigNumber((((jobs)[_0_j]).dtor_modes).length))));
      }));
    };
    static InDomain(jobs, horizon, policy) {
      return (CiPolicy.__default.Choices(jobs, policy)) && (_dafny.Quantifier(_dafny.IntegerRange(_dafny.ZERO, new BigNumber((jobs).length)), true, function (_forall_var_0) {
        let _0_j = _forall_var_0;
        return !(((_dafny.ZERO).isLessThanOrEqualTo(_0_j)) && ((_0_j).isLessThan(new BigNumber((jobs).length)))) || (((_dafny.ZERO).isLessThanOrEqualTo(((policy)[_0_j]).dtor_start)) && ((((policy)[_0_j]).dtor_start).isLessThan(horizon)));
      }));
    };
    static Finish(jobs, policy, j) {
      return (((policy)[j]).dtor_start).plus(((((jobs)[j]).dtor_modes)[((policy)[j]).dtor_mode]).dtor_duration);
    };
    static Cost(jobs, policy, n) {
      let _0___accumulator = _dafny.ZERO;
      TAIL_CALL_START: while (true) {
        if ((n).isEqualTo(_dafny.ZERO)) {
          return (_dafny.ZERO).plus(_0___accumulator);
        } else {
          _0___accumulator = (((((jobs)[(n).minus(_dafny.ONE)]).dtor_modes)[((policy)[(n).minus(_dafny.ONE)]).dtor_mode]).dtor_cost).plus(_0___accumulator);
          let _in0 = jobs;
          let _in1 = policy;
          let _in2 = (n).minus(_dafny.ONE);
          jobs = _in0;
          policy = _in1;
          n = _in2;
          continue TAIL_CALL_START;
        }
      }
    };
    static Max(a, b) {
      if ((b).isLessThanOrEqualTo(a)) {
        return a;
      } else {
        return b;
      }
    };
    static Makespan(jobs, policy, n) {
      if ((n).isEqualTo(_dafny.ZERO)) {
        return _dafny.ZERO;
      } else {
        return CiPolicy.__default.Max(CiPolicy.__default.Makespan(jobs, policy, (n).minus(_dafny.ONE)), CiPolicy.__default.Finish(jobs, policy, (n).minus(_dafny.ONE)));
      }
    };
    static Load(jobs, policy, tick, n) {
      let _0___accumulator = _dafny.ZERO;
      TAIL_CALL_START: while (true) {
        if ((n).isEqualTo(_dafny.ZERO)) {
          return (_dafny.ZERO).plus(_0___accumulator);
        } else {
          _0___accumulator = (((((((policy)[(n).minus(_dafny.ONE)]).dtor_start).isLessThanOrEqualTo(tick)) && ((tick).isLessThan(CiPolicy.__default.Finish(jobs, policy, (n).minus(_dafny.ONE))))) ? (((((jobs)[(n).minus(_dafny.ONE)]).dtor_modes)[((policy)[(n).minus(_dafny.ONE)]).dtor_mode]).dtor_demand) : (_dafny.ZERO))).plus(_0___accumulator);
          let _in0 = jobs;
          let _in1 = policy;
          let _in2 = tick;
          let _in3 = (n).minus(_dafny.ONE);
          jobs = _in0;
          policy = _in1;
          tick = _in2;
          n = _in3;
          continue TAIL_CALL_START;
        }
      }
    };
    static Feasible(environment, policy) {
      return ((((CiPolicy.__default.Choices((environment).dtor_jobs, policy)) && (_dafny.Quantifier(_dafny.IntegerRange(_dafny.ZERO, new BigNumber(((environment).dtor_jobs).length)), true, function (_forall_var_0) {
        let _0_j = _forall_var_0;
        return !(((_dafny.ZERO).isLessThanOrEqualTo(_0_j)) && ((_0_j).isLessThan(new BigNumber(((environment).dtor_jobs).length)))) || (((_dafny.ZERO).isLessThanOrEqualTo(((policy)[_0_j]).dtor_start)) && ((CiPolicy.__default.Finish((environment).dtor_jobs, policy, _0_j)).isLessThanOrEqualTo((environment).dtor_horizon)));
      }))) && ((CiPolicy.__default.Cost((environment).dtor_jobs, policy, new BigNumber(((environment).dtor_jobs).length))).isLessThanOrEqualTo((environment).dtor_costLimit))) && (_dafny.Quantifier(_dafny.IntegerRange(_dafny.ZERO, new BigNumber(((environment).dtor_jobs).length)), true, function (_forall_var_1) {
        let _1_j = _forall_var_1;
        return !(((_dafny.ZERO).isLessThanOrEqualTo(_1_j)) && ((_1_j).isLessThan(new BigNumber(((environment).dtor_jobs).length)))) || (_dafny.Quantifier(((((environment).dtor_jobs)[_1_j]).dtor_needs).UniqueElements, true, function (_forall_var_2) {
          let _2_dependency = _forall_var_2;
          return !(_dafny.Seq.contains((((environment).dtor_jobs)[_1_j]).dtor_needs, _2_dependency)) || ((CiPolicy.__default.Finish((environment).dtor_jobs, policy, _2_dependency)).isLessThanOrEqualTo(((policy)[_1_j]).dtor_start));
        }));
      }))) && (_dafny.Quantifier(_dafny.IntegerRange(_dafny.ZERO, (environment).dtor_horizon), true, function (_forall_var_3) {
        let _3_tick = _forall_var_3;
        return !(((_dafny.ZERO).isLessThanOrEqualTo(_3_tick)) && ((_3_tick).isLessThan((environment).dtor_horizon))) || ((CiPolicy.__default.Load((environment).dtor_jobs, policy, _3_tick, new BigNumber(((environment).dtor_jobs).length))).isLessThanOrEqualTo((environment).dtor_capacity));
      }));
    };
    static Evaluate(environment, policy) {
      return CiPolicy.Objective.create_Objective(CiPolicy.__default.Makespan((environment).dtor_jobs, policy, new BigNumber(((environment).dtor_jobs).length)), CiPolicy.__default.Cost((environment).dtor_jobs, policy, new BigNumber(((environment).dtor_jobs).length)));
    };
    static PolicyCount(jobs, horizon) {
      let _0___accumulator = _dafny.ONE;
      TAIL_CALL_START: while (true) {
        if ((new BigNumber((jobs).length)).isEqualTo(_dafny.ZERO)) {
          return (_dafny.ONE).multipliedBy(_0___accumulator);
        } else {
          _0___accumulator = (_0___accumulator).multipliedBy((horizon).multipliedBy(new BigNumber((((jobs)[_dafny.ZERO]).dtor_modes).length)));
          let _in0 = (jobs).slice(_dafny.ONE);
          let _in1 = horizon;
          jobs = _in0;
          horizon = _in1;
          continue TAIL_CALL_START;
        }
      }
    };
    static Decode(jobs, horizon, rank) {
      let _0___accumulator = _dafny.Seq.of();
      TAIL_CALL_START: while (true) {
        if ((new BigNumber((jobs).length)).isEqualTo(_dafny.ZERO)) {
          return _dafny.Seq.Concat(_0___accumulator, _dafny.Seq.of());
        } else {
          let _1_tailCount = CiPolicy.__default.PolicyCount((jobs).slice(_dafny.ONE), horizon);
          let _2_digit = _dafny.EuclideanDivision(rank, _1_tailCount);
          _0___accumulator = _dafny.Seq.Concat(_0___accumulator, _dafny.Seq.of(CiPolicy.Placement.create_Placement(_dafny.EuclideanDivision(_2_digit, horizon), (_2_digit).mod(horizon))));
          let _in0 = (jobs).slice(_dafny.ONE);
          let _in1 = horizon;
          let _in2 = (rank).mod(_1_tailCount);
          jobs = _in0;
          horizon = _in1;
          rank = _in2;
          continue TAIL_CALL_START;
        }
      }
    };
    static Encode(jobs, horizon, policy) {
      if ((new BigNumber((jobs).length)).isEqualTo(_dafny.ZERO)) {
        return _dafny.ZERO;
      } else {
        let _0_digit = ((((policy)[_dafny.ZERO]).dtor_mode).multipliedBy(horizon)).plus(((policy)[_dafny.ZERO]).dtor_start);
        let _1_tailCount = CiPolicy.__default.PolicyCount((jobs).slice(_dafny.ONE), horizon);
        let _2_tailRank = CiPolicy.__default.Encode((jobs).slice(_dafny.ONE), horizon, (policy).slice(_dafny.ONE));
        return ((_0_digit).multipliedBy(_1_tailCount)).plus(_2_tailRank);
      }
    };
    static Preferred(a, ai, b, bi) {
      return (((a).dtor_makespan).isLessThan((b).dtor_makespan)) || ((((a).dtor_makespan).isEqualTo((b).dtor_makespan)) && ((((a).dtor_cost).isLessThan((b).dtor_cost)) || ((((a).dtor_cost).isEqualTo((b).dtor_cost)) && ((ai).isLessThanOrEqualTo(bi)))));
    };
    static Optimize(environment, budget) {
      let result = CiPolicy.Result.Default();
      if ((!(CiPolicy.__default.Valid(environment))) || (!(((_dafny.ONE).isLessThanOrEqualTo(budget)) && ((budget).isLessThanOrEqualTo(CiPolicy.__default.MaxSearchBudget))))) {
        result = CiPolicy.Result.create_Invalid();
        return result;
      }
      let _0_jobs;
      let _1_horizon;
      let _rhs0 = (environment).dtor_jobs;
      let _rhs1 = (environment).dtor_horizon;
      _0_jobs = _rhs0;
      _1_horizon = _rhs1;
      let _2_count;
      _2_count = CiPolicy.__default.PolicyCount(_0_jobs, _1_horizon);
      if ((budget).isLessThan(_2_count)) {
        result = CiPolicy.Result.create_Exhausted(_2_count);
        return result;
      }
      let _3_winner;
      _3_winner = new BigNumber(-1);
      let _4_rank;
      _4_rank = _dafny.ZERO;
      while ((_4_rank).isLessThan(_2_count)) {
        let _5_policy;
        _5_policy = CiPolicy.__default.Decode(_0_jobs, _1_horizon, _4_rank);
        if (CiPolicy.__default.Feasible(environment, _5_policy)) {
          if ((_3_winner).isEqualTo(new BigNumber(-1))) {
            _3_winner = _4_rank;
          } else if (CiPolicy.__default.Preferred(CiPolicy.__default.Evaluate(environment, _5_policy), _4_rank, CiPolicy.__default.Evaluate(environment, CiPolicy.__default.Decode(_0_jobs, _1_horizon, _3_winner)), _3_winner)) {
            _3_winner = _4_rank;
          } else {
          }
        }
        _4_rank = (_4_rank).plus(_dafny.ONE);
      }
      if ((_3_winner).isEqualTo(new BigNumber(-1))) {
        result = CiPolicy.Result.create_Infeasible(_2_count);
      } else {
        let _6_policy;
        _6_policy = CiPolicy.__default.Decode(_0_jobs, _1_horizon, _3_winner);
        result = CiPolicy.Result.create_Optimal(_2_count, _3_winner, _6_policy, CiPolicy.__default.Evaluate(environment, _6_policy));
      }
      return result;
    }
    static get MaxDuration() {
      return new BigNumber(32);
    };
    static get MaxModeCost() {
      return new BigNumber(1000000);
    };
    static get MaxCapacity() {
      return new BigNumber(8);
    };
    static get MaxJobs() {
      return new BigNumber(8);
    };
    static get MaxHorizon() {
      return new BigNumber(16);
    };
    static get MaxModes() {
      return new BigNumber(4);
    };
    static get MaxSearchBudget() {
      return new BigNumber(250000);
    };
    static get DefaultSearchBudget() {
      return new BigNumber(50000);
    };
  };

  $module.Mode = class Mode {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Mode(duration, cost, demand) {
      let $dt = new Mode(0);
      $dt.duration = duration;
      $dt.cost = cost;
      $dt.demand = demand;
      return $dt;
    }
    get is_Mode() { return this.$tag === 0; }
    get dtor_duration() { return this.duration; }
    get dtor_cost() { return this.cost; }
    get dtor_demand() { return this.demand; }
    toString() {
      if (this.$tag === 0) {
        return "CiPolicy.Mode.Mode" + "(" + _dafny.toString(this.duration) + ", " + _dafny.toString(this.cost) + ", " + _dafny.toString(this.demand) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0 && _dafny.areEqual(this.duration, other.duration) && _dafny.areEqual(this.cost, other.cost) && _dafny.areEqual(this.demand, other.demand);
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return CiPolicy.Mode.create_Mode(_dafny.ZERO, _dafny.ZERO, _dafny.ZERO);
    }
    static Rtd() {
      return class {
        static get Default() {
          return Mode.Default();
        }
      };
    }
  }

  $module.Job = class Job {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Job(modes, needs) {
      let $dt = new Job(0);
      $dt.modes = modes;
      $dt.needs = needs;
      return $dt;
    }
    get is_Job() { return this.$tag === 0; }
    get dtor_modes() { return this.modes; }
    get dtor_needs() { return this.needs; }
    toString() {
      if (this.$tag === 0) {
        return "CiPolicy.Job.Job" + "(" + _dafny.toString(this.modes) + ", " + _dafny.toString(this.needs) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0 && _dafny.areEqual(this.modes, other.modes) && _dafny.areEqual(this.needs, other.needs);
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return CiPolicy.Job.create_Job(_dafny.Seq.of(), _dafny.Seq.of());
    }
    static Rtd() {
      return class {
        static get Default() {
          return Job.Default();
        }
      };
    }
  }

  $module.Environment = class Environment {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Environment(jobs, horizon, capacity, costLimit) {
      let $dt = new Environment(0);
      $dt.jobs = jobs;
      $dt.horizon = horizon;
      $dt.capacity = capacity;
      $dt.costLimit = costLimit;
      return $dt;
    }
    get is_Environment() { return this.$tag === 0; }
    get dtor_jobs() { return this.jobs; }
    get dtor_horizon() { return this.horizon; }
    get dtor_capacity() { return this.capacity; }
    get dtor_costLimit() { return this.costLimit; }
    toString() {
      if (this.$tag === 0) {
        return "CiPolicy.Environment.Environment" + "(" + _dafny.toString(this.jobs) + ", " + _dafny.toString(this.horizon) + ", " + _dafny.toString(this.capacity) + ", " + _dafny.toString(this.costLimit) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0 && _dafny.areEqual(this.jobs, other.jobs) && _dafny.areEqual(this.horizon, other.horizon) && _dafny.areEqual(this.capacity, other.capacity) && _dafny.areEqual(this.costLimit, other.costLimit);
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return CiPolicy.Environment.create_Environment(_dafny.Seq.of(), _dafny.ZERO, _dafny.ZERO, _dafny.ZERO);
    }
    static Rtd() {
      return class {
        static get Default() {
          return Environment.Default();
        }
      };
    }
  }

  $module.Placement = class Placement {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Placement(mode, start) {
      let $dt = new Placement(0);
      $dt.mode = mode;
      $dt.start = start;
      return $dt;
    }
    get is_Placement() { return this.$tag === 0; }
    get dtor_mode() { return this.mode; }
    get dtor_start() { return this.start; }
    toString() {
      if (this.$tag === 0) {
        return "CiPolicy.Placement.Placement" + "(" + _dafny.toString(this.mode) + ", " + _dafny.toString(this.start) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0 && _dafny.areEqual(this.mode, other.mode) && _dafny.areEqual(this.start, other.start);
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return CiPolicy.Placement.create_Placement(_dafny.ZERO, _dafny.ZERO);
    }
    static Rtd() {
      return class {
        static get Default() {
          return Placement.Default();
        }
      };
    }
  }

  $module.Objective = class Objective {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Objective(makespan, cost) {
      let $dt = new Objective(0);
      $dt.makespan = makespan;
      $dt.cost = cost;
      return $dt;
    }
    get is_Objective() { return this.$tag === 0; }
    get dtor_makespan() { return this.makespan; }
    get dtor_cost() { return this.cost; }
    toString() {
      if (this.$tag === 0) {
        return "CiPolicy.Objective.Objective" + "(" + _dafny.toString(this.makespan) + ", " + _dafny.toString(this.cost) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0 && _dafny.areEqual(this.makespan, other.makespan) && _dafny.areEqual(this.cost, other.cost);
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return CiPolicy.Objective.create_Objective(_dafny.ZERO, _dafny.ZERO);
    }
    static Rtd() {
      return class {
        static get Default() {
          return Objective.Default();
        }
      };
    }
  }

  $module.Result = class Result {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Invalid() {
      let $dt = new Result(0);
      return $dt;
    }
    static create_Exhausted(required) {
      let $dt = new Result(1);
      $dt.required = required;
      return $dt;
    }
    static create_Infeasible(examined) {
      let $dt = new Result(2);
      $dt.examined = examined;
      return $dt;
    }
    static create_Optimal(examined, rank, policy, objective) {
      let $dt = new Result(3);
      $dt.examined = examined;
      $dt.rank = rank;
      $dt.policy = policy;
      $dt.objective = objective;
      return $dt;
    }
    get is_Invalid() { return this.$tag === 0; }
    get is_Exhausted() { return this.$tag === 1; }
    get is_Infeasible() { return this.$tag === 2; }
    get is_Optimal() { return this.$tag === 3; }
    get dtor_required() { return this.required; }
    get dtor_examined() { return this.examined; }
    get dtor_rank() { return this.rank; }
    get dtor_policy() { return this.policy; }
    get dtor_objective() { return this.objective; }
    toString() {
      if (this.$tag === 0) {
        return "CiPolicy.Result.Invalid";
      } else if (this.$tag === 1) {
        return "CiPolicy.Result.Exhausted" + "(" + _dafny.toString(this.required) + ")";
      } else if (this.$tag === 2) {
        return "CiPolicy.Result.Infeasible" + "(" + _dafny.toString(this.examined) + ")";
      } else if (this.$tag === 3) {
        return "CiPolicy.Result.Optimal" + "(" + _dafny.toString(this.examined) + ", " + _dafny.toString(this.rank) + ", " + _dafny.toString(this.policy) + ", " + _dafny.toString(this.objective) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0;
      } else if (this.$tag === 1) {
        return other.$tag === 1 && _dafny.areEqual(this.required, other.required);
      } else if (this.$tag === 2) {
        return other.$tag === 2 && _dafny.areEqual(this.examined, other.examined);
      } else if (this.$tag === 3) {
        return other.$tag === 3 && _dafny.areEqual(this.examined, other.examined) && _dafny.areEqual(this.rank, other.rank) && _dafny.areEqual(this.policy, other.policy) && _dafny.areEqual(this.objective, other.objective);
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return CiPolicy.Result.create_Invalid();
    }
    static Rtd() {
      return class {
        static get Default() {
          return Result.Default();
        }
      };
    }
  }
  return $module;
})(); // end of module CiPolicy
let Policy = (function() {
  let $module: any = {};

  $module.__default = class __default {
    constructor () {
      this._tname = "Policy._default";
    }
    _parentTraits() {
      return [];
    }
    static Resolve(updates) {
      let severity = _dafny.ZERO;
      severity = _dafny.ZERO;
      let _0_i;
      _0_i = _dafny.ZERO;
      while ((_0_i).isLessThan(new BigNumber((updates).length))) {
        if (!((updates)[_0_i]).isEqualTo(new BigNumber(-1))) {
          severity = (updates)[_0_i];
        }
        _0_i = (_0_i).plus(_dafny.ONE);
      }
      return severity;
    }
  };
  return $module;
})(); // end of module Policy
let Selection = (function() {
  let $module: any = {};

  $module.__default = class __default {
    constructor () {
      this._tname = "Selection._default";
    }
    _parentTraits() {
      return [];
    }
    static ValidMetric(m) {
      return (((((_dafny.ZERO).minus(Selection.__default.Scale)).isLessThanOrEqualTo((m).dtor_delta)) && (((m).dtor_delta).isLessThanOrEqualTo(Selection.__default.Scale))) && ((_dafny.ZERO).isLessThanOrEqualTo((m).dtor_weight))) && (((new BigNumber(-1)).isLessThanOrEqualTo((m).dtor_regressionLimit)) && (((m).dtor_regressionLimit).isLessThanOrEqualTo(Selection.__default.Scale)));
    };
    static Weight(ms) {
      let _0___accumulator = _dafny.ZERO;
      TAIL_CALL_START: while (true) {
        if ((new BigNumber((ms).length)).isEqualTo(_dafny.ZERO)) {
          return (_dafny.ZERO).plus(_0___accumulator);
        } else {
          _0___accumulator = (_0___accumulator).plus(((ms)[_dafny.ZERO]).dtor_weight);
          let _in0 = (ms).slice(_dafny.ONE);
          ms = _in0;
          continue TAIL_CALL_START;
        }
      }
    };
    static Weighted(ms) {
      let _0___accumulator = _dafny.ZERO;
      TAIL_CALL_START: while (true) {
        if ((new BigNumber((ms).length)).isEqualTo(_dafny.ZERO)) {
          return (_dafny.ZERO).plus(_0___accumulator);
        } else {
          _0___accumulator = (_0___accumulator).plus((((ms)[_dafny.ZERO]).dtor_weight).multipliedBy(((ms)[_dafny.ZERO]).dtor_delta));
          let _in0 = (ms).slice(_dafny.ONE);
          ms = _in0;
          continue TAIL_CALL_START;
        }
      }
    };
    static Valid(c, minimum, influence) {
      return ((((((((!((c).dtor_invalid)) && (((_dafny.ZERO).isLessThanOrEqualTo(minimum)) && ((minimum).isLessThanOrEqualTo(Selection.__default.Scale)))) && (((_dafny.ZERO).isLessThanOrEqualTo(influence)) && ((influence).isLessThanOrEqualTo(_dafny.EuclideanDivision(Selection.__default.Scale, new BigNumber(2)))))) && (((new BigNumber(-1)).isLessThanOrEqualTo((c).dtor_tests)) && (((c).dtor_tests).isLessThanOrEqualTo(_dafny.ONE)))) && (((new BigNumber(-1)).isLessThanOrEqualTo((c).dtor_controlTests)) && (((c).dtor_controlTests).isLessThanOrEqualTo(_dafny.ONE)))) && (((new BigNumber(-1)).isLessThanOrEqualTo((c).dtor_judge)) && (((c).dtor_judge).isLessThanOrEqualTo(Selection.__default.Scale)))) && ((_dafny.ZERO).isLessThan(new BigNumber(((c).dtor_metrics).length)))) && (_dafny.Quantifier(((c).dtor_metrics).UniqueElements, true, function (_forall_var_0) {
        let _0_m = _forall_var_0;
        return !(_dafny.Seq.contains((c).dtor_metrics, _0_m)) || (Selection.__default.ValidMetric(_0_m));
      }))) && ((_dafny.ZERO).isLessThan(Selection.__default.Weight((c).dtor_metrics)));
    };
    static Round(numerator, denominator) {
      return _dafny.EuclideanDivision(((new BigNumber(2)).multipliedBy(numerator)).plus(denominator), (new BigNumber(2)).multipliedBy(denominator));
    };
    static Mean(ms) {
      return Selection.__default.Round(Selection.__default.Weighted(ms), Selection.__default.Weight(ms));
    };
    static Rank(score, judge, influence) {
      if ((judge).isEqualTo(new BigNumber(-1))) {
        return score;
      } else {
        let _0_numerator = (((Selection.__default.Scale).minus(influence)).multipliedBy(score)).plus((influence).multipliedBy(((new BigNumber(2)).multipliedBy(judge)).minus(Selection.__default.Scale)));
        return Selection.__default.Round(_0_numerator, Selection.__default.Scale);
      }
    };
    static Regression(ms) {
      return _dafny.Quantifier((ms).UniqueElements, false, function (_exists_var_0) {
        let _0_m = _exists_var_0;
        return (_dafny.Seq.contains(ms, _0_m)) && ((((_0_m).dtor_measured) && ((_dafny.ZERO).isLessThanOrEqualTo((_0_m).dtor_regressionLimit))) && (((_0_m).dtor_delta).isLessThan((_dafny.ZERO).minus((_0_m).dtor_regressionLimit))));
      });
    };
    static HardFailure(c, minimum, influence) {
      return ((((((!(Selection.__default.Valid(c, minimum, influence))) || (((c).dtor_tests).isEqualTo(_dafny.ZERO))) || (((c).dtor_controlTests).isEqualTo(_dafny.ZERO))) || ((c).dtor_armError)) || ((c).dtor_controlError)) || ((c).dtor_protectedPath)) || (Selection.__default.Regression((c).dtor_metrics));
    };
    static Pending(c) {
      return ((((c).dtor_tests).isEqualTo(new BigNumber(-1))) || (((c).dtor_controlTests).isEqualTo(new BigNumber(-1)))) || (_dafny.Quantifier(((c).dtor_metrics).UniqueElements, false, function (_exists_var_0) {
        let _0_m = _exists_var_0;
        return (_dafny.Seq.contains((c).dtor_metrics, _0_m)) && (!((_0_m).dtor_measured));
      }));
    };
    static Evaluate(c, minimum, influence) {
      let _0_valid = Selection.__default.Valid(c, minimum, influence);
      let _1_score = ((_0_valid) ? (Selection.__default.Mean((c).dtor_metrics)) : (_dafny.ZERO));
      let _2_rank = ((_0_valid) ? (Selection.__default.Rank(_1_score, (c).dtor_judge, influence)) : (_dafny.ZERO));
      let _3_failed = Selection.__default.HardFailure(c, minimum, influence);
      let _4_pending = Selection.__default.Pending(c);
      return Selection.Score.create_Score(_1_score, _2_rank, _3_failed, _4_pending, ((!(_3_failed)) && (!(_4_pending))) && ((minimum).isLessThanOrEqualTo(_1_score)));
    };
    static Preferred(a, ai, b, bi) {
      return (((b).dtor_rank).isLessThan((a).dtor_rank)) || ((((a).dtor_rank).isEqualTo((b).dtor_rank)) && ((((b).dtor_deterministic).isLessThan((a).dtor_deterministic)) || ((((a).dtor_deterministic).isEqualTo((b).dtor_deterministic)) && ((ai).isLessThanOrEqualTo(bi)))));
    };
    static Select(cs, minimum, influence) {
      let winner = _dafny.ZERO;
      let unfinished = false;
      winner = new BigNumber(-1);
      unfinished = false;
      let _0_i;
      _0_i = _dafny.ZERO;
      while ((_0_i).isLessThan(new BigNumber((cs).length))) {
        let _1_next;
        _1_next = Selection.__default.Evaluate((cs)[_0_i], minimum, influence);
        unfinished = (unfinished) || (((_1_next).dtor_pending) && (!((_1_next).dtor_failed)));
        if ((_1_next).dtor_eligible) {
          if ((winner).isEqualTo(new BigNumber(-1))) {
            winner = _0_i;
          } else if (Selection.__default.Preferred(_1_next, _0_i, Selection.__default.Evaluate((cs)[winner], minimum, influence), winner)) {
            winner = _0_i;
          } else {
          }
        }
        _0_i = (_0_i).plus(_dafny.ONE);
      }
      return [winner, unfinished];
    }
    static Reduce(cs, minimum, influence, running, expired) {
      let action = Selection.Action.Default();
      if (!(running)) {
        action = Selection.Action.create_Skip();
        return action;
      }
      let _0_winner;
      let _1_unfinished;
      let _out0;
      let _out1;
      let _outcollector0 = Selection.__default.Select(cs, minimum, influence);
      _out0 = _outcollector0[0];
      _out1 = _outcollector0[1];
      _0_winner = _out0;
      _1_unfinished = _out1;
      if (((_dafny.ZERO).isLessThanOrEqualTo(_0_winner)) && ((!(_1_unfinished)) || (expired))) {
        action = Selection.Action.create_Promote(_0_winner);
      } else if (expired) {
        action = Selection.Action.create_Expire();
      } else if (!(_1_unfinished)) {
        action = Selection.Action.create_Reject();
      } else {
        action = Selection.Action.create_Wait();
      }
      return action;
    }
    static get Scale() {
      return new BigNumber(10000);
    };
  };

  $module.Metric = class Metric {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Metric(delta, weight, measured, regressionLimit) {
      let $dt = new Metric(0);
      $dt.delta = delta;
      $dt.weight = weight;
      $dt.measured = measured;
      $dt.regressionLimit = regressionLimit;
      return $dt;
    }
    get is_Metric() { return this.$tag === 0; }
    get dtor_delta() { return this.delta; }
    get dtor_weight() { return this.weight; }
    get dtor_measured() { return this.measured; }
    get dtor_regressionLimit() { return this.regressionLimit; }
    toString() {
      if (this.$tag === 0) {
        return "Selection.Metric.Metric" + "(" + _dafny.toString(this.delta) + ", " + _dafny.toString(this.weight) + ", " + _dafny.toString(this.measured) + ", " + _dafny.toString(this.regressionLimit) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0 && _dafny.areEqual(this.delta, other.delta) && _dafny.areEqual(this.weight, other.weight) && this.measured === other.measured && _dafny.areEqual(this.regressionLimit, other.regressionLimit);
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return Selection.Metric.create_Metric(_dafny.ZERO, _dafny.ZERO, false, _dafny.ZERO);
    }
    static Rtd() {
      return class {
        static get Default() {
          return Metric.Default();
        }
      };
    }
  }

  $module.Candidate = class Candidate {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Candidate(metrics, tests, controlTests, armError, controlError, protectedPath, invalid, judge) {
      let $dt = new Candidate(0);
      $dt.metrics = metrics;
      $dt.tests = tests;
      $dt.controlTests = controlTests;
      $dt.armError = armError;
      $dt.controlError = controlError;
      $dt.protectedPath = protectedPath;
      $dt.invalid = invalid;
      $dt.judge = judge;
      return $dt;
    }
    get is_Candidate() { return this.$tag === 0; }
    get dtor_metrics() { return this.metrics; }
    get dtor_tests() { return this.tests; }
    get dtor_controlTests() { return this.controlTests; }
    get dtor_armError() { return this.armError; }
    get dtor_controlError() { return this.controlError; }
    get dtor_protectedPath() { return this.protectedPath; }
    get dtor_invalid() { return this.invalid; }
    get dtor_judge() { return this.judge; }
    toString() {
      if (this.$tag === 0) {
        return "Selection.Candidate.Candidate" + "(" + _dafny.toString(this.metrics) + ", " + _dafny.toString(this.tests) + ", " + _dafny.toString(this.controlTests) + ", " + _dafny.toString(this.armError) + ", " + _dafny.toString(this.controlError) + ", " + _dafny.toString(this.protectedPath) + ", " + _dafny.toString(this.invalid) + ", " + _dafny.toString(this.judge) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0 && _dafny.areEqual(this.metrics, other.metrics) && _dafny.areEqual(this.tests, other.tests) && _dafny.areEqual(this.controlTests, other.controlTests) && this.armError === other.armError && this.controlError === other.controlError && this.protectedPath === other.protectedPath && this.invalid === other.invalid && _dafny.areEqual(this.judge, other.judge);
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return Selection.Candidate.create_Candidate(_dafny.Seq.of(), _dafny.ZERO, _dafny.ZERO, false, false, false, false, _dafny.ZERO);
    }
    static Rtd() {
      return class {
        static get Default() {
          return Candidate.Default();
        }
      };
    }
  }

  $module.Score = class Score {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Score(deterministic, rank, failed, pending, eligible) {
      let $dt = new Score(0);
      $dt.deterministic = deterministic;
      $dt.rank = rank;
      $dt.failed = failed;
      $dt.pending = pending;
      $dt.eligible = eligible;
      return $dt;
    }
    get is_Score() { return this.$tag === 0; }
    get dtor_deterministic() { return this.deterministic; }
    get dtor_rank() { return this.rank; }
    get dtor_failed() { return this.failed; }
    get dtor_pending() { return this.pending; }
    get dtor_eligible() { return this.eligible; }
    toString() {
      if (this.$tag === 0) {
        return "Selection.Score.Score" + "(" + _dafny.toString(this.deterministic) + ", " + _dafny.toString(this.rank) + ", " + _dafny.toString(this.failed) + ", " + _dafny.toString(this.pending) + ", " + _dafny.toString(this.eligible) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0 && _dafny.areEqual(this.deterministic, other.deterministic) && _dafny.areEqual(this.rank, other.rank) && this.failed === other.failed && this.pending === other.pending && this.eligible === other.eligible;
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return Selection.Score.create_Score(_dafny.ZERO, _dafny.ZERO, false, false, false);
    }
    static Rtd() {
      return class {
        static get Default() {
          return Score.Default();
        }
      };
    }
  }

  $module.Action = class Action {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Skip() {
      let $dt = new Action(0);
      return $dt;
    }
    static create_Wait() {
      let $dt = new Action(1);
      return $dt;
    }
    static create_Promote(index) {
      let $dt = new Action(2);
      $dt.index = index;
      return $dt;
    }
    static create_Reject() {
      let $dt = new Action(3);
      return $dt;
    }
    static create_Expire() {
      let $dt = new Action(4);
      return $dt;
    }
    get is_Skip() { return this.$tag === 0; }
    get is_Wait() { return this.$tag === 1; }
    get is_Promote() { return this.$tag === 2; }
    get is_Reject() { return this.$tag === 3; }
    get is_Expire() { return this.$tag === 4; }
    get dtor_index() { return this.index; }
    toString() {
      if (this.$tag === 0) {
        return "Selection.Action.Skip";
      } else if (this.$tag === 1) {
        return "Selection.Action.Wait";
      } else if (this.$tag === 2) {
        return "Selection.Action.Promote" + "(" + _dafny.toString(this.index) + ")";
      } else if (this.$tag === 3) {
        return "Selection.Action.Reject";
      } else if (this.$tag === 4) {
        return "Selection.Action.Expire";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0;
      } else if (this.$tag === 1) {
        return other.$tag === 1;
      } else if (this.$tag === 2) {
        return other.$tag === 2 && _dafny.areEqual(this.index, other.index);
      } else if (this.$tag === 3) {
        return other.$tag === 3;
      } else if (this.$tag === 4) {
        return other.$tag === 4;
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return Selection.Action.create_Skip();
    }
    static Rtd() {
      return class {
        static get Default() {
          return Action.Default();
        }
      };
    }
  }
  return $module;
})(); // end of module Selection
let CacheKey = (function() {
  let $module: any = {};

  $module.__default = class __default {
    constructor () {
      this._tname = "CacheKey._default";
    }
    _parentTraits() {
      return [];
    }
    static Val(c, r) {
      let _source0 = c;
      {
        if (_source0.is_Lit) {
          let _0_s = (_source0).s;
          return _0_s;
        }
      }
      {
        if (_source0.is_RunnerOs) {
          return (r).dtor_os;
        }
      }
      {
        if (_source0.is_HashFiles) {
          let _1_id = (_source0).id;
          if (((r).dtor_files).contains(_1_id)) {
            return ((r).dtor_files).get(_1_id);
          } else {
            return _dafny.Seq.UnicodeFromString("");
          }
        }
      }
      {
        let _2_v = (_source0).c;
        if (((r).dtor_ctx).contains(_2_v)) {
          return ((r).dtor_ctx).get(_2_v);
        } else {
          return _dafny.Seq.UnicodeFromString("");
        }
      }
    };
    static Render(t, r) {
      let _0___accumulator = _dafny.Seq.of();
      TAIL_CALL_START: while (true) {
        if ((new BigNumber((t).length)).isEqualTo(_dafny.ZERO)) {
          return _dafny.Seq.Concat(_0___accumulator, _dafny.Seq.UnicodeFromString(""));
        } else {
          _0___accumulator = _dafny.Seq.Concat(_0___accumulator, CacheKey.__default.Val((t)[_dafny.ZERO], r));
          let _in0 = (t).slice(_dafny.ONE);
          let _in1 = r;
          t = _in0;
          r = _in1;
          continue TAIL_CALL_START;
        }
      }
    };
    static ClassOf(c) {
      let _source0 = c;
      {
        if (_source0.is_Lit) {
          return CacheKey.Cls.create_Any();
        }
      }
      {
        if (_source0.is_RunnerOs) {
          return CacheKey.Cls.create_Letters();
        }
      }
      {
        if (_source0.is_HashFiles) {
          return CacheKey.Cls.create_Hex();
        }
      }
      {
        let _0_v = (_source0).c;
        if (_dafny.areEqual(_0_v, CacheKey.CtxVar.create_Sha())) {
          return CacheKey.Cls.create_Hex();
        } else if (((_dafny.areEqual(_0_v, CacheKey.CtxVar.create_RunId())) || (_dafny.areEqual(_0_v, CacheKey.CtxVar.create_RunNumber()))) || (_dafny.areEqual(_0_v, CacheKey.CtxVar.create_RunAttempt()))) {
          return CacheKey.Cls.create_Digits();
        } else {
          return CacheKey.Cls.create_Any();
        }
      }
    };
    static FixedLen(c) {
      if (_dafny.areEqual(c, CacheKey.Comp.create_Ctx(CacheKey.CtxVar.create_Sha()))) {
        return new BigNumber(40);
      } else {
        return _dafny.ZERO;
      }
    };
    static InClass(k, ch) {
      let _source0 = k;
      {
        if (_source0.is_Letters) {
          return (((new _dafny.CodePoint('a'.codePointAt(0))).isLessThanOrEqual(ch)) && ((ch).isLessThanOrEqual(new _dafny.CodePoint('z'.codePointAt(0))))) || (((new _dafny.CodePoint('A'.codePointAt(0))).isLessThanOrEqual(ch)) && ((ch).isLessThanOrEqual(new _dafny.CodePoint('Z'.codePointAt(0)))));
        }
      }
      {
        if (_source0.is_Hex) {
          return (((new _dafny.CodePoint('0'.codePointAt(0))).isLessThanOrEqual(ch)) && ((ch).isLessThanOrEqual(new _dafny.CodePoint('9'.codePointAt(0))))) || (((new _dafny.CodePoint('a'.codePointAt(0))).isLessThanOrEqual(ch)) && ((ch).isLessThanOrEqual(new _dafny.CodePoint('f'.codePointAt(0)))));
        }
      }
      {
        if (_source0.is_Digits) {
          return ((new _dafny.CodePoint('0'.codePointAt(0))).isLessThanOrEqual(ch)) && ((ch).isLessThanOrEqual(new _dafny.CodePoint('9'.codePointAt(0))));
        }
      }
      {
        return true;
      }
    };
    static AllIn(k, s) {
      return _dafny.Quantifier(_dafny.IntegerRange(_dafny.ZERO, new BigNumber((s).length)), true, function (_forall_var_0) {
        let _0_i = _forall_var_0;
        return !(((_dafny.ZERO).isLessThanOrEqualTo(_0_i)) && ((_0_i).isLessThan(new BigNumber((s).length)))) || (CacheKey.__default.InClass(k, (s)[_0_i]));
      });
    };
    static InDomain(c, v) {
      let _source0 = c;
      {
        if (_source0.is_Lit) {
          let _0_s = (_source0).s;
          return _dafny.areEqual(v, _0_s);
        }
      }
      {
        if (_source0.is_RunnerOs) {
          return ((_dafny.areEqual(v, _dafny.Seq.UnicodeFromString("Linux"))) || (_dafny.areEqual(v, _dafny.Seq.UnicodeFromString("Windows")))) || (_dafny.areEqual(v, _dafny.Seq.UnicodeFromString("macOS")));
        }
      }
      {
        if (_source0.is_HashFiles) {
          return (((new BigNumber((v).length)).isEqualTo(_dafny.ZERO)) || ((new BigNumber((v).length)).isEqualTo(new BigNumber(64)))) && (CacheKey.__default.AllIn(CacheKey.Cls.create_Hex(), v));
        }
      }
      {
        let _1_x = (_source0).c;
        if (_dafny.areEqual(_1_x, CacheKey.CtxVar.create_Sha())) {
          return ((new BigNumber((v).length)).isEqualTo(new BigNumber(40))) && (CacheKey.__default.AllIn(CacheKey.Cls.create_Hex(), v));
        } else if (((_dafny.areEqual(_1_x, CacheKey.CtxVar.create_RunId())) || (_dafny.areEqual(_1_x, CacheKey.CtxVar.create_RunNumber()))) || (_dafny.areEqual(_1_x, CacheKey.CtxVar.create_RunAttempt()))) {
          return ((_dafny.ZERO).isLessThan(new BigNumber((v).length))) && (CacheKey.__default.AllIn(CacheKey.Cls.create_Digits(), v));
        } else {
          return true;
        }
      }
    };
    static WF(t, r) {
      return _dafny.Quantifier(_dafny.IntegerRange(_dafny.ZERO, new BigNumber((t).length)), true, function (_forall_var_0) {
        let _0_i = _forall_var_0;
        return !(((_dafny.ZERO).isLessThanOrEqualTo(_0_i)) && ((_0_i).isLessThan(new BigNumber((t).length)))) || (CacheKey.__default.InDomain((t)[_0_i], CacheKey.__default.Val((t)[_0_i], r)));
      });
    };
    static SepHead(t) {
      return (((((t)[_dafny.ZERO]).is_Lit) || ((_dafny.ZERO).isLessThan(CacheKey.__default.FixedLen((t)[_dafny.ZERO])))) || ((new BigNumber((t).length)).isEqualTo(_dafny.ONE))) || ((((((t)[_dafny.ONE]).is_Lit) && ((_dafny.ZERO).isLessThan(new BigNumber((((t)[_dafny.ONE]).dtor_s).length)))) && (!_dafny.areEqual(CacheKey.__default.ClassOf((t)[_dafny.ZERO]), CacheKey.Cls.create_Any()))) && (!(CacheKey.__default.InClass(CacheKey.__default.ClassOf((t)[_dafny.ZERO]), (((t)[_dafny.ONE]).dtor_s)[_dafny.ZERO]))));
    };
    static Separated(t) {
      return ((new BigNumber((t).length)).isEqualTo(_dafny.ZERO)) || ((CacheKey.__default.SepHead(t)) && (CacheKey.__default.Separated((t).slice(_dafny.ONE))));
    };
    static CompOf(d) {
      let _source0 = d;
      {
        if (_source0.is_DOs) {
          return CacheKey.Comp.create_RunnerOs();
        }
      }
      {
        if (_source0.is_DFiles) {
          let _0_id = (_source0).id;
          return CacheKey.Comp.create_HashFiles(_0_id);
        }
      }
      {
        let _1_c = (_source0).c;
        return CacheKey.Comp.create_Ctx(_1_c);
      }
    };
    static DepsEq(deps, r1, r2) {
      return _dafny.Quantifier((deps).Elements, true, function (_forall_var_0) {
        let _0_d = _forall_var_0;
        return !((deps).contains(_0_d)) || (_dafny.areEqual(CacheKey.__default.Val(CacheKey.__default.CompOf(_0_d), r1), CacheKey.__default.Val(CacheKey.__default.CompOf(_0_d), r2)));
      });
    };
    static KeyEq(t, r1, r2) {
      return _dafny.areEqual(CacheKey.__default.Render(t, r1), CacheKey.__default.Render(t, r2));
    };
    static Covers(t, deps) {
      return _dafny.Quantifier((deps).Elements, true, function (_forall_var_0) {
        let _0_d = _forall_var_0;
        return !((deps).contains(_0_d)) || (_dafny.Seq.contains(t, CacheKey.__default.CompOf(_0_d)));
      });
    };
    static Determined(t, deps) {
      return _dafny.Quantifier(_dafny.IntegerRange(_dafny.ZERO, new BigNumber((t).length)), true, function (_forall_var_0) {
        let _0_i = _forall_var_0;
        return !(((_dafny.ZERO).isLessThanOrEqualTo(_0_i)) && ((_0_i).isLessThan(new BigNumber((t).length)))) || ((((t)[_0_i]).is_Lit) || (_dafny.Quantifier((deps).Elements, false, function (_exists_var_0) {
          let _1_d = _exists_var_0;
          return ((deps).contains(_1_d)) && (_dafny.areEqual(CacheKey.__default.CompOf(_1_d), (t)[_0_i]));
        })));
      });
    };
    static Norm(t) {
      if ((new BigNumber((t).length)).isEqualTo(_dafny.ZERO)) {
        return _dafny.Seq.of();
      } else {
        let _0_rest = CacheKey.__default.Norm((t).slice(_dafny.ONE));
        if (((t)[_dafny.ZERO]).is_Lit) {
          if ((new BigNumber((((t)[_dafny.ZERO]).dtor_s).length)).isEqualTo(_dafny.ZERO)) {
            return _0_rest;
          } else if (((_dafny.ZERO).isLessThan(new BigNumber((_0_rest).length))) && (((_0_rest)[_dafny.ZERO]).is_Lit)) {
            return _dafny.Seq.Concat(_dafny.Seq.of(CacheKey.Comp.create_Lit(_dafny.Seq.Concat(((t)[_dafny.ZERO]).dtor_s, ((_0_rest)[_dafny.ZERO]).dtor_s))), (_0_rest).slice(_dafny.ONE));
          } else {
            return _dafny.Seq.Concat(_dafny.Seq.of((t)[_dafny.ZERO]), _0_rest);
          }
        } else {
          return _dafny.Seq.Concat(_dafny.Seq.of((t)[_dafny.ZERO]), _0_rest);
        }
      }
    };
    static DSet(deps) {
      return function () {
        let _coll0 = new _dafny.Set();
        for (const _compr_0 of (deps).Elements) {
          let _0_e = _compr_0;
          if (_dafny.Seq.contains(deps, _0_e)) {
            _coll0.add(_0_e);
          }
        }
        return _coll0;
      }();
    };
    static DepOf(c) {
      let _source0 = c;
      {
        if (_source0.is_RunnerOs) {
          return CacheKey.Dep.create_DOs();
        }
      }
      {
        if (_source0.is_HashFiles) {
          let _0_id = (_source0).id;
          return CacheKey.Dep.create_DFiles(_0_id);
        }
      }
      {
        let _1_x = (_source0).c;
        return CacheKey.Dep.create_DCtx(_1_x);
      }
    };
    static FirstUnsep(t) {
      if ((new BigNumber((t).length)).isEqualTo(_dafny.ZERO)) {
        return _dafny.ZERO;
      } else if (!(CacheKey.__default.SepHead(t))) {
        return _dafny.ZERO;
      } else {
        let _0_k = CacheKey.__default.FirstUnsep((t).slice(_dafny.ONE));
        return (_0_k).plus(_dafny.ONE);
      }
    };
    static Uncovered(t, deps) {
      if ((new BigNumber((deps).length)).isEqualTo(_dafny.ZERO)) {
        return _dafny.Seq.of();
      } else {
        let _0_rest = CacheKey.__default.Uncovered(t, (deps).slice(_dafny.ONE));
        if (_dafny.Seq.contains(t, CacheKey.__default.CompOf((deps)[_dafny.ZERO]))) {
          return _0_rest;
        } else {
          return _dafny.Seq.Concat(_dafny.Seq.of((deps)[_dafny.ZERO]), _0_rest);
        }
      }
    };
    static Undetermined(t, deps) {
      if ((new BigNumber((t).length)).isEqualTo(_dafny.ZERO)) {
        return _dafny.Seq.of();
      } else {
        let _0_rest = CacheKey.__default.Undetermined((t).slice(_dafny.ONE), deps);
        if ((((t)[_dafny.ZERO]).is_Lit) || (_dafny.Seq.contains(deps, CacheKey.__default.DepOf((t)[_dafny.ZERO])))) {
          return _0_rest;
        } else {
          return _dafny.Seq.Concat(_dafny.Seq.of((t)[_dafny.ZERO]), _0_rest);
        }
      }
    };
    static Classify(t, deps) {
      let _0_n = CacheKey.__default.Norm(t);
      let _1_k = CacheKey.__default.FirstUnsep(_0_n);
      if ((_1_k).isLessThan(new BigNumber((_0_n).length))) {
        return CacheKey.Verdict.create_Unsupported(_1_k);
      } else {
        return CacheKey.Verdict.create_Checked(CacheKey.__default.Uncovered(_0_n, deps), CacheKey.__default.Undetermined(_0_n, deps));
      }
    };
    static Prune(t, deps) {
      if ((new BigNumber((t).length)).isEqualTo(_dafny.ZERO)) {
        return _dafny.Seq.of();
      } else {
        let _0_rest = CacheKey.__default.Prune((t).slice(_dafny.ONE), deps);
        if ((((t)[_dafny.ZERO]).is_Lit) || (_dafny.Seq.contains(deps, CacheKey.__default.DepOf((t)[_dafny.ZERO])))) {
          return _dafny.Seq.Concat(_dafny.Seq.of((t)[_dafny.ZERO]), _0_rest);
        } else {
          return _0_rest;
        }
      }
    };
    static Recommend(t, deps) {
      return CacheKey.__default.Norm(CacheKey.__default.Prune(t, deps));
    };
    static Rep(ch, n) {
      return _dafny.Seq.Create(n, ((_0_ch) => function (_1___v3) {
        return _0_ch;
      })(ch));
    };
    static BaseCtx() {
      return _dafny.Map.Empty.slice().updateUnsafe(CacheKey.CtxVar.create_Sha(),CacheKey.__default.Rep(new _dafny.CodePoint('0'.codePointAt(0)), new BigNumber(40))).updateUnsafe(CacheKey.CtxVar.create_RunId(),_dafny.Seq.UnicodeFromString("1")).updateUnsafe(CacheKey.CtxVar.create_RunNumber(),_dafny.Seq.UnicodeFromString("1")).updateUnsafe(CacheKey.CtxVar.create_RunAttempt(),_dafny.Seq.UnicodeFromString("1"));
    };
    static Base() {
      return CacheKey.Run.create_Run(_dafny.Seq.UnicodeFromString("Linux"), _dafny.Map.Empty.slice(), CacheKey.__default.BaseCtx());
    };
    static AltCtx(x) {
      if (_dafny.areEqual(x, CacheKey.CtxVar.create_Sha())) {
        return CacheKey.__default.Rep(new _dafny.CodePoint('1'.codePointAt(0)), new BigNumber(40));
      } else if (((_dafny.areEqual(x, CacheKey.CtxVar.create_RunId())) || (_dafny.areEqual(x, CacheKey.CtxVar.create_RunNumber()))) || (_dafny.areEqual(x, CacheKey.CtxVar.create_RunAttempt()))) {
        return _dafny.Seq.UnicodeFromString("2");
      } else {
        return _dafny.Seq.UnicodeFromString("x");
      }
    };
    static Vary(d) {
      let _source0 = d;
      {
        if (_source0.is_DOs) {
          let _0_dt__update__tmp_h0 = CacheKey.__default.Base();
          let _1_dt__update_hos_h0 = _dafny.Seq.UnicodeFromString("Windows");
          return CacheKey.Run.create_Run(_1_dt__update_hos_h0, (_0_dt__update__tmp_h0).dtor_files, (_0_dt__update__tmp_h0).dtor_ctx);
        }
      }
      {
        if (_source0.is_DFiles) {
          let _2_id = (_source0).id;
          let _3_dt__update__tmp_h1 = CacheKey.__default.Base();
          let _4_dt__update_hfiles_h0 = _dafny.Map.Empty.slice().updateUnsafe(_2_id,CacheKey.__default.Rep(new _dafny.CodePoint('a'.codePointAt(0)), new BigNumber(64)));
          return CacheKey.Run.create_Run((_3_dt__update__tmp_h1).dtor_os, _4_dt__update_hfiles_h0, (_3_dt__update__tmp_h1).dtor_ctx);
        }
      }
      {
        let _5_x = (_source0).c;
        let _6_dt__update__tmp_h2 = CacheKey.__default.Base();
        let _7_dt__update_hctx_h0 = (CacheKey.__default.BaseCtx()).update(_5_x, CacheKey.__default.AltCtx(_5_x));
        return CacheKey.Run.create_Run((_6_dt__update__tmp_h2).dtor_os, (_6_dt__update__tmp_h2).dtor_files, _7_dt__update_hctx_h0);
      }
    };
  };

  $module.CtxVar = class CtxVar {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Sha() {
      let $dt = new CtxVar(0);
      return $dt;
    }
    static create_RunId() {
      let $dt = new CtxVar(1);
      return $dt;
    }
    static create_RunNumber() {
      let $dt = new CtxVar(2);
      return $dt;
    }
    static create_RunAttempt() {
      let $dt = new CtxVar(3);
      return $dt;
    }
    static create_Ref() {
      let $dt = new CtxVar(4);
      return $dt;
    }
    static create_EventName() {
      let $dt = new CtxVar(5);
      return $dt;
    }
    get is_Sha() { return this.$tag === 0; }
    get is_RunId() { return this.$tag === 1; }
    get is_RunNumber() { return this.$tag === 2; }
    get is_RunAttempt() { return this.$tag === 3; }
    get is_Ref() { return this.$tag === 4; }
    get is_EventName() { return this.$tag === 5; }
    static get AllSingletonConstructors() {
      return this.AllSingletonConstructors_();
    }
    static *AllSingletonConstructors_() {
      yield CtxVar.create_Sha();
      yield CtxVar.create_RunId();
      yield CtxVar.create_RunNumber();
      yield CtxVar.create_RunAttempt();
      yield CtxVar.create_Ref();
      yield CtxVar.create_EventName();
    }
    toString() {
      if (this.$tag === 0) {
        return "CacheKey.CtxVar.Sha";
      } else if (this.$tag === 1) {
        return "CacheKey.CtxVar.RunId";
      } else if (this.$tag === 2) {
        return "CacheKey.CtxVar.RunNumber";
      } else if (this.$tag === 3) {
        return "CacheKey.CtxVar.RunAttempt";
      } else if (this.$tag === 4) {
        return "CacheKey.CtxVar.Ref";
      } else if (this.$tag === 5) {
        return "CacheKey.CtxVar.EventName";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0;
      } else if (this.$tag === 1) {
        return other.$tag === 1;
      } else if (this.$tag === 2) {
        return other.$tag === 2;
      } else if (this.$tag === 3) {
        return other.$tag === 3;
      } else if (this.$tag === 4) {
        return other.$tag === 4;
      } else if (this.$tag === 5) {
        return other.$tag === 5;
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return CacheKey.CtxVar.create_Sha();
    }
    static Rtd() {
      return class {
        static get Default() {
          return CtxVar.Default();
        }
      };
    }
  }

  $module.Comp = class Comp {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Lit(s) {
      let $dt = new Comp(0);
      $dt.s = s;
      return $dt;
    }
    static create_RunnerOs() {
      let $dt = new Comp(1);
      return $dt;
    }
    static create_HashFiles(id) {
      let $dt = new Comp(2);
      $dt.id = id;
      return $dt;
    }
    static create_Ctx(c) {
      let $dt = new Comp(3);
      $dt.c = c;
      return $dt;
    }
    get is_Lit() { return this.$tag === 0; }
    get is_RunnerOs() { return this.$tag === 1; }
    get is_HashFiles() { return this.$tag === 2; }
    get is_Ctx() { return this.$tag === 3; }
    get dtor_s() { return this.s; }
    get dtor_id() { return this.id; }
    get dtor_c() { return this.c; }
    toString() {
      if (this.$tag === 0) {
        return "CacheKey.Comp.Lit" + "(" + this.s.toVerbatimString(true) + ")";
      } else if (this.$tag === 1) {
        return "CacheKey.Comp.RunnerOs";
      } else if (this.$tag === 2) {
        return "CacheKey.Comp.HashFiles" + "(" + _dafny.toString(this.id) + ")";
      } else if (this.$tag === 3) {
        return "CacheKey.Comp.Ctx" + "(" + _dafny.toString(this.c) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0 && _dafny.areEqual(this.s, other.s);
      } else if (this.$tag === 1) {
        return other.$tag === 1;
      } else if (this.$tag === 2) {
        return other.$tag === 2 && _dafny.areEqual(this.id, other.id);
      } else if (this.$tag === 3) {
        return other.$tag === 3 && _dafny.areEqual(this.c, other.c);
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return CacheKey.Comp.create_Lit(_dafny.Seq.UnicodeFromString(""));
    }
    static Rtd() {
      return class {
        static get Default() {
          return Comp.Default();
        }
      };
    }
  }

  $module.Dep = class Dep {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_DOs() {
      let $dt = new Dep(0);
      return $dt;
    }
    static create_DFiles(id) {
      let $dt = new Dep(1);
      $dt.id = id;
      return $dt;
    }
    static create_DCtx(c) {
      let $dt = new Dep(2);
      $dt.c = c;
      return $dt;
    }
    get is_DOs() { return this.$tag === 0; }
    get is_DFiles() { return this.$tag === 1; }
    get is_DCtx() { return this.$tag === 2; }
    get dtor_id() { return this.id; }
    get dtor_c() { return this.c; }
    toString() {
      if (this.$tag === 0) {
        return "CacheKey.Dep.DOs";
      } else if (this.$tag === 1) {
        return "CacheKey.Dep.DFiles" + "(" + _dafny.toString(this.id) + ")";
      } else if (this.$tag === 2) {
        return "CacheKey.Dep.DCtx" + "(" + _dafny.toString(this.c) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0;
      } else if (this.$tag === 1) {
        return other.$tag === 1 && _dafny.areEqual(this.id, other.id);
      } else if (this.$tag === 2) {
        return other.$tag === 2 && _dafny.areEqual(this.c, other.c);
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return CacheKey.Dep.create_DOs();
    }
    static Rtd() {
      return class {
        static get Default() {
          return Dep.Default();
        }
      };
    }
  }

  $module.Run = class Run {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Run(os, files, ctx) {
      let $dt = new Run(0);
      $dt.os = os;
      $dt.files = files;
      $dt.ctx = ctx;
      return $dt;
    }
    get is_Run() { return this.$tag === 0; }
    get dtor_os() { return this.os; }
    get dtor_files() { return this.files; }
    get dtor_ctx() { return this.ctx; }
    toString() {
      if (this.$tag === 0) {
        return "CacheKey.Run.Run" + "(" + this.os.toVerbatimString(true) + ", " + _dafny.toString(this.files) + ", " + _dafny.toString(this.ctx) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0 && _dafny.areEqual(this.os, other.os) && _dafny.areEqual(this.files, other.files) && _dafny.areEqual(this.ctx, other.ctx);
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return CacheKey.Run.create_Run(_dafny.Seq.UnicodeFromString(""), _dafny.Map.Empty, _dafny.Map.Empty);
    }
    static Rtd() {
      return class {
        static get Default() {
          return Run.Default();
        }
      };
    }
  }

  $module.Cls = class Cls {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Letters() {
      let $dt = new Cls(0);
      return $dt;
    }
    static create_Hex() {
      let $dt = new Cls(1);
      return $dt;
    }
    static create_Digits() {
      let $dt = new Cls(2);
      return $dt;
    }
    static create_Any() {
      let $dt = new Cls(3);
      return $dt;
    }
    get is_Letters() { return this.$tag === 0; }
    get is_Hex() { return this.$tag === 1; }
    get is_Digits() { return this.$tag === 2; }
    get is_Any() { return this.$tag === 3; }
    static get AllSingletonConstructors() {
      return this.AllSingletonConstructors_();
    }
    static *AllSingletonConstructors_() {
      yield Cls.create_Letters();
      yield Cls.create_Hex();
      yield Cls.create_Digits();
      yield Cls.create_Any();
    }
    toString() {
      if (this.$tag === 0) {
        return "CacheKey.Cls.Letters";
      } else if (this.$tag === 1) {
        return "CacheKey.Cls.Hex";
      } else if (this.$tag === 2) {
        return "CacheKey.Cls.Digits";
      } else if (this.$tag === 3) {
        return "CacheKey.Cls.Any";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0;
      } else if (this.$tag === 1) {
        return other.$tag === 1;
      } else if (this.$tag === 2) {
        return other.$tag === 2;
      } else if (this.$tag === 3) {
        return other.$tag === 3;
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return CacheKey.Cls.create_Letters();
    }
    static Rtd() {
      return class {
        static get Default() {
          return Cls.Default();
        }
      };
    }
  }

  $module.Verdict = class Verdict {
    constructor(tag) {
      this.$tag = tag;
    }
    static create_Unsupported(at) {
      let $dt = new Verdict(0);
      $dt.at = at;
      return $dt;
    }
    static create_Checked(uncovered, undetermined) {
      let $dt = new Verdict(1);
      $dt.uncovered = uncovered;
      $dt.undetermined = undetermined;
      return $dt;
    }
    get is_Unsupported() { return this.$tag === 0; }
    get is_Checked() { return this.$tag === 1; }
    get dtor_at() { return this.at; }
    get dtor_uncovered() { return this.uncovered; }
    get dtor_undetermined() { return this.undetermined; }
    toString() {
      if (this.$tag === 0) {
        return "CacheKey.Verdict.Unsupported" + "(" + _dafny.toString(this.at) + ")";
      } else if (this.$tag === 1) {
        return "CacheKey.Verdict.Checked" + "(" + _dafny.toString(this.uncovered) + ", " + _dafny.toString(this.undetermined) + ")";
      } else  {
        return "<unexpected>";
      }
    }
    equals(other) {
      if (this === other) {
        return true;
      } else if (this.$tag === 0) {
        return other.$tag === 0 && _dafny.areEqual(this.at, other.at);
      } else if (this.$tag === 1) {
        return other.$tag === 1 && _dafny.areEqual(this.uncovered, other.uncovered) && _dafny.areEqual(this.undetermined, other.undetermined);
      } else  {
        return false; // unexpected
      }
    }
    static Default() {
      return CacheKey.Verdict.create_Unsupported(_dafny.ZERO);
    }
    static Rtd() {
      return class {
        static get Default() {
          return Verdict.Default();
        }
      };
    }
  }
  return $module;
})(); // end of module CacheKey
let _module = (function() {
  let $module: any = {};

  return $module;
})(); // end of module _module

export { _dafny as Dafny, CacheKey, Selection, Policy, CiPolicy };
