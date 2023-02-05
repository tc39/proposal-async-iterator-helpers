'use strict';

let mapKind = Symbol('map');
let filterKind = Symbol('map');

let kinds = new Set([mapKind, filterKind]);

const assertUnreachable = () => { throw new Error('UNREACHABLE'); };

class AsyncIteratorHelpers extends AsyncIterator {
  #kind;
  #helper;

  constructor(kind, inner, ...args) {
    if (!kinds.has(kind)) {
      throw new TypeError('AsyncIteratorHelpers is not constructible');
    }
    super();
    this.#kind = kind;
    let HelperCtor;
    switch (kind) {
      case mapKind: {
        HelperCtor = MapHelper;
        break;
      }
      case filterKind: {
        HelperCtor = FilterHelper;
        break;
      }
    }
    this.#helper = new HelperCtor(this, inner, ...args);
  }
  
  next() {
    return this.#helper.next();
  }
  
  // TODO return  
}

// in real life this is inlined via IfAbruptCloseAsyncIterator, and so incurs at most one `await`
// right now the result of this needs to be `await`'d, so it can incur 2
// https://tc39.es/ecma262/multipage/abstract-operations.html#sec-asynciteratorclose
async function asyncIteratorClose(iterator, completion) {
  try {
    let method = iterator.return;
    if (method != null && typeof method !== 'function') {
      throw new TypeError('iterator "return" is not a method');
    }
    if (method != null) {
      let innerResult = await method.call(iterator)
      if (!isAnObject(innerResult)) {
        throw new TypeError('"return" must return an object');
      }
    }
  } finally {
    if (completion.type === 'throw') {
      throw completion.value;
    }
  }
  return completion.value;
}

function isAnObject(o) {
  return o !== null && (typeof o === 'object' || typeof o === 'function');
}

// https://tc39.es/proposal-iterator-helpers/#sec-getiteratorflattenable
function getIteratorFlattenable(obj, hint) {
  if (!isAnObject(obj)) {
    throw new TypeError('getIteratorFlattenable expects a string or object');
  }
  let alreadyAsync = false;
  let method = undefined;
  if (hint === 'async') {
    method = obj[Symbol.asyncIterator];
    alreadyAsync = true;
  }
  if (typeof method !== 'function') {
    method = obj[Symbol.iterator];
    alreadyAsync = false;
  }
  let iterator;
  if (typeof method !== 'function') {
    iterator = obj;
    alreadyAsync = false;
  } else {
    iterator = method.call(obj);
  }
  if (!isAnObject(iterator)) {
    throw new TypeError('could not find iterator');
  }
  let next = iterator.next;
  if (typeof next !== 'function') {
    throw new TypeError('next property is not callable');
  }
  let iteratorRecord = { iterator, nextMethod: next, done: false };
  if (hint === 'async' && !alreadyAsync) {
    let asyncIterator = new AsyncFromSyncIterator(iteratorRecord);
    return { iterator: asyncIterator, nextMethod: asyncIterator.next, done: false };
  }
  return iteratorRecord;
}

// not exposed
// https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-%asyncfromsynciteratorprototype%-object
class AsyncFromSyncIterator {
  #syncIteratorRecord;

  constructor(iteratorRecord) {
    this.#syncIteratorRecord = iteratorRecord;
  }
  
  async next(v) {
    let result = arguments.length === 0
      ? this.#syncIteratorRecord.nextMethod.call(this.#syncIteratorRecord.iterator, v)
      : this.#syncIteratorRecord.nextMethod.call(this.#syncIteratorRecord.iterator);
    let { done, value } = result;
    value = await value;
    return { done, value };
  }

  // TODO return
}


let internalMarker = Symbol();

// the prototype of this class is exposed, though in real life instances will not have a constructor property
class WrapForValidAsyncIterator extends AsyncIterator {
  #asyncIterated;

  constructor(marker, asyncIterated) {
    if (marker !== internalMarker) {
      throw new TypeError('WrapForValidAsyncIterator is not constructible');
    }
    super();
    this.#asyncIterated = asyncIterated;
  }
  
  async next() {
    return this.#asyncIterated.nextMethod.call(this.#asyncIterated.iterator);
  }
  
  // TODO return
}

// helpers are not exposed
class MapHelper {
  #self;
  #inner;
  #fn;

