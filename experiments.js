'use strict';

let mapKind = Symbol('map');

let kinds = new Set([mapKind]);

const assertUnreachable = () => { throw new Error('UNREACHABLE'); };

class AsyncIteratorHelpers {
  #kind;
  #inner;
  #done = false; // once this becomes true, subsequent calls to .next() will always return { done: true, value: undefined }

  constructor(kind, inner, ...args) {
    if (!kinds.has(kind)) {
      throw new TypeError('AsyncIteratorHelpers is not constructible');
    }
    this.#kind = kind;
    this.#inner = inner;
    switch (kind) {
      case 'map': {
        this.#mapInit(...args);
        break;
      }
    }
  }
  
  // in real life this is inlined via IfAbruptCloseAsyncIterator, and so incurs at most one `await`
  // right now the result of this needs to be `await`'d, so it can incur 2
  // https://tc39.es/ecma262/multipage/abstract-operations.html#sec-asynciteratorclose
  async #closeInner({ type, value }) {
    try {
      let method = this.#inner.return;
      if (method != null && typeof method !== 'function') {
        throw new TypeError('inner iterator "return" is not a method');
      }
      if (method != null) {
        let innerResult = await method.call(this.#inner)
        if (innerResult == null || typeof innerResult !== 'object' && typeof innerResult !== 'function') {
          throw new TypeError('"return" must return an object');
        }
      }
    } finally {
      if (type === 'throw') {
        throw value;
      }
    }
    return value;
  }

  // ####### map
  #mapFn;
  #mapMostRecentlyReturnedPromise = null;
  #mapCounter = 0;

  #mapInit(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('map expects a function');
    }
    this.#mapFn = fn;
  }

  #mapNext() {
    if (this.#done) {
      return Promise.resolve({ done: true, value: undefined });
    }
    let previousPromiseRejectedOrWasDone = false;
    let promise = new Promise(async (resolve, reject) => {
      let counter = this.#mapCounter++;
      let { done, value };
      try {
        ({ done, value} = await this.#inner.next());
      } catch (e) {
        // inner iterator threw or violated the protocol, so no need to close it
        this.#done = true;
        reject(e);
        return;        
      }
      if (done) {
        this.#done = true;
      }
      if (done || previousPromiseRejectedOrWasDone) {
        resolve({ done: true, value: undefined });
        return;
      }
      try {
        let mapped = this.#mapFn(value, counter);
        // Set mapped to Completion(AwaitNonPrimitive(mapped))
        if (typeof mapped === 'function' || typeof mapped === 'object' && mapped !== null) {
          mapped = await mapped;
        }
        if (previousPromiseRejectedOrWasDone) {
          resolve({ done: true, value: undefined });
          return;
        }
        resolve({ done: false, value: mapped });
      } catch (e) {
        if (previousPromiseRejectedOrWasDone) {
          resolve({ done: true, value: undefined });
          return;
        }
        this.#done = true;
        try {
          await this.#closeInner({ type: 'throw', value: e });
          assertUnreachable();
        } catch (e) {
          reject(e);        
        }
      }
    });
    if (this.#mapMostRecentlyReturnedPromise == null) {
      this.#mapMostRecentlyReturnedPromise = promise;
      return promise;
    } else {
      // this logic enforces that promises settle in order
      // that's a decision which (for .map in particular) could be made otherwise
      // TODO: decide if we want this
      let newPromise = this.#mapMostRecentlyReturnedPromise.then(
        ({ done }) => {
          if (done) {
            previousPromiseRejectedOrWasDone = true;
            return { done: true, value: undefined };
          }
          return promise;
        },
        err => {
          previousPromiseRejectedOrWasDone = true;
          return { done: true, value: undefined };
        },
      );
      this.#mapMostRecentlyReturnedPromise = newPromise;
      return newPromise;
    }
  }

  next() {
    switch (this.#kind) {
      case 'map': {
        return this.#mapNext();
      }
      default: {
        throw new TypeError('AsyncIteratorHelpers.prototype.next called on incompatible receiver');
      }
    }
  }
}


let AsyncIteratorProto = (async function*(){})().__proto__.__proto__.__proto__;

AsyncIteratorProto.map = function(fn) {
  return new AsyncIteratorHelpers(mapKind, this, fn);
};
