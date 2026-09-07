# The layout matrix

Every surface, at four display scales, at two window widths, in all three
language modes, in both themes. **960 combinations**, measured against the real
built application rather than looked at.

```
npm run verify:layout -- 9333 .tmp/layout
```

It exits non-zero when it finds anything, and writes
`docs/evidence/layout-report.json` with the full result.

## Why measured rather than captured

A capture matrix produces ninety-six pictures somebody has to look at. A person
scanning them finds the obvious breakages and misses the three-pixel truncation
on the longest bilingual label, which is the one that actually loses a word.

So this measures instead. The current run reports **0 findings across 960
tuples**; the first run reported **1211**.

## What it measures

| Finding | What it means |
| --- | --- |
| `document-overflow` | The page scrolls sideways. Content is off the edge with no way to know what. |
| `clipped` | An element's content is bigger than its box while the overflow is hidden, and the truncation is not disclosed. The words are gone with no scrollbar to say so. |
| `out-of-reach` | An interactive control outside the scrollable extent of whatever scrolls around it. It cannot be clicked at all. |
| `small-target` | An interactive control below the touch-target size **the application itself declares** in `--workspace-touch-target`. |

## What it deliberately does not report, and why each was learned the hard way

**A container that scrolls on purpose.** Reachability is measured against the
nearest ancestor that genuinely scrolls, not against the document. The shell's
scroller is a panel, so testing the document reported every home card below the
first row as unreachable when scrolling the panel reaches all of them - 372
findings that were all the measurement's fault.

**Truncation that ends in an ellipsis.** That is disclosed, which is the whole
difference between a defect and a design decision. **But only while every child
still fits**: an ellipsis discloses truncated *text* and says nothing about a
child element being cut off. Without that second half the exemption quietly
excused five real database-cell clippings, and the matrix reported clean on
defects that were plainly there.

**A screen-reader-only label, or a capture surface at zero opacity.** Both are
one pixel with far more content than that, by design.

**A frame the surface declares clips on purpose**, with `data-clip="viewport"`.
The spreadsheet's column and row headers are the case: an absolutely positioned
track slides behind a fixed window so the headers stay locked to the grid.
Declared rather than inferred, so a surface that starts clipping by accident
cannot quietly inherit the exemption.

**The page element itself.** The `document-overflow` check and reachability
already cover the page. Measured as an ordinary element it reports a phantom: a
scroll container's overflowing children inflate `body.scrollHeight` in this
engine even though the container clips them properly and every one is reachable.

## What it found, the first time it ran

- **780 clipped tab labels.** `.tab` had `overflow: hidden` and no
  `text-overflow`, so a long label was simply cut with nothing to say there was
  more of it.
- **Two panels wider than the box meant to contain them** - the writer at 841 in
  836, the database at 938 in 836 - because a flex item's automatic minimum size
  is its content, and neither the panel nor its child had `min-inline-size: 0`.
- **The history panel clipping its own entries**, 611 in a 527 box with the
  overflow hidden and no scrollbar.
- **A database mark button 2px wider than the cell that clipped it**, and header
  type labels sticking out past the ellipsis that could not reach them.
- **Every checkbox target at 16px** against a 36px declared target, because the
  associated label was not sized as the target it actually is.
- **Commit links at 24px, the attention field at 28px, reset buttons at 33px,
  slide thumbnails at 33px, an empty diff at 16px.** Each is the kind of
  few-pixel shortfall that no screenshot shows and no reviewer notices.

## Watching it fail

The matrix was broken on purpose three times before being trusted, and two of
those runs were more useful than the passing one:

1. Removing a fix and expecting red **stayed green** - which proved the fix was
   not what closed the finding. The comment in the stylesheet was corrected to
   say what was actually measured rather than what was assumed.
2. Removing a second fix **also stayed green** - which exposed the
   over-broad ellipsis exemption above, and led to the `childrenFit` half that
   then caught five real database defects.
3. Tightening the exemption turned the run red on exactly those five, and
   fixing them turned it green again.

A guard nobody has watched fail proves nothing. A guard that stays green when
you break its subject is worse: it proves the wrong thing confidently.

## Related

- [Editing one element's appearance](element-appearance.md)
- [Tabs and navigation](tabs.md) - the collapsed strip is the surface this found
  most in.
