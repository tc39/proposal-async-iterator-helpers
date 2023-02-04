# Async Iterator Helpers

A proposal for several interfaces that will help with general usage and
consumption of async iterators in ECMAScript.

This proposal was split out from [proposal-iterator-helpers](https://github.com/tc39/proposal-iterator-helpers) to resolve design questions related to parallelism, which are not relevant to sync helpers. Many design questions (including choice of methods) were discussed and decided in that respository, and its readme should be read first.

## Status

Authors: Gus Caplan, Michael Ficarra, Adam Vandolder, Jason Orendorff, Kevin Gibbons

Champions: Michael Ficarra, Kevin Gibbons

This proposal is at Stage 2 of [The TC39 Process](https://tc39.es/process-document/).

**This proposal is in the process of being revised.** The core set of helpers and their high-level API is unlikely to change, but the underlying specification mechanism will likely be radically revised.

This proposal contains the following methods:

- `Iterator.prototype.toAsync`
- `AsyncIterator.from`
- `AsyncIterator.prototype`
  - `.map`
  - `.filter`
  - `.take`
  - `.drop`
  - `.flatMap`
  - `.reduce`
  - `.toArray`
  - `.forEach`
  - `.some`
  - `.every`
  - `.find`

See [proposal-iterator-helpers](https://github.com/tc39/proposal-iterator-helpers) for motivation and additional high-level descriptions for these methods.

## Parallelism

In the iterator-producing methods (`.map`, `.filter`, `.take`, `.drop`, and `.flatMap`), async helpers have the opportunity to support _parallelism_. For example, in the following code:

```js
asyncIteratorOfUrls
  .map(u => fetch(u))

await Promise.all([
  x.next(),
  x.next(),
])
```

there could be two calls to `fetch` running at once. For this to work, the helpers have to be explicitly designed to support this. The original design of this proposal instead implemented the helpers as essentially async generators, which buffer calls to `.next` rather than allowing multiple calls to have simulaneous effects.

This proposal is being revised to support at least the above use case. The exact details of what that looks like for each helper are not yet decided.

### How can I access the new intrinsics?

This proposal introduces two new intrisic objects, in addition to the two added in the sync proposal. They can be accessed as follows:

```js
const AsyncIteratorHelperPrototype = Object.getPrototypeOf(AsyncIterator.from([]).take(0));
const WrapForValidAsyncIteratorPrototype = Object.getPrototypeOf(AsyncIterator.from({ async next(){} }));
```
