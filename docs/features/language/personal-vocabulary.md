# Personal vocabulary

**Status: the loader is built; there is no surface for it yet.**

## What it will do

Let you supply your own JSON file of word replacements, applied only at the
user-facing text boundary, entirely on this machine.

## What it deliberately does not do

**It ships no mappings.** There are no built-in entries, no samples, no
templates, no defaults and no guesses. Until you supply a valid file, every
surface renders its original wording, unchanged.

**It touches no network.** No fetch, no upload, no telemetry, no sync. Parsing,
validation, replacement and caching happen locally and nowhere else.

**It persists nothing but the validated cache.** Not the source path, not the
file's contents anywhere else — not in settings, logs, exports, history
snapshots, crash reports or captures.

## Validation is fail-closed and total

A file that fails any check applies **nothing**. A partial application would
leave the interface in a state matching no file you have ever seen.

| Check | Bound |
| --- | --- |
| File size | 512 KiB |
| Entries | 5,000 |
| Entry name length | 1 to 200 characters |
| Replacement length | 400 characters |
| Nesting depth | 3 |
| Schema version | 1 |

It also rejects malformed JSON, unknown fields, reserved object keys, non-string
replacements, and **duplicate entry names**.

Duplicates are detected on the raw text before parsing, because `JSON.parse`
silently keeps the last of a duplicated key — by the time there is an object, the
duplicate is gone and unknowable.

## Error messages name the rule, never the content

A rejection says which bound was broken. It never echoes the offending entry: an
error message is a surface, and putting your private wording into one would leak
exactly what this feature exists to keep local.

## Clearing

Clearing purges the cache and restores original wording immediately. A rejected
file changes nothing — the previous state stays exactly as it was.

## Suggested articles

- [Language modes and funny levels](language-modes.md)
