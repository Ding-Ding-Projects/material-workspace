/**
 * The per-surface completeness inventory.
 *
 * WHY IT IS HAND-WRITTEN. A rule-shaped check - "every surface that has a
 * search bar wires it to the builder" - passes perfectly on a surface with no
 * search bar. It never looked, so it never failed. This repository has already
 * met that twice: a destructive gate used by nothing, and a preview button
 * wired to nothing, both sitting behind a green suite.
 *
 * So this file is a LIST, not a rule. Every surface is named, every feature it
 * must carry is named, and the check fails when a named pair is missing. A
 * feature nobody has implemented anywhere fails here rather than being absent
 * from a registry that only knows what it found.
 *
 * IT IS ALSO HONEST ABOUT WHAT IS NOT BUILT. A row may be marked `pending`
 * with the reason, and the count of pending rows is reported on every run.
 * That is the difference between a gap somebody decided on and a gap nobody
 * noticed - and it means this file doubles as the roadmap's own check.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

const ROOT = process.cwd();

interface Row {
  /** The surface, as a person would name it. */
  readonly surface: string;
  /** The contract it must carry. */
  readonly feature: string;
  /** Where it lives. */
  readonly file: string;
  /**
   * A line-anchored pattern proving it is there and live.
   *
   * Line-anchored because a commented-out line still contains the text, and a
   * renamed symbol still contains the old name as a substring. Both would
   * satisfy a bare `includes` for ever.
   */
  readonly proof: RegExp;
  /** Set when the row is deliberately not built yet, with the reason. */
  readonly pending?: string;
}

/** Every surface that renders to a person, named once. */
const SURFACES = [
  'Writer',
  'Sheets',
  'Slides',
  'Draw',
  'Formula',
  'Database',
  'PDF',
  'Notes',
  'Forms',
  'Appearance',
  'Narrator',
  'Locks',
  'Find a tab',
  'History',
  'Changelog',
  'Collaboration',
  'Governance',
  'Notifications',
  'Settings',
] as const;

