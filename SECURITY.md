# Security

## Reporting

Open a GitHub issue. If the report involves something you would rather not post
publicly, say so in the issue without the details and a private channel will be
arranged.

There is no bounty programme and no guaranteed response time. That is an honest
statement rather than a formality.

## What this application does and does not do

**No network access.** The desktop application makes no outbound request except
to a collaboration server you configure yourself. There is no CDN, no remote
font, no analytics, no telemetry, and no crash reporting.

**Installers are unsigned, permanently.** Code signing is out of scope by
deliberate policy. Windows will show an unknown-publisher warning. Verify a
download by its published SHA-256 rather than by a signature, and treat any
"signed Material Workspace installer" as not ours.

**Secrets live in the operating system credential store**, never in settings
files, exports, logs, screenshots, history snapshots or the repository.

**The audit log is tamper-EVIDENT, not tamper-proof.** Each record carries the
hash of the one before it, so altering or removing an earlier entry breaks every
hash after it and verification reports exactly where. Anybody who can write to
the file can rewrite the whole chain; what they cannot do is change one entry and
leave the rest consistent. The surface says this plainly rather than implying a
guarantee it cannot make.

**Toy locks are a user-experience speed bump, not a security boundary.** They do
not encrypt anything and do not protect against anyone else who has the machine.
Deleting the application data folder clears them, and every lock surface says so.

**Redaction will remove bytes.** When the PDF application ships, redaction will
delete the underlying content rather than drawing a black rectangle over it.
Until it ships it does not exist, and this file will not claim otherwise.

## Boundaries in the code

- `contextIsolation` on, `nodeIntegration` off, `sandbox` on, `webviewTag` off.
- The preload bridge exposes explicit named functions only. There is no generic
  channel forwarder, because that hands the renderer the whole main-process
  surface and turns one scripting hole into local code execution.
- Every bridge request carries a deadline that rejects. A hung request without
  one stops its caller silently, with nothing to distinguish it from a slow
  machine — a `catch` cannot save a caller from a promise that never settles.
- The personal-vocabulary loader validates bounds, schema version, nesting depth,
  entry count, key and value lengths, duplicate keys and reserved object keys,
  and applies **nothing** when any check fails. A rejected file leaves the
  previous state exactly as it was.
- Vocabulary rejection messages name the rule broken, never the offending
  content. An error message is a surface, and echoing a private term into one
  would leak the thing the feature exists to keep local.
- File paths written into the history repository are checked to be inside it, so
  a crafted relative path cannot escape.
- Content Security Policy is `self` throughout, with no inline script.
