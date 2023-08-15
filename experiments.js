'use strict';

// TODO fix up this values for mappers/predicates
const mapKind = Symbol('map');
const filterKind = Symbol('map');

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

// TODO ensure helper are devensive against `underlying.next()` sync throwing


/*
Say that an iterator is race-free if it gives the same results in the same order regardless of whether calls to its `.next` method happen simultaneously or in sequence.
Note that this is a very weak property: an iterator can do stuff like returning [{ done: true }, { done: false }] and still be race-free.

The fundamental consistency property of iterator helpers is that as long as the underlying iterator(s) are race-free and the mapping function (if any) is pure, the resulting iterator is race-free.
(Also assumes no shared state between underlying iterators, in the case of flatMap.)
*/

// helpers are not exposed
class MapHelper {
  #self;
  #underlying;
  #fn;

  #done = false; // once this becomes true, subsequent calls to .next() will always return { done: true, value: undefined }
  #mostRecentlyReturnedPromise = null;
  #counter = 0;

  constructor(self, underlying, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('map expects a function');
    }
    this.#self = self;
    this.#underlying = underlying;
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
        ({ done, value} = await this.#underlying.next());
      } catch (e) {
        if (previousPromiseRejectedOrWasDone) {
          resolve({ done: true, value: undefined });
          return;
        }
        // underlying iterator threw or violated the protocol, so no need to close it
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
          await asyncIteratorClose(this.#underlying, { type: 'throw', value: e });
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
  #underlying;
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

  constructor(self, underlying, predicate) {
    if (typeof predicate !== 'function') {
      throw new TypeError('filter expects a function');
    }
    this.#self = self;
    this.#underlying = underlying;
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
      ({ done, value} = await this.#underlying.next());
    } catch (e) {
      // underlying iterator threw or violated the protocol, so no need to close it
      if (job.status === 'done') return;
      assert(job.status === 'running');

      job.status = 'threw';
      job.value = e;
      this.#finishedAt(job);
      return;
    }
    if (done) {
      if (job.status === 'done') return;
      assert(job.status === 'running');

      job.status = 'done';
      this.#finishedAt(job);
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
      if (job.status === 'done') return;
      assert(job.status === 'running');

      job.status = 'threw';
      job.value = e;
      try {
        await asyncIteratorClose(this.#underlying, { type: 'throw', value: e });
        assertUnreachable();
      } catch (e) {
        // ignored
      }
      this.#finishedAt(job);
      return;
    }
    if (job.status === 'done') return;
    assert(job.status === 'running');

    if (selected) {
      job.status = 'value';
      job.value = value;
      this.#maybeDrain();
    } else {
      this.#jobs.splice(this.#jobs.indexOf(job), 1);
      this.#startJob();
      this.#maybeDrain();
    }
  }
  
  #finishedAt(job) {
    this.#done = true;
    let index = this.#jobs.indexOf(job);
    assert(index !== -1);
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

/*
class FlatMapHelper {
  #self;
  #underlying;
  #fn;

  #state = 'not-started'; // 'not-started' | 'waiting-for-underlying' | 'inner-available' | 'inner-threw' | 'done'
  #currentInnerIterator = null;
  #counter = 0;
  // when waiting on a call to `underlying.next()` we can't do anything else.
  // once that call settles and produces an iterator we will immediate call its `.next` method `jobsToStartOnceInnerIteratorAvailable` times
  #jobsToStartOnceInnerIteratorAvailable = 0;
  // job items look like
  // { counter, status: 'running' | 'value' | 'threw' | 'done', value: unknown }
  // with the `value` field meaningful only for the 'value' and 'threw' types
  // it's an invariant that `this.#jobs.length + this.#jobsToStartOnceInnerIteratorAvailable === this.#capabilities.length`
  #jobs = [];
  // capabilities look like { resolve, reject }
  // there is always exactly one capability per unsettled call to `.next`
  // this list is only popped when the head of the job queue is no longer 'running'
  #capabilities = [];

  // when a call to `currentInnerIterator.next()` settles with { done: true }, we mark all subsequent jobs with the same index as `done` and remove them from the queue
  // and increment `jobsToStartOnceInnerIteratorAvailable` (which should be 0) by that number
  // then call `inner.next()`

  // when a call to `currentInnerIterator.next()` throws, we mark its job as `status: threw` and mark all subsequent jobs as `done`, but leave them in the queue
  // if an earlier call settles with { done: true }, that job and the subsequent ones will get removed and contribute to kicking of new jobs at that point
  // we don't want to kick jobs off as soon as the inner thing throws because the expectation is that we will not advance past that point


  constructor(self, underlying, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('flatMap expects a function');
    }
    this.#self = self;
    this.#underlying = underlying;
    this.#predicate = predicate;
  }

  // while in the body of this function we can enter the `done` state by throwing from the head of the old inner iterator
  // in that case we bail; we've already cleaned up when entering `done`
  async #readFromUnderlying() {
    // only one call to this function can be unsettled at a time
    // i.e. there is basically a lock on the 'waiting-for-underlying' state
    // no other async function in this machinery can start while this is running
    // (though they can already have been running)
    assert(this.#currentInnerIterator == null);
    assert(this.#state === 'not-started' || this.#state === 'inner-available');
    assert(this.#jobsToStartOnceInnerIteratorAvailable > 0);
    this.#state = 'waiting-for-underlying';
    let counter = this.#counter++;
    let done, value;
    try {
      ({ done, value} = await this.#underlying.next());
    } catch (e) {
      if (this.#state === 'done') return;
      assert(this.#state === 'waiting-for-underlying');
      this.#state = 'done';
      this.#jobs.push({ counter, status: 'threw', value: e });
      --this.#jobsToStartOnceInnerIteratorAvailable;
      for (; this.#jobsToStartOnceInnerIteratorAvailable > 0; --this.#jobsToStartOnceInnerIteratorAvailable) {
        this.#jobs.push({ counter, status: 'done' });
      }
      this.#maybeDrain();
      return;
    }
    if (this.#state === 'done') return;
    assert(this.#state === 'waiting-for-underlying');
    if (done) {
      this.#state = 'done';
      for (; this.#jobsToStartOnceInnerIteratorAvailable > 0; --this.#jobsToStartOnceInnerIteratorAvailable) {
        this.#jobs.push({ counter, status: 'done' });
      }
      this.#maybeDrain();
      return;
    }

    try {
      let mapped = this.#fn()
      // Set mapped to Completion(AwaitNonPrimitive(mapped))
      if (isAnObject(mapped)) {
        mapped = await mapped;
      }
      this.#currentInnerIterator = getIteratorFlattenable(mapped, 'async');
    } catch (e) {
      if (this.#state === 'done') return;
      // TODO dedup with above try-catch, maybe
      assert(this.#state === 'waiting-for-underlying');
      this.#state = 'done';
      try {
        await asyncIteratorClose(this.#underlying, { type: 'throw', value: e });
        assertUnreachable();
      } catch (e) {
        // ignored
      }
      this.#jobs.push({ counter, status: 'threw', value: e });
      --this.#jobsToStartOnceInnerIteratorAvailable;
      for (; this.#jobsToStartOnceInnerIteratorAvailable > 0; --this.#jobsToStartOnceInnerIteratorAvailable) {
        this.#jobs.push({ counter, status: 'done' });
      }
      this.#maybeDrain();
      return;
    }
    if (this.#state === 'done') return;

    assert(this.#state === 'waiting-for-underlying');
    this.#state = 'inner-available';
    let count = this.#jobsToStartOnceInnerIteratorAvailable;
    this.#jobsToStartOnceInnerIteratorAvailable = 0;
    this.#startJobs(count);
  }

  #startJobs(count) {
    // push all the job items before starting any of them, in case any of them complete synchronously
    let newJobs = [];
    for (let i = 0; i < count; ++i) {
      newJobs.push({ counter, status: 'running' });
    }
    this.#jobs.push(...newJobs);
    for (let job of newJobs) {
      this.#readFromInner(job).catch(assertUnreachable);
      // it's possible for the read in readFromInner to synchronously throw
      // in that case those jobs will be marked as `done` and we do not need to do reads from this iterator for them
      if (this.#state !== 'inner-available') {
        break;
      }
    }
  }

  async #readFromInner(job) {
    assert(this.#currentInnerIterator != null);
    assert(this.#state === 'inner-available');
    assert(job.status === 'running');

    let done, value;
    try {
      ({ done, value} = await this.#currentInnerIterator.next());
    } catch (e) {
      if (job.status === 'done') return;
      assert(job.status === 'running');

      this.#state = 'inner-threw';

      job.status = 'threw';
      job.value = e;
      let jobIndex = this.#jobs.indexOf(job);
      assert(jobIndex !== -1);
      for (let i = jobIndex + 1; i < this.#jobs.length; ++i) {
        let other = this.#jobs[i];
        if (other.counter !== job.counter) {
          break;
        }
        other.status = 'done';
      }
      this.#maybeDrain();
      return;
    }
    if (done) {
      if (job.status === 'done') return;
      assert(job.status === 'running');

      // if we get here, we know no previous promise from this iterator settled with { done: true } or threw
      job.status = 'done';
      let jobIndex = this.#jobs.indexOf(job);
      assert(jobIndex !== -1);
      let jobsRemovedByFinishingThisIterator = 1;
      for (let i = jobIndex + 1; i < this.#jobs.length; ++i) {
        let other = this.#jobs[i];
        if (other.counter !== job.counter) {
          break;
        }
        other.status = 'done';
        ++jobsRemovedByFinishingThisIterator;
      }
      this.#jobs.splice(jobIndex, jobsRemovedByFinishingThisIterator);
      this.#maybeDrain();

      if (this.#state === 'done') {
        return;
      }
      if (this.#counter === job.counter + 1) {
        // i.e. we haven't yet advanced past this iterator
        assert(this.#state === 'inner-available' || this.#state === 'inner-threw');
        // the inner-threw case is when some later promise from this iterator threw
        // we've just discarded the job for that and are going to mask that error
        this.#state = 'inner-available';
        this.#jobsToStartOnceInnerIteratorAvailable += jobsRemovedByFinishingThisIterator;
        this.#readFromUnderlying().catch(assertUnreachable);
        return;
      }
      // otherwise, we've advanced past this iterator
      if (this.#state === 'inner-available') {
        // an inner iterator is available and it's not the iterator for this job, so start reading from it
        this.#startJobs(jobsRemovedByFinishingThisIterator);
        return;
      }
      assert(this.#state === 'waiting-for-underlying' || this.#state === 'inner-threw');
      this.#jobsToStartOnceInnerIteratorAvailable += jobsRemovedByFinishingThisIterator;
      return;
    }

    if (job.status === 'done') return;
    assert(job.status === 'running');

    job.status = 'value'
    job.value = value;
    this.#maybeDrain();
  }

  // this should be invoked after any operation which may have caused the job at the head of the queue to be no longer running
  #maybeDrain() {
    while (this.#jobs.length > 0 && this.#jobs[0].status === 'value') {
      let job = this.#jobs.shift();
      let { resolve, reject } = this.#capabilities.shift();
      resolve({ done: false, value: job.value });
    }
    if (this.jobs.length === 0) {
      return;
    }
    if (this.#jobs[0].status === 'done') {
      assert(this.status === 'done');
      assert(this.#jobsToStartOnceInnerIteratorAvailable === 0);
      assert(this.#capabilities.length === this.#jobs.length);
      for (let i = 0; i < this.jobs.length; ++i) {
        let job = this.#jobs.shift();
        assert(job.status === 'done');
        let { resolve, reject } = this.#capabilities.shift();
        resolve({ done: true, value: undefined });
      }
      return;
    }
    if (this.#jobs[0].status === 'threw') {
      let throwingJob = this.#jobs.shift();
      this.#capabilities.shift().reject(throwingJob.value);
      if (this.#state !== 'done') {
        this.#state = 'done';
        try {
          await asyncIteratorClose(this.#underlying, { type: 'throw', value: throwingJob.value });
          assertUnreachable();
        } catch (e) {
          // ignored
        }
        for (; this.#jobsToStartOnceInnerIteratorAvailable > 0; --this.#jobsToStartOnceInnerIteratorAvailable) {
          this.#jobs.push({ counter, status: 'done' });
        }
      }
      assert(this.#capabilities.length === this.#jobs.length);
      for (let i = 0; i < this.jobs.length; ++i) {
        let job = this.#jobs.shift();
        let { resolve, reject } = this.#capabilities.shift();
        job.status = 'done';
        resolve({ done: true, value: undefined });
      }
    }
  }
}
*/

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
iter = AsyncIterator.from([0, 1]).map(async x => (await sleep(100), x + 1));
iter.next().then(console.log);
iter.next().then(console.log);
iter.next().then(console.log);
iter.next().then(console.log);

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
// iter = AsyncIterator.from([1, 3, 2, 3.1, 1.1]).map(async x => {
//   console.log('starting to wait for', x);
//   await sleep(x/2 * 1000);
//   console.log('done waiting for', x);
//   return x;
// }).filter(x => {
//   if (x === 3.1) { throw new Error('predicate throws for 3.1'); }
//   return x > 1;
// });
// iter.next().then(console.log, console.log);
// iter.next().then(console.log, console.log);
// iter.next().then(console.log, console.log);
// iter.next().then(console.log, console.log);
// sleep(3000).then(() => { console.log('triggering next after completion'); iter.next().then(console.log, console.log); });
