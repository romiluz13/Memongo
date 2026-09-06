# Node.js Docs — fsPromises.readdir error semantics (captured sections)

- source: https://nodejs.org/api/fs.html (fsPromises.readdir section)
- accessed: 2026-09-06 (Wave 2b grounding, W14 enumeration-failure deletion)
- capture scope: fsPromises.readdir return contract and error delivery;
  verbatim quote of the section and its official example.

## `fsPromises.readdir(path[, options])`

> - Returns: `<Promise>` Fulfills with an array of the names of the files in
>   the directory excluding `'.'` and `'..'`.
>
> Reads the contents of a directory.

Official example (verbatim, error delivery demonstrated by the API's own
example):

```mjs
import { readdir } from 'node:fs/promises';

try {
  const files = await readdir(path);
  for (const file of files)
    console.log(file);
} catch (err) {
  console.error(err);
}
```

The `fs.promises` API family (`readdir`, `lstat`, `realpath`, `readFile`)
delivers errors exclusively by promise rejection; there is no partial-result
mode. A rejected `readdir` (EACCES, EMFILE, transient I/O) means the
directory listing is NOT available — it never means the directory is empty.

## Wave-2b reliance

W14 fix basis: `listMemoryFiles` / `listLegacyMarkdownMemoryFiles` in
`packages/memory-engine/src/internal.ts` currently wrap `walkDir` (which
calls `fs.promises.readdir`), `fs.lstat`, and `fs.realPath` in `catch {}`
blocks that swallow the rejection and continue as if no files existed. The
caller (`syncToMongoDB`) then builds `validPaths` from the (empty or
partial) result and runs stale-chunk cleanup: `deleteStaleChunks` removes
every stored chunk whose path is not in `validPaths`, plus the file-metadata
rows — so a transient EACCES on the memory directory currently deletes the
entire indexed memory of the namespace. Per the captured contract, an
enumeration failure is a rejection and must be propagated as "enumeration
incomplete" so stale cleanup is skipped, not reinterpreted as
"zero files on disk".