const INVENTORY: readonly Row[] = [
  // -------------------------------------------------- tables and images --
  {
    surface: 'Writer',
    feature: 'a cell wraps against its own width, not the page width',
    file: 'app/engines/text/table.ts',
    proof: /^export function layoutTable\(/m,
  },
  {
    surface: 'Writer',
    feature: 'a table breaks at a row boundary, and a header row repeats',
    file: 'app/engines/text/table.ts',
    proof: /^export function splitTable\(/m,
  },
  {
    surface: 'Writer',
    feature: 'an image scaled to fit keeps its proportions rather than stretching',
    file: 'app/engines/text/table.ts',
    proof: /^export function fitImage\(/m,
  },
  {
    surface: 'Writer',
    // The prompt this replaced was a blocking native dialog that this
    // application uses nowhere else and that nothing but a person at a
    // keyboard can answer. What keeps the principle is that an undescribed
    // image is IMPOSSIBLE TO MISS: the row appears in the error colour, the
    // status says it plainly, and the save names it again.
    feature: 'an undescribed image raises a description row that will not go away until it is answered',
    file: 'app/renderer/apps/writer/writer.ts',
    proof: /^  private describeImage\(alt: string\): void \{$/m,
  },
  {
    surface: 'Writer',
    feature: 'an image can be dropped onto the page, not only chosen from a dialog',
    file: 'app/renderer/apps/writer/writer.ts',
    proof: /^\s*this\.pagesHost\.addEventListener\('drop',/m,
  },
  {
    surface: 'Writer',
    feature: 'tables are written into .docx, grid and header rows included',
    file: 'app/engines/codec/docx.ts',
    proof: /^function tableXml\(/m,
  },
  {
    surface: 'Writer',
    feature: 'tables are read back out of .docx, walking the body in order',
    file: 'app/engines/codec/docx.ts',
    proof: /^function readTable\(/m,
  },
  {
    surface: 'Writer',
    feature: 'ODF header rows are read from their own element, not missed',
    file: 'app/engines/codec/odf.ts',
    proof: /^function readOdfTable\(/m,
  },
  {
    surface: 'Writer',
    feature: 'an image becomes a real media part with a relationship pointing at it',
    file: 'app/engines/codec/docx.ts',
    proof: /^function drawingXml\(/m,
  },
  {
    surface: 'Writer',
    feature: 'an image is read back by resolving its relationship to a part',
    file: 'app/engines/codec/docx.ts',
    proof: /^function readDrawing\(/m,
  },
  {
    surface: 'Writer',
    feature: 'an ODF picture is written with its manifest entry and read back by href',
    file: 'app/engines/codec/odf.ts',
    proof: /^function readOdfImage\(/m,
  },
  {
    surface: 'Writer',
    feature: 'an image with no alternative text is named on the save, because the file keeps it',
    file: 'app/engines/codec/docx-bridge.ts',
    proof: /^\s*const undescribed = source\.blocks\.filter\(/m,
  },
  // ------------------------------------------------- sorting and formats --
  {
    surface: 'Sheets',
    feature: 'a sort returns an ORDER, so whole rows move and no value leaves its row',
    file: 'app/engines/sheet/sort.ts',
    proof: /^export function sortRows\(/m,
  },
  {
    surface: 'Sheets',
    feature: 'a formula inside the range refuses the sort rather than being left pointing elsewhere',
    file: 'app/engines/sheet/sort.ts',
    proof: /^export function formulasBlocking\(/m,
  },
  {
    surface: 'Sheets',
    feature: 'a percent format multiplies the display and leaves the stored value alone',
    file: 'app/engines/sheet/format.ts',
    proof: /^export function formatValue\(/m,
  },
  {
    surface: 'Sheets',
    feature: 'column positions are summed, not multiplied, so variable widths line up',
    file: 'app/renderer/apps/sheets/sheets.ts',
    proof: /^  private leftOf\(column: number\): number \{$/m,
  },
  // ------------------------------------------------------- PDF filters --
  {
    surface: 'PDF',
    feature: 'compressed streams are decoded, so a real PDF can be read at all',
    file: 'app/engines/pdf/filters.ts',
    proof: /^export async function decodeStream\(/m,
  },
  {
    surface: 'PDF',
    feature: 'a compressed page is DRAWN as well as read - two paths, both fixed',
    file: 'app/engines/pdf/render.ts',
    proof: /^export async function drawPage\(/m,
  },
  {
    surface: 'PDF',
    feature: 'a stream that cannot be read is named on the surface, not silently absent',
    file: 'app/renderer/apps/pdf/pdf.ts',
    proof: /^\s*if \(result\.unreadable\.length > 0\) \{$/m,
  },
  // --------------------------------------------------- mathematical tables --
  {
    surface: 'Formula',
    feature: 'matrices, cases and aligned equations parsed as real tables',
    file: 'app/engines/formula/model.ts',
    proof: /^  private parseTable\(name: string, at: number\): Node \{$/m,
  },
  {
    surface: 'Formula',
    feature: 'an aligned block alternates right then left, which is the whole point of it',
    file: 'app/engines/formula/model.ts',
    proof: /^export function alignmentFor\(/m,
  },
  {
    surface: 'Formula',
    feature: 'a named math font, so a stretchy bracket actually stretches',
    file: 'app/renderer/styles/formula.css',
    // The generic alone rendered a 24-pixel bracket beside a 64-pixel matrix.
    proof: /^\s*font-family: 'Cambria Math',/m,
  },
  // ------------------------------------------------------ vector editing --
  {
    surface: 'Draw',
    feature: 'boolean path operations that hop between rings at every crossing',
    file: 'app/engines/vector/boolean.ts',
    // Anchored on the hop itself, not on the function name. Filtering each
    // ring and concatenating the two runs also compiles, also returns one
    // ring, and draws a diagonal slice through the middle of the result.
    proof: /^\s*const jumped = crossingIndex\(sides\[other\]\.path, next\.point\);$/m,
  },
  {
    surface: 'Draw',
    feature: 'eight resize handles and a rotate handle, each with its own cursor and name',
    file: 'app/engines/vector/handles.ts',
    proof: /^export function handlesFor\(/m,
  },
  {
    surface: 'Draw',
    feature: 'a locked shape shows its handles and refuses the drag with a reason',
    file: 'app/renderer/apps/draw/draw.ts',
    proof: /^\s*const allowed = resizable\(current\);$/m,
  },
  // ---------------------------------------------------------- the shell --
  {
    surface: 'Shell',
    feature: 'version and build provenance on the front screen',
    file: 'app/renderer/index.ts',
    proof: /^\s*provenance: BuildProvenance,$/m,
  },
  {
    surface: 'Shell',
    feature: 'three language modes',
    file: 'app/renderer/i18n.ts',
    proof: /^export type LanguageMode = /m,
  },
  {
    surface: 'Shell',
    feature: 'independent funny levels for each language',
    file: 'app/shared/settings.ts',
    proof: /^\s*cantonese: FunnyLevel;$/m,
  },
  {
    surface: 'Shell',
    feature: 'School mode forces English while keeping the stored choice',
    file: 'app/shared/school.ts',
    proof: /^export function effectiveMode</m,
  },
  {
    surface: 'Shell',
    feature: 'tab strip scrolls and reports what is out of view',
    file: 'app/renderer/components/tabs.ts',
    proof: /^\s*private updateOverflow\(\): void \{$/m,
  },
  {
    surface: 'Shell',
    feature: 'command palette on Ctrl+Shift+F',
    file: 'app/renderer/components/palette/palette.ts',
    proof: /shiftKey/m,
  },
  {
    surface: 'Shell',
    feature: 'non-blocking notifications with a reviewable centre',
    file: 'app/renderer/components/notifications.ts',
    proof: /^export class Notifications \{$/m,
  },
  {
    surface: 'Shell',
    feature: 'ADHD modes, independently toggleable',
    file: 'app/renderer/adhd.ts',
    proof: /^export class AttentionModes \{$/m,
  },

  // ------------------------------------------------------ safety rails --
  {
    surface: 'Shell',
    feature: 'two-key destructive confirmation, used by real actions',
    file: 'app/renderer/index.ts',
    proof: /^\s*void SuperConfirm\.open\(\{$/m,
  },
  {
    surface: 'Locks',
    feature: 'six credential policies, each lock with its own credential',
    file: 'app/shared/locks.ts',
    proof: /^export const POLICIES = \[$/m,
  },
  {
    surface: 'Locks',
    feature: 'the unlock ladder, budgeted so it cannot replace the password',
    file: 'app/shared/ladder.ts',
    proof: /^export function skipsRemaining\(/m,
  },
  {
    surface: 'Locks',
    feature: 'Support Tickets, naming the real recovery folder',
    file: 'app/renderer/components/locks-surface.ts',
    proof: /^\s*el\('h3', \{ class: 'locks-subtitle', text: 'Support Tickets' \}\),$/m,
  },

  // ------------------------------------------------------- discovery --
  {
    surface: 'Find a tab',
    feature: 'all four tab searches, each with its own query and regex opt-in',
    file: 'app/renderer/components/tab-search.ts',
    proof: /^const TITLES: Record<Kind, \{ title: string; help: string \}> = \{$/m,
  },
  {
    surface: 'Find a tab',
    feature: 'bulk close with a preview that names what it kept',
    file: 'app/renderer/tabs/model.ts',
    proof: /^export function planClose\(/m,
  },

  // ------------------------------------------------------- appearance --
  {
    surface: 'Appearance',
    feature: 'infinite colour picker, continuous rather than a swatch grid',
    file: 'app/renderer/components/colour-picker.ts',
    proof: /^\s*private onFieldPointer\(event: PointerEvent\): void \{$/m,
  },
  {
    surface: 'Appearance',
    feature: 'the colour translator across every notation',
    file: 'app/renderer/colour/notation.ts',
    proof: /^export function translate\(/m,
  },
  {
    surface: 'Appearance',
    feature: 'the animated rainbow as a sentinel, not a colour string',
    file: 'app/renderer/colour/rainbow.ts',
    proof: /^export const RAINBOW = 'rainbow' as const;$/m,
  },
  {
    surface: 'Appearance',
    feature: 'per-element appearance editors',
    file: 'app/renderer/components/element-appearance.ts',
    proof: /^\s*private renderControl\(property: PropertyDefinition, stored: string \| null\): HTMLElement \{$/m,
  },
  {
    surface: 'Appearance',
    feature: 'a right-click menu on every rendered element, by delegation',
    file: 'app/renderer/index.ts',
    // Delegated from the root rather than wired per surface, which is what
    // makes "every element has one" true by construction rather than true
    // wherever somebody remembered.
    proof: /^\s*private installElementMenu\(\): void \{$/m,
  },
  {
    surface: 'Appearance',
    feature: 'a stored style is DATA, never a CSS fragment',
    file: 'app/shared/element-style.ts',
    // The value reaches a style attribute, so a settings file edited by hand
    // must not be able to end one declaration and begin another.
    proof: /^function acceptColour\(value: string\): Acceptance \{$/m,
  },
  {
    surface: 'Appearance',
    feature: 'theme export and import, re-checked value by value on the way in',
    file: 'app/shared/element-style.ts',
    proof: /^export function importTheme\(payload: unknown\): ImportResult \| Rejection \{$/m,
  },
  {
    surface: 'Appearance',
    feature: 'named presets, saved and applied from the editor',
    file: 'app/shared/element-style.ts',
    // Applying REPLACES rather than merges, so the same preset gives the same
    // result everywhere it is used.
    proof: /^export function applyPreset\($/m,
  },
  {
    surface: 'Appearance',
    feature: 'copy and paste a look between two elements',
    file: 'app/renderer/index.ts',
    proof: /^\s*id: 'paste-appearance',$/m,
  },
  {
    surface: 'Sheets',
    feature: 'filtering that HIDES rows and never removes them',
    file: 'app/engines/sheet/filter.ts',
    // A spreadsheet that deletes what a filter excludes loses data every time
    // somebody narrows a view, and the loss is invisible until they clear it.
    proof: /^export function filterRows\($/m,
  },
  {
    surface: 'Sheets',
    feature: 'a bar chart whose axis always includes zero',
    file: 'app/engines/sheet/chart.ts',
    // Bar length IS the comparison. An axis starting at 90 makes 91 look twice
    // 90, and a reader who cannot see the crop reads the exaggeration as data.
    proof: /^export function bounds\(kind: ChartKind, values: readonly number\[\]\): AxisBounds \{$/m,
  },
  {
    surface: 'Writer',
    feature: 'footnotes that land on the same page as their own reference',
    file: 'app/engines/text/layout.ts',
    // The space is RESERVED before the lines are placed. Reserving afterwards
    // overfills the page and pushes the last line below the paper.
    proof: /^\s*const measureNotes = \(entries: readonly \{ note: Footnote; number: number \}\[\]\): number => \{$/m,
  },
  {
    surface: 'Writer',
    feature: 'a table of contents whose page numbers include the contents itself',
    file: 'app/engines/text/contents.ts',
    // Two passes, and the second is not optional: the contents takes pages, so
    // numbers built before it was inserted are short by however many.
    proof: /^export function insert\($/m,
  },
  {
    surface: 'Writer',
    feature: 'footnotes and fields survive a docx round trip',
    file: 'app/engines/codec/docx.ts',
    // The separator and continuation separator are not notes; a reader that
    // takes every w:footnote shows two empty ones on every document.
    proof: /^function readFootnotes\(part: Uint8Array \| undefined\): DocxFootnote\[\] \{$/m,
  },
  {
    surface: 'PDF',
    feature: 'a page interpreted into a display list, with the Y axis the right way up',
    file: 'app/engines/pdf/render.ts',
    // PDF's origin is the bottom-left. A renderer that draws straight onto
    // screen coordinates puts every page upside down, and on centred content
    // that is nearly invisible.
    proof: /^export function renderContent\(source: string, options: RenderOptions = \{\}\): RenderedPage \{$/m,
  },
  {
    surface: 'PDF',
    feature: 'a software rasterizer, so a test can assert PIXELS rather than coordinates',
    file: 'app/engines/pdf/render.ts',
    // A correct display list and a broken rasterizer produce a blank page, and
    // only pixels tell the two apart.
    proof: /^export function rasterize\(page: RenderedPage, scale = 1\): Raster \{$/m,
  },
  {
    surface: 'Slides',
    feature: 'PowerPoint files read and written, with the slide order taken from the deck',
    file: 'app/engines/codec/pptx.ts',
    // The part names are names, not positions. Sorting by filename puts
    // slide10 between slide1 and slide2.
    proof: /^export async function readPptx\(bytes: Uint8Array\): Promise<Presentation> \{$/m,
  },
  {
    surface: 'Slides',
    feature: 'OpenDocument presentations, with lengths that carry their unit',
    file: 'app/engines/codec/odp.ts',
    // Number("8.467cm") is NaN, and NaN in a frame is a shape at the origin
    // with no size - a slide that looks like it failed to load.
    proof: /^export function lengthToCm\(value: string \| undefined\): number \| null \{$/m,
  },
  {
    surface: 'Shell',
    feature: 'a committed conformance corpus of REAL files, read off disk',
    file: 'test/corpus/build-corpus.mjs',
    // Not a round trip through the module's own output, which proves only that
    // a module agrees with itself - including when it is wrong self-consistently.
    proof: /^export const CORPUS = \[$/m,
  },
  {
    surface: 'Collaboration',
    feature: 'a deployment that re-checks the host live before it sends anything',
    file: 'server/deploy.mjs',
    // The recorded inventory is a routing hint, never permission: the host the
    // plan named was unreachable on the day, which is the case this exists for.
    proof: /^log\('checking ' \+ target \+ ' live, before anything is sent'\);$/m,
  },
  {
    surface: 'Collaboration',
    feature: 'the limits actually applied are read back, not read off the file',
    file: 'server/deploy.mjs',
    proof: /^const applied = \{$/m,
  },
  {
    surface: 'Collaboration',
    feature: 'co-authoring proved against the deployed container, over the network',
    file: 'server/verify-live.mjs',
    // Not the unit suite. In-process tests say nothing about whether the
    // container on the other side of a LAN actually serves.
    proof: /^\s*check\('a client can join a room on the deployed server', one\.joined\?\.room, room\);$/m,
  },
  {
    surface: 'Shell',
    feature: 'a committed recording of the application actually running',
    file: 'scripts/record-walkthrough.mjs',
    // Window pixels over the debugging protocol, never the screen. Recording a
    // monitor captures whatever the person was doing, which is their private
    // data and none of this project's business.
    proof: /^\s*const shot = await send\('Page\.captureScreenshot', \{ format: 'png' \}\);$/m,
  },
  {
    surface: 'Shell',
    feature: 'no clipping or undersized targets, measured across the whole matrix',
    file: 'scripts/drive-layout.mjs',
    // Measured rather than captured. A person scanning ninety-six screenshots
    // finds the obvious breakages and misses the three-pixel truncation on the
    // longest bilingual label, which is the one that loses a word.
    proof: /^const SCALES = \[1, 1\.25, 1\.5, 2\];$/m,
  },
  {
    surface: 'Appearance',
    feature: 'an ordered, non-destructive layer stack on any element',
    file: 'app/shared/element-layers.ts',
    // The list order IS the paint order. Reversing it puts every stack upside
    // down while every counting test keeps passing, so the model's own test
    // asserts the direction and was watched failing.
    proof: /^export function compose\(layers: readonly Layer\[\]\): Composed \{$/m,
  },
  {
    surface: 'Appearance',
    feature: 'layers hide, lock, reorder, duplicate and blend',
    file: 'app/renderer/components/layer-panel.ts',
    proof: /^\s*private renderLayer\(layer: Layer, index: number, total: number\): HTMLElement \{$/m,
    pending:
      'The stack, its ordering, visibility, locking, opacity and the sixteen ' +
      'blend modes are built and applied. Pixel work - a brush, an eraser and ' +
      'an arbitrary mask - is deliberately not built: it would mean rendering ' +
      'the element to a canvas and showing a picture where the control was, ' +
      'taking its accessible name, focus ring and selectable text with it.',
  },

  // --------------------------------------------------------- narration --
  {
    surface: 'Narrator',
    feature: 'per-language voice pickers resolved from the machine',
    file: 'app/renderer/components/narrator-surface.ts',
    proof: /^export function browserVoices\(\)/m,
  },
  {
    surface: 'Narrator',
    feature: 'a serialized queue so nothing overlaps',
    file: 'app/renderer/narrator/narrator.ts',
    proof: /^export class NarratorQueue \{$/m,
  },
  {
    surface: 'Narrator',
    feature: 'yields to an active screen reader, told by the operating system',
    file: 'app/renderer/narrator/narrator.ts',
    proof: /^\s*setScreenReaderActive\(active: boolean\): void \{$/m,
  },
  {
    surface: 'Narrator',
    feature: 'the host reports assistive technology rather than the renderer guessing',
    file: 'app/main/main.ts',
    proof: /^\s*screenReaderActive: app\.accessibilitySupportEnabled,$/m,
  },

  // ------------------------------------------------------------ data --
  {
    surface: 'History',
    feature: 'browse, search, date range and action filter',
    file: 'app/renderer/components/history-panel.ts',
    proof: /^export class HistoryPanel \{$/m,
  },
  {
    surface: 'History',
    feature: 'restoring writes a new entry rather than rewriting',
    file: 'app/renderer/components/history-panel.ts',
    proof: /^\s*private async restore\(entry: HistoryEntry\): Promise<void> \{$/m,
  },
  {
    surface: 'Changelog',
    feature: 'generated from git, every commit proved to exist',
    file: 'scripts/build-changelog.mjs',
    proof: /^\s*const check = spawnSync\('git', \['cat-file', '-e',/m,
  },
  {
    surface: 'Shell',
    feature: 'export in every format that can carry the data',
    file: 'app/shared/export.ts',
    proof: /^export const FORMATS: readonly Format\[\] = \[$/m,
  },
  {
    surface: 'Shell',
    feature: 'export warnings naming the actual columns that would lose something',
    file: 'app/shared/export.ts',
    proof: /^export function warningsFor\(/m,
  },
  {
    surface: 'Shell',
    feature: 'a shared multi-select and bulk-action model',
    file: 'app/shared/bulk.ts',
    proof: /^export function plan<T extends \{ id: string \}>\($/m,
  },
  {
    surface: 'Notifications',
    feature: 'bulk actions with a stated select-all scope',
    file: 'app/renderer/components/notifications.ts',
    proof: /^\s*dismissSelected\.textContent = 'Dismiss selected';$/m,
  },
  {
    surface: 'History',
    feature: 'multi-select with a keyboard equivalent and a bulk plan',
    file: 'app/renderer/components/history-panel.ts',
    proof: /^\s*private renderBulk\(shown: readonly HistoryEntry\[\]\): void \{$/m,
  },
  {
    surface: 'Find a tab',
    feature: 'bulk close previewed before anything closes',
    file: 'app/renderer/tabs/model.ts',
    proof: /^export function planClose\(/m,
  },
  {
    surface: 'Shell',
    feature: 'bulk actions on every application list',
    file: 'app/shared/bulk.ts',
    proof: /^export function plan<T extends \{ id: string \}>\($/m,
  },
  {
    surface: 'Shell',
    feature: 'a bulk action over a grid RANGE, not only over a list',
    file: 'app/renderer/apps/sheets/sheets.ts',
    // The counts are two numbers on purpose. A clear over a hundred cells of
    // which six hold anything changes six things, and reporting the hundred
    // would overstate it exactly as counting rows a delete will skip does.
    proof: /^\s*private selectionCounts\(\): \{ covered: number; filled: number \} \{$/m,
  },

  // ------------------------------------------------- collaboration --
  {
    surface: 'Collaboration',
    feature: 'CRDT co-authoring that converges under every ordering',
    file: 'app/sync/crdt.ts',
    proof: /^\s*private positionFor\(after: Identity \| null, id: Identity\): number \{$/m,
  },
  {
    surface: 'Collaboration',
    feature: 'offline queue that returns a failed batch to the front',
    file: 'app/sync/crdt.ts',
    proof: /^\s*retry\(\): void \{$/m,
  },
  {
    surface: 'Collaboration',
    feature: 'presence that expires rather than needing a goodbye',
    file: 'app/sync/crdt.ts',
    proof: /^\s*sweep\(now: number\): ReplicaId\[\] \{$/m,
  },

  // ---------------------------------------------------- governance --
  {
    surface: 'Governance',
    feature: 'classification where a label only goes up without authority',
    file: 'app/main/governance/classification.ts',
    proof: /^export function decideLabelChange\(/m,
  },
  {
    surface: 'Governance',
    feature: 'scanning whose findings never disclose what they found',
    file: 'app/main/governance/dlp.ts',
    proof: /^export function scan\(/m,
  },
  {
    surface: 'Governance',
    feature: 'retention that reports rather than deletes',
    file: 'app/main/governance/retention.ts',
    proof: /^export function assess\(/m,
  },

  // ------------------------------------------------------ packaging --
  {
    surface: 'Shell',
    feature: 'update feed validated before anything acts on it',
    file: 'app/shared/updates.ts',
    proof: /^export function readFeed\(/m,
  },
  {
    surface: 'Shell',
    feature: 'a persistent non-blocking ready-to-restart banner',
    file: 'app/renderer/components/update-banner.ts',
    proof: /^export class UpdateBanner \{$/m,
  },
  {
    surface: 'Shell',
    feature: 'the ready banner states that the installer is unsigned',
    file: 'app/shared/updates.ts',
    proof: /^\s*'It will be installed when you restart\. The installer is UNSIGNED, so ' \+$/m,
  },
  {
    surface: 'Shell',
    feature: 'a real feed read from the releases of this repository',
    file: 'app/main/updates/update-service.ts',
    proof: /^export async function checkForUpdate\($/m,
  },
  {
    surface: 'Shell',
    feature: 'a download verified against the published hash before it is staged',
    file: 'app/main/updates/update-service.ts',
    proof: /^export async function downloadUpdate\($/m,
  },
  {
    surface: 'Shell',
    feature: 'only a staged installer can be run, and only when asked',
    file: 'app/main/main.ts',
    proof: /^\s*if \(path\.dirname\(resolved\) !== into \|\| !resolved\.toLowerCase\(\)\.endsWith\('\.exe'\)\) \{$/m,
  },
  {
    surface: 'Shell',
    feature: 'a jittered, backing-off background update schedule',
    file: 'app/renderer/index.ts',
    proof: /^\s*const scheduleNextCheck = \(\): void => \{$/m,
  },
  {
    surface: 'Shell',
    feature: 'the dim sum surprise, non-opt-out and non-blocking',
    file: 'app/shared/settings.ts',
    proof: /^\s*dimSum: DimSumState;$/m,
  },
];

function read(file: string): string {
  const full = path.join(ROOT, file);
  assert.ok(fs.existsSync(full), 'the inventory names a file that does not exist: ' + file);
  return fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
}

test('the inventory covers every surface the shell renders', () => {
  // Without this, deleting a surface's rows would make it silently exempt -
  // the guard reporting clean precisely because it stopped looking at that
  // surface. Every surface either has a row or is named here as covered by
  // its own drive script.
  const named = new Set(INVENTORY.map((row) => row.surface));
  const DRIVEN_ONLY = new Set([
    'Writer', 'Sheets', 'Slides', 'Draw', 'Formula',
    'Database', 'PDF', 'Notes', 'Forms', 'Notifications', 'Settings',
  ]);

  for (const surface of SURFACES) {
    assert.ok(
      named.has(surface) || DRIVEN_ONLY.has(surface),
      surface + ' has no inventory row and is not listed as drive-covered',
    );
  }
});

test('the inventory is not empty, so nothing below passes vacuously', () => {
  assert.ok(INVENTORY.length >= 30, 'only ' + INVENTORY.length + ' rows');
});

for (const row of INVENTORY) {
  const state = row.pending === undefined ? 'built' : 'pending';
  test('[' + state + '] ' + row.surface + ': ' + row.feature, () => {
    const source = read(row.file);
    assert.match(
      source,
      row.proof,
      row.file + ' no longer proves: ' + row.feature +
        (row.pending === undefined ? '' : ' (pending: ' + row.pending + ')'),
    );
  });
}

test('the pending rows are counted and named, so a gap is a decision', () => {
  // Reported rather than merely allowed. A gap nobody has written down is
  // indistinguishable from a gap nobody noticed, and this is the difference.
  const pending = INVENTORY.filter((row) => row.pending !== undefined);
  const lines = pending.map((row) => '  - ' + row.surface + ': ' + row.feature + ' - ' + row.pending);
  process.stdout.write(
    '\n[completeness] ' +
      (INVENTORY.length - pending.length) +
      ' of ' +
      INVENTORY.length +
      ' inventoried contracts are built. Still pending:\n' +
      lines.join('\n') +
      '\n\n',
  );

  for (const row of pending) {
    assert.ok(
      (row.pending ?? '').length > 20,
      row.surface + ': ' + row.feature + ' is pending with no real reason given',
    );
  }
});
