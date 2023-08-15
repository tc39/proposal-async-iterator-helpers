'use strict';

const mapKind = Symbol('map');
const filterKind = Symbol('filter');

const kinds = new Set([mapKind, filterKind]);

const assertUnreachable = () => {
  console.error('UNREACHABLE');
  assert(false);
};

const assert = cond => {
  if (cond) return;
  let err = new Error('assert failed');
  console.error(err);
  if (process) {
    process.exit(1);
  } else {
    debugger;
    // this can get caught, so better to panic if possible
    throw err;
  }
};

class AsyncIteratorHelpers extends AsyncIterator {
  #kind;
  #helper;

  constructor(kind, underlying, ...args) {
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
    this.#helper = new HelperCtor(this, underlying, ...args);
  }
  
  next() {
    return this.#helper.next();
  }
  
  // TODO return  
}

// in actual spec these are just AOs
// but it's convenient to write this way in JS
// this class requires subclasses to define `async startJob`
class BaseHelper {
  done = false;
  // job status: running | value | threw | done
  jobs = [];
  // invariant: capabilities.length === jobs.length
  // they are not combined because, think about filter when an item is not selected
  capabilities = [];

  next() {
    if (this.done) {
      return Promise.resolve({ done: true, value: undefined });
    }
    let resolve, reject;
    let promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.capabilities.push({ resolve, reject });
    this.startJob();
    return promise;
  }

  finishedAt(job) {
    this.done = true;
    let index = this.jobs.indexOf(job);
    assert(index !== -1);
    assert(job.status === 'threw' || job.status === 'done');

    // we can't immediately complete `threw` jobs, because that exception might get swalled by an earlier one or an earlier { done: true }
    let firstJobToClose = job.status === 'done' ? index : index + 1;
    for (let i = firstJobToClose; i < this.jobs.length; ++i) {
      this.jobs[i].status = 'done';
      this.capabilities[i].resolve({ done: true, value: undefined });
    }
    this.jobs.length = firstJobToClose;
    this.capabilities.length = firstJobToClose;

    // todo maybe hoist this to relevant callers
    this.maybeDrain();
  }

  // this should be invoked after any operation which may have caused the job at the head of the queue to be no longer running
  maybeDrain() {
    while (this.jobs.length > 0 && this.jobs[0].status !== 'running') {
      let job = this.jobs.shift();
      let { resolve, reject } = this.capabilities.shift();
      switch (job.status) {
        case 'value': {
          resolve({ done: false, value: job.value });
          break;
        }
        case 'threw': {
          reject(job.value);
          assert(this.jobs.length === 0); // we should have cleared out all subsequent jobs when adding this one
          return;
        }
        case 'done': {
          assert('unreachable');
          return;
        }
      }
    }
  }
}

// not exposed
class MapHelper extends BaseHelper {
  #self;
  #underlying;
  #fn;

  #counter = 0;

  constructor(self, underlying, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('map expects a function');
    }
    super();
    this.#self = self;
    this.#underlying = underlying;
    this.#fn = fn;
  }

  async startJob() {
    let job = { status: 'running', value: undefined };
    this.jobs.push(job);
    let counter = this.#counter++;
    let value, done;
    try {
      ({ done, value} = await this.#underlying.next());
    } catch (e) {
      if (job.status === 'done') return;
      assert(job.status === 'running');

      // underlying iterator threw or violated the protocol, so no need to close it

      job.status = 'threw';
      job.value = e;
      this.finishedAt(job);
      return;
    }
    if (done) {
      if (job.status === 'done') return;
      assert(job.status === 'running');

      job.status = 'done';
      this.finishedAt(job);
      return;
    }
    let mapped;
    try {
      mapped = this.#fn(value, counter);
      if (isAnObject(mapped)) {
        mapped = await mapped;
      }
    } catch (e) {
      if (job.status === 'done') return;
      assert(job.status === 'running');

      // TODO close underlying here

      job.status = 'threw';
      job.value = e;
      this.finishedAt(job);
      return;
    }
    if (job.status === 'done') return;
    assert(job.status === 'running');

    job.status = 'value';
    job.value = mapped;
    this.maybeDrain();
  }
}

// not exposed
class FilterHelper extends BaseHelper {
  #self;
  #underlying;
  #predicate;

  #counter = 0;

  constructor(self, underlying, predicate) {
    if (typeof predicate !== 'function') {
      throw new TypeError('filter expects a function');
    }
    super();
    this.#self = self;
    this.#underlying = underlying;
    this.#predicate = predicate;
  }

  async startJob() {
    let job = { status: 'running', value: undefined };
    this.jobs.push(job);
    let counter = this.#counter++;
    let value, done;
    try {
      ({ done, value} = await this.#underlying.next());
    } catch (e) {
      if (job.status === 'done') return;
      assert(job.status === 'running');

      // underlying iterator threw or violated the protocol, so no need to close it

      job.status = 'threw';
      job.value = e;
      this.finishedAt(job);
      return;
    }
    if (done) {
      if (job.status === 'done') return;
      assert(job.status === 'running');

      job.status = 'done';
      this.finishedAt(job);
      return;
    }
    let selected;
    try {
      selected = this.#predicate(value, counter);
    } catch (e) {
      if (job.status === 'done') return;
      assert(job.status === 'running');

      // TODO close underlying here

      job.status = 'threw';
      job.value = e;
      this.finishedAt(job);
      return;
    }
    if (job.status === 'done') return;
    assert(job.status === 'running');

    if (selected) {
      job.status = 'value';
      job.value = value;
    } else {
      this.jobs.splice(this.jobs.indexOf(job), 1);
      this.startJob();
    }
    this.maybeDrain();
  }
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
      let underlyingResult = await method.call(iterator)
      if (!isAnObject(underlyingResult)) {
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
// iter = AsyncIterator.from([0, 1]).map(async x => (await sleep(1000 - 500 * x), x + 1));
// iter.next().then(console.log);
// iter.next().then(console.log);
// iter.next().then(console.log);
// iter.next().then(console.log);


iter = AsyncIterator.from([1, 3, 2, 3.1, 1.1]).map(async x => {
  console.log('starting to wait for', x);
  await sleep(x/2 * 1000);
  console.log('done waiting for', x);
  return x;
}).filter(x => {
  // if (x === 3.1) { throw new Error('predicate throws for 3.1'); }
  return x > 1;
});
iter.next().then(console.log, console.log);
iter.next().then(console.log, console.log);
iter.next().then(console.log, console.log);
iter.next().then(console.log, console.log);
iter.next().then(console.log, console.log);