  #done = false; // once this becomes true, subsequent calls to .next() will always return { done: true, value: undefined }
  #mostRecentlyReturnedPromise = null;
  #counter = 0;

  constructor(self, inner, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('map expects a function');
    }
    this.#self = self;
    this.#inner = inner;
    this.#fn = fn;
  }

  next() {
    let previousPromiseRejectedOrWasDone = false;
    let promise = new Promise(async (resolve, reject) => {
      if (this.#done) {
        resolve({ done: true, value: undefined });
        return;
      }
      let counter = this.#counter++;
      let done, value;
      try {
        ({ done, value} = await this.#inner.next());
      } catch (e) {
        if (previousPromiseRejectedOrWasDone) {
          resolve({ done: true, value: undefined });
          return;
        }
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
      let mapped;
      try {
        mapped = this.#fn(value, counter);
        // no interleaving point, so no need to check previousPromiseRejectedOrWasDone again
        // Set mapped to Completion(AwaitNonPrimitive(mapped))
        if (isAnObject(mapped)) {
          mapped = await mapped;
        }
      } catch (e) {
        if (previousPromiseRejectedOrWasDone) {
          resolve({ done: true, value: undefined });
          return;
        }
        this.#done = true;
        try {
          await asyncIteratorClose(this.#inner, { type: 'throw', value: e });
          assertUnreachable();
        } catch (e) {
          reject(e);
          return;
        }
      }
      if (previousPromiseRejectedOrWasDone) {
        resolve({ done: true, value: undefined });
        return;
      }
      resolve({ done: false, value: mapped });
    });
    if (this.#mostRecentlyReturnedPromise == null) {
      this.#mostRecentlyReturnedPromise = promise;
      return promise;
    } else {
      // this logic enforces that promises settle in order
      // that's a decision which (for .map in particular) could be made otherwise
      // TODO: decide if we want this
      let newPromise = this.#mostRecentlyReturnedPromise.then(
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
      this.#mostRecentlyReturnedPromise = newPromise;
      return newPromise;
    }
  }
}

class FilterHelper {
  #self;
  #inner;
  #predicate;

  #done = false; // once this becomes true, subsequent calls to .next() will always return { done: true, value: undefined }
  #counter = 0;
  // job items look like
  // { status: 'running' | 'value' | 'threw' | 'done', value: unknown }
  // with the `value` field meaningful only for the 'value' and 'threw' types
  // there is always exactly one job item per unsettled call to `.next`
  #jobs = [];
  // capabilities look like { resolve, reject }
  // there is always exactly one capability per unsettled call to `.next`
  // this list is only popped when the head of the job queue is no longer 'running'
  #capabilities = [];

  constructor(self, inner, predicate) {
    if (typeof predicate !== 'function') {
      throw new TypeError('map expects a function');
    }
    this.#self = self;
    this.#inner = inner;
    this.#predicate = predicate;
  }
  
  next() {
    let resolve, reject;
    // when Promise.build
    let promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.#capabilities.push({ resolve, reject });
    this.#startJob();
    return promise;
  }
  
  async #startJob() {
    if (this.#done) {
      this.#jobs.push({ status: 'done' });
      this.#maybeDrain();
      return;
    }

    let job = { status: 'running', value: null };
    this.#jobs.push(job);

    let counter = this.#counter++;
    let done, value;
    // TODO refactor so the try/catches are shared, I guess
    // though that's going to make mapping back to spec text harder...
    try {
      ({ done, value} = await this.#inner.next());
    } catch (e) {
      // inner iterator threw or violated the protocol, so no need to close it
      if (job.status === 'running') {
        job.status = 'threw';
        job.value = e;
        this.#finishedAt(job);
      } else if (job.status === 'done') {
        // already closed, nothing to do
      } else {
        assertUnreachable();
      }
      return;
    }
    if (done) {
      if (job.status === 'running') {
        this.#done = true;
        job.status = 'done';
        this.#finishedAt(job);
      } else if (job.status === 'done') {
        // already closed, nothing to do
      } else {
        assertUnreachable();
      }
      return;
    }
    let selected;
    try {
      selected = this.#predicate(value, counter);
      // Set result to Completion(AwaitNonPrimitive(selected))
      if (isAnObject(selected)) {
        selected = await selected;
      }
    } catch (e) {
      if (job.status === 'running') {
        job.status = 'threw';
        job.value = e;
        try {
          await asyncIteratorClose(this.#inner, { type: 'throw', value: e });
          assertUnreachable();
        } catch (e) {
          // ignored
        }
        this.#finishedAt(job);
      } else if (job.status === 'done') {
        // already closed, nothing to do
      } else {
        assertUnreachable();
      }
      return;
    }
    if (selected) {
      if (job.status === 'running') {
        job.status = 'value';
        job.value = value;
        this.#maybeDrain();
      } else if (job.status === 'done') {
        // already closed, nothing to do
      } else {
        assertUnreachable();
      }
    } else {
      if (job.status === 'running') {
        this.#jobs.splice(this.#jobs.indexOf(job), 1);
        this.#startJob();
        this.#maybeDrain();
      } else if (job.status === 'done') {
        // already closed, nothing to do
      } else {
        assertUnreachable();
      }
    }
  }
  
  #finishedAt(job) {
    this.#done = true;
    let index = this.#jobs.indexOf(job);
    for (let i = index + 1; i < this.#jobs.length; ++i) {
      this.#jobs[i].status = 'done';
    }
    this.#maybeDrain();
  }
  
  // this should be invoked after any operation which may have caused the job at the head of the queue to be no longer running
  #maybeDrain() {
    while (this.#jobs.length > 0 && this.#jobs[0].status !== 'running') {
      let job = this.#jobs.shift();
      let { resolve, reject } = this.#capabilities.shift();
      switch (job.status) {
        case 'value': {
          resolve({ done: false, value: job.value });
          break;
        }
        case 'threw': {
          reject(job.value);
          break;
        }
        case 'done': {
          resolve({ done: true, value: undefined });
          break;
        }
      }
    }
  }
}

// let AsyncIteratorProto = (async function*(){})().__proto__.__proto__.__proto__;

function AsyncIterator() {}
globalThis.AsyncIterator = AsyncIterator;

AsyncIterator.from = function from(obj) {
  if (typeof obj === 'string') {
    obj = Object(obj);
  }
  let iteratorRecord = getIteratorFlattenable(obj, 'async');
  if (iteratorRecord.iterator instanceof AsyncIterator) {
    return iteratorRecord.iterator;
  }
  return new WrapForValidAsyncIterator(internalMarker, iteratorRecord);
};

let AsyncIteratorProto = AsyncIterator.prototype;

AsyncIteratorProto.map = function(fn) {
  return new AsyncIteratorHelpers(mapKind, this, fn);
};

AsyncIteratorProto.filter = function(predicate) {
  return new AsyncIteratorHelpers(filterKind, this, predicate);
};



// TODO remove below here

let sleep = ms => new Promise(res => setTimeout(res, ms));

let iter;
// iter = AsyncIterator.from([0, 1]).map(async x => x + 1);
// iter.next().then(console.log);
// iter.next().then(console.log);
// iter.next().then(console.log);
// iter.next().then(console.log);

// note that all the `sleep` calls happen in parallel
// and the promises still resolve in order
// console.log('waiting for tasks of length 1, 3, 2, 1');
// iter = AsyncIterator.from([1, 3, 2, 1]).map(async x => {
//   console.log('starting to wait for', x);
//   await sleep(x/2 * 1000);
//   console.log('done waiting for', x);
//   return x;
// });
// iter.next().then(console.log);
// iter.next().then(console.log);
// iter.next().then(console.log);
// iter.next().then(console.log);
// iter.next().then(console.log);

// note that, since there are only 4 calls to .next, we don't start the 5th wait until the predicate for the first has failed
// also, even though the 1.1 job succeeds and passes the predicate before the throw triggered by 3.1, the corresponding call resolves to { done: true }
iter = AsyncIterator.from([1, 3, 2, 3.1, 1.1]).map(async x => {
  console.log('starting to wait for', x);
  await sleep(x/2 * 1000);
  console.log('done waiting for', x);
  return x;
}).filter(x => {
  if (x === 3.1) { throw new Error('predicate throws for 3.1'); }
  return x > 1;
});
iter.next().then(console.log, console.log);
iter.next().then(console.log, console.log);
iter.next().then(console.log, console.log);
iter.next().then(console.log, console.log);
sleep(3000).then(() => { console.log('triggering next after completion'); iter.next().then(console.log, console.log); });
