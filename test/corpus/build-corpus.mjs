/**
 * Build the conformance corpus.
 *
 * Every fixture is a REAL file on disk - a real zip container with the real
 * parts inside it - written in the XML shape the real producer emits. The tests
 * read those committed binaries; they never rebuild them and then read what
 * they just wrote, because a round trip through one module's own output proves
 * only that the module agrees with itself.
 *
 * WHY GENERATED RATHER THAN COLLECTED. A file saved by Word or LibreOffice
 * carries that application's licence, its metadata, and often a person's name.
 * Committing one to a public repository is a licensing question and a privacy
 * question at once. Generating the same SHAPES, with the provenance of each
 * shape recorded beside it, gives a corpus that can be committed, reviewed in a
 * diff, and corrected when a shape turns out to be wrong.
 *
 * WHAT THAT COSTS, SAID PLAINLY. A generated fixture cannot surprise us the way
 * a real file does. It contains what somebody thought a producer emits, and
 * where that belief is wrong the corpus is wrong in the same direction as the
 * reader. That is a real limitation and it is why every entry records where its
 * shape came from - so a wrong belief is correctable rather than invisible.
 *
 *   node test/corpus/build-corpus.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'files');

const encoder = new TextEncoder();

/* ------------------------------------------------------------------ zip -- */

/**
 * A minimal zip writer.
 *
 * Deflate rather than store, because a reader that only handles stored entries
 * passes every test against a corpus that only contains stored entries and then
 * fails on the first real file - every real producer deflates.
 */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (value) => Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
  const u32 = (value) =>
    Uint8Array.of(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  const crc32 = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;

    // An ODF package stores its `mimetype` entry UNCOMPRESSED and first, so the
    // media type is readable from the first few dozen bytes of the file without
    // unzipping anything. That is the entire reason it exists, and a corpus
    // that deflates it is a corpus no content sniffer can work against - which
    // is exactly how this was found.
    const stored = entry.name === 'mimetype';
    const body = stored ? raw : new Uint8Array(zlib.deflateRawSync(Buffer.from(raw)));
    const method = stored ? 0 : 8;
    const deflated = body;
    const crc = crc32(raw);

    const local = [
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(deflated.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      name,
      deflated,
    ];
    for (const part of local) chunks.push(part);

    central.push([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(deflated.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);

    let localSize = 0;
    for (const part of local) localSize += part.length;
    offset += localSize;
  }

  const centralStart = offset;
  for (const record of central) {
    for (const part of record) {
      chunks.push(part);
      offset += part.length;
    }
  }

  chunks.push(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(central.length),
    u16(central.length),
    u32(offset - centralStart),
    u32(centralStart),
    u16(0),
  );

  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/* -------------------------------------------------------------- wrappers -- */

const CONTENT_TYPES_DOCX =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const RELS_DOCX =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

function docx(bodyXml, extra = []) {
  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES_DOCX },
    { name: '_rels/.rels', data: RELS_DOCX },
    {
      name: 'word/document.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<w:body>' + bodyXml + '</w:body></w:document>',
    },
    ...extra,
  ]);
}

function xlsx(sheetXml, { sharedStrings = null, sheetName = 'Sheet1' } = {}) {
  const parts = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        (sharedStrings === null
          ? ''
          : '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="' + sheetName + '" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        (sharedStrings === null
          ? ''
          : '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>') +
        '</Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetData>' + sheetXml + '</sheetData></worksheet>',
    },
  ];

  if (sharedStrings !== null) {
    parts.push({
      name: 'xl/sharedStrings.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' +
        sharedStrings.length + '" uniqueCount="' + sharedStrings.length + '">' +
        sharedStrings.map((value) => '<si><t>' + value + '</t></si>').join('') +
        '</sst>',
    });
  }
  return zip(parts);
}

function odf(mimetype, bodyXml) {
  return zip([
    // The mimetype entry comes first in a real ODF package. Kept here for the
    // same reason: a reader that depends on the order should be tested against
    // a file that has it.
    { name: 'mimetype', data: mimetype },
    {
      name: 'META-INF/manifest.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
        '<manifest:file-entry manifest:full-path="/" manifest:media-type="' + mimetype + '"/>' +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
        '</manifest:manifest>',
    },
    { name: 'content.xml', data: bodyXml },
  ]);
}

const ODF_NAMESPACES =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:office-value="urn:oasis:names:tc:opendocument:xmlns:office:1.0"';


/** One text shape, positioned in EMU. */
function shape(text, placeholder, x, y, cx, cy) {
  return (
    '<p:sp><p:nvSpPr>' +
    '<p:cNvPr id="2" name="' + (placeholder ?? 'Text') + '"/><p:cNvSpPr txBox="1"/>' +
    '<p:nvPr>' + (placeholder === null ? '' : '<p:ph type="' + placeholder + '"/>') + '</p:nvPr>' +
    '</p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/>' +
    '<a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:r><a:rPr lang="en" sz="2400"/><a:t>' + text + '</a:t></a:r></a:p>' +
    '</p:txBody></p:sp>'
  );
}

/** A shape whose text is several paragraphs, which is how a list is stored. */
function multiline(lines, x, y, cx, cy) {
  return (
    '<p:sp><p:nvSpPr>' +
    '<p:cNvPr id="3" name="Body"/><p:cNvSpPr txBox="1"/>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr>' +
    '</p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/>' +
    '<a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' +
    lines.map((line) => '<a:p><a:r><a:t>' + line + '</a:t></a:r></a:p>').join('') +
    '</p:txBody></p:sp>'
  );
}

function pptx(slides, { notes = {} } = {}) {
  const parts = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'ppt/presentation.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<p:sldIdLst>' +
        slides
          .map((entry, index) => '<p:sldId id="' + (256 + index) + '" r:id="rId' + (index + 1) + '"/>')
          .join('') +
        '</p:sldIdLst>' +
        // 12192000 x 6858000 EMU is the standard 16:9 size PowerPoint writes.
        '<p:sldSz cx="12192000" cy="6858000"/>' +
        '</p:presentation>',
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        slides
          .map(
            (entry, index) =>
              '<Relationship Id="rId' + (index + 1) + '" ' +
              'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ' +
              'Target="slides/' + entry.part + '"/>',
          )
          .join('') +
        '</Relationships>',
    },
  ];

  for (const entry of slides) {
    parts.push({
      name: 'ppt/slides/' + entry.part,
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<p:cSld><p:spTree>' +
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
        '<p:grpSpPr/>' + entry.shapes +
        '</p:spTree></p:cSld></p:sld>',
    });

    const note = notes[entry.part];
    if (note !== undefined) {
      parts.push({
        name: 'ppt/slides/_rels/' + entry.part + '.rels',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" ' +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" ' +
          'Target="../notesSlides/notes-' + entry.part + '"/>' +
          '</Relationships>',
      });
      parts.push({
        name: 'ppt/notesSlides/notes-' + entry.part,
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
          'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
          '<p:cSld><p:spTree>' +
          '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
          '<p:grpSpPr/>' +
          // The notes part carries the SLIDE's own text in a placeholder too.
          // A reader taking every <a:t> here shows the slide body twice.
          '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder"/>' +
          '<p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr>' +
          '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' +
          '<a:p><a:r><a:t>' + note.echo + '</a:t></a:r></a:p>' +
          '</p:txBody></p:sp>' +
          '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder"/>' +
          '<p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
          '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' +
          note.text
            .split('\n')
            .map((line) => '<a:p><a:r><a:t>' + line + '</a:t></a:r></a:p>')
            .join('') +
          '</p:txBody></p:sp>' +
          '</p:spTree></p:cSld></p:notes>',
      });
    }
  }

  return zip(parts);
}

const ODP_NAMESPACES =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';

function odp(pagesXml) {
  return zip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.presentation' },
    {
      name: 'META-INF/manifest.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
        '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>' +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
        '</manifest:manifest>',
    },
    {
      name: 'styles.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<office:document-styles ' + ODP_NAMESPACES + ' office:version="1.3">' +
        '<office:automatic-styles><style:page-layout style:name="PM1">' +
        // Written in centimetres with the unit attached, as ODF does. A reader
        // that calls Number() on this gets NaN.
        '<style:page-layout-properties fo:page-width="33.867cm" fo:page-height="19.05cm"/>' +
        '</style:page-layout></office:automatic-styles>' +
        '</office:document-styles>',
    },
    {
      name: 'content.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<office:document-content ' + ODP_NAMESPACES + ' office:version="1.3">' +
        '<office:body><office:presentation>' + pagesXml +
        '</office:presentation></office:body></office:document-content>',
    },
  ]);
}

/**
 * A real PDF, with a real cross-reference table.
 *
 * Byte offsets in the xref have to be the ACTUAL offsets, so the file is built
 * once and measured rather than assembled from guesses. A file whose xref is
 * wrong still opens in a forgiving reader, which is exactly why a corpus that
 * fakes it proves nothing about a reader that follows the table.
 */
function pdf(contentStream, { mediaBox = '0 0 612 792' } = {}) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [' + mediaBox + '] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    // The content stream, whose length must match its real byte length: a
    // wrong /Length truncates the stream in any reader that trusts it.
    '<< /Length ' + encoder.encode(contentStream).length + ' >>\nstream\n' +
      contentStream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let body = '%PDF-1.7\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(body).length);
    body += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });

  const xrefAt = encoder.encode(body).length;
  body += 'xref\n0 ' + (objects.length + 1) + '\n';
  body += '0000000000 65535 f \n';
  for (const offset of offsets) {
    body += String(offset).padStart(10, '0') + ' 00000 n \n';
  }
  body +=
    'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\n' +
    'startxref\n' + xrefAt + '\n%%EOF\n';

  return encoder.encode(body);
}

/* ------------------------------------------------------------ the corpus -- */

/**
 * Every fixture, with what it covers and where its shape came from.
 *
 * `expects` is what MUST survive. `loses` is what is knowingly not carried, and
 * every entry there is a promise the tests check too: a "loss" that turns out to
 * survive is a note that has gone stale, and a note that has gone stale is how
 * somebody comes to distrust all of them.
 */
export const CORPUS = [
  // ------------------------------------------------------------- docx --
  {
    file: 'docx/paragraphs.docx',
    format: 'docx',
    feature: 'paragraphs, runs, and a line break inside a paragraph',
    shape:
      'Word emits one <w:p> per paragraph and <w:br/> for a soft break inside ' +
      'one. Treating each <w:p> as a line loses the distinction entirely.',
    build: () =>
      docx(
        '<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Second</w:t><w:br/><w:t>after a break</w:t></w:r></w:p>',
      ),
    expects: { paragraphs: 2, text: ['First paragraph.', 'Second\nafter a break'] },
  },
  {
    file: 'docx/table.docx',
    format: 'docx',
    feature: 'a table with a repeating header row and a declared column grid',
    shape:
      'A <w:tbl> is a SIBLING of <w:p> in the body, not a child of one, so a ' +
      'reader that walks only <w:p> loses the table and every paragraph inside ' +
      'it. <w:tblHeader> in <w:trPr> is what makes the row repeat on each page, ' +
      'and <w:tblGrid>/<w:gridCol w:w> carries the widths in TWENTIETHS of a ' +
      'point - reading them as points gives a table a twentieth of its width.',
    build: () =>
      docx(
        '<w:p><w:r><w:t>Before</w:t></w:r></w:p>' +
          '<w:tbl>' +
          '<w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
          '<w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="1200"/></w:tblGrid>' +
          '<w:tr><w:trPr><w:tblHeader/></w:trPr>' +
          '<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>' +
          '<w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc>' +
          '<w:tc><w:tcPr><w:tcW w:w="1200" w:type="dxa"/></w:tcPr>' +
          '<w:p><w:r><w:t>Amount</w:t></w:r></w:p></w:tc>' +
          '</w:tr>' +
          '<w:tr>' +
          '<w:tc><w:p><w:r><w:t>Chan</w:t></w:r></w:p></w:tc>' +
          '<w:tc><w:p><w:r><w:t>30</w:t></w:r></w:p></w:tc>' +
          '</w:tr>' +
          '<w:tr>' +
          '<w:tc><w:p><w:r><w:t>Au</w:t></w:r></w:p></w:tc>' +
          '<w:tc><w:p/></w:tc>' +
          '</w:tr>' +
          '</w:tbl>' +
          '<w:p><w:r><w:t>After</w:t></w:r></w:p>',
      ),
    expects: { rows: 3, columns: 2, headerRows: 1, gridWidths: [2400, 1200] },
  },
  {
    file: 'docx/formatting.docx',
    format: 'docx',
    feature: 'bold, italic and underline, including an explicit OFF',
    shape:
      '<w:b/> is on, <w:b w:val="0"/> is explicitly off, and absent inherits. ' +
      'A reader that treats presence as on marks the second run bold.',
    build: () =>
      docx(
        '<w:p>' +
          '<w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>' +
          '<w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>not bold</w:t></w:r>' +
          '<w:r><w:rPr><w:i/><w:u w:val="single"/></w:rPr><w:t>italic underlined</w:t></w:r>' +
          '</w:p>',
      ),
    expects: {
      runs: [
        { text: 'bold', bold: true },
        { text: 'not bold', bold: false },
        { text: 'italic underlined', italic: true, underline: true },
      ],
    },
  },
  {
    file: 'docx/styles.docx',
    format: 'docx',
    feature: 'a paragraph style reference',
    shape:
      '<w:pStyle w:val="Heading1"/> names a style ID, not a display name. The ' +
      'display name lives in styles.xml and is localised.',
    build: () =>
      docx(
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>A heading</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>',
      ),
    expects: { styleOfFirst: 'Heading1', styleOfSecond: null },
  },
  {
    file: 'docx/lists.docx',
    format: 'docx',
    feature: 'a numbered list whose numbering part says it is ordered',
    shape:
      '<w:numPr> carries <w:ilvl> and <w:numId>, and the list TYPE lives in ' +
      'numbering.xml - numId points at an abstract definition whose numFmt is ' +
      'decimal for an ordered list and bullet for an unordered one. Note there ' +
      'is NO pStyle here: Word usually writes ListParagraph beside numPr, but ' +
      'it is not required to and Google Docs export and pandoc do not.',
    build: () =>
      docx(
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>' +
          '<w:r><w:t>One</w:t></w:r></w:p>' +
          '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr></w:pPr>' +
          '<w:r><w:t>Nested</w:t></w:r></w:p>',
        [
          {
            name: 'word/numbering.xml',
            data:
              '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
              '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
              '<w:abstractNum w:abstractNumId="7">' +
              '<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>' +
              '</w:abstractNum>' +
              '<w:num w:numId="2"><w:abstractNumId w:val="7"/></w:num>' +
              '</w:numbering>',
          },
        ],
      ),
    expects: { kinds: ['numbered', 'numbered'] },
  },
  {
    file: 'docx/lists-unknown-numbering.docx',
    format: 'docx',
    feature: 'a list whose numbering part is absent, which cannot be known ordered',
    shape:
      'A document that references a numId with no numbering.xml to resolve it ' +
      'is common in fragments and in files written by tools that strip parts ' +
      'they do not understand. Bullet is the safe default: guessing ordered ' +
      'invents numbers the author never wrote.',
    build: () =>
      docx(
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="9"/></w:numPr></w:pPr>' +
          '<w:r><w:t>Unresolvable</w:t></w:r></w:p>',
      ),
    expects: { kinds: ['bullet'] },
  },
  {
    file: 'docx/tabs-and-entities.docx',
    format: 'docx',
    feature: 'tabs, and XML entities that must survive decoding',
    shape:
      'A tab is <w:tab/>, not a character. Ampersands and angle brackets arrive ' +
      'escaped and a reader that forgets to decode shows them raw.',
    build: () =>
      docx(
        '<w:p><w:r><w:t>Before</w:t><w:tab/><w:t>After</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Tom &amp; Jerry &lt;here&gt;</w:t></w:r></w:p>',
      ),
    expects: { text: ['Before\tAfter', 'Tom & Jerry <here>'] },
  },
  {
    file: 'docx/preserved-space.docx',
    format: 'docx',
    feature: 'xml:space="preserve", which carries meaningful whitespace',
    shape:
      'Word marks a run whose leading or trailing space matters. A reader that ' +
      'trims every run silently joins words together.',
    build: () =>
      docx(
        '<w:p>' +
          '<w:r><w:t xml:space="preserve">one </w:t></w:r>' +
          '<w:r><w:t xml:space="preserve">two</w:t></w:r>' +
          '</w:p>',
      ),
    expects: { text: ['one two'] },
  },

  // ------------------------------------------------------------- xlsx --
  {
    file: 'xlsx/shared-strings.xlsx',
    format: 'xlsx',
    feature: 'shared strings, where the cell holds an INDEX',
    shape:
      'A cell marked t="s" holds an index into sharedStrings.xml. A reader that ' +
      'takes the value literally shows 0 and 1, which look plausible and are wrong.',
    build: () =>
      xlsx(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
        { sharedStrings: ['Alpha', 'Beta'] },
      ),
    expects: { cells: { A1: 'Alpha', B1: 'Beta' } },
  },
  {
    file: 'xlsx/numbers-and-booleans.xlsx',
    format: 'xlsx',
    feature: 'numbers, and booleans that are 0 or 1',
    shape:
      'A number has no t attribute. A boolean is t="b" with 0 or 1, and a reader ' +
      'that treats it as a number shows 1 where the sheet says TRUE.',
    build: () =>
      xlsx(
        '<row r="1"><c r="A1"><v>42</v></c><c r="B1"><v>-3.5</v></c>' +
          '<c r="C1" t="b"><v>1</v></c><c r="D1" t="b"><v>0</v></c></row>',
      ),
    expects: { cells: { A1: 42, B1: -3.5, C1: true, D1: false } },
  },
  {
    file: 'xlsx/formulas.xlsx',
    format: 'xlsx',
    feature: 'a formula cell, which carries both the formula and its last value',
    shape:
      '<f> holds the formula and <v> the value the producing application last ' +
      'computed. Keeping only the value loses the sheet; keeping only the ' +
      'formula means an unopened file shows nothing.',
    build: () =>
      xlsx(
        '<row r="1"><c r="A1"><v>2</v></c><c r="B1"><v>3</v></c>' +
          '<c r="C1"><f>A1+B1</f><v>5</v></c></row>',
      ),
    expects: { formula: '=A1+B1', value: 5 },
  },
  {
    file: 'xlsx/inline-strings.xlsx',
    format: 'xlsx',
    feature: 'an inline string, which some producers emit instead of a shared one',
    shape:
      't="inlineStr" with <is><t>. Exporters that stream rows commonly emit ' +
      'these because they cannot build a shared table in one pass.',
    build: () =>
      xlsx('<row r="1"><c r="A1" t="inlineStr"><is><t>Inline</t></is></c></row>'),
    expects: { cells: { A1: 'Inline' } },
  },
  {
    file: 'xlsx/sparse-rows.xlsx',
    format: 'xlsx',
    feature: 'gaps: a sheet does not emit empty cells or empty rows',
    shape:
      'Real sheets skip empty cells entirely and jump row numbers. A reader ' +
      'that assumes cells arrive contiguously puts values in the wrong places.',
    build: () =>
      xlsx(
        '<row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row>' +
          '<row r="5"><c r="B5"><v>25</v></c></row>',
      ),
    expects: { cells: { A1: 1, D1: 4, B5: 25 }, empty: ['B1', 'A5'] },
  },

  // -------------------------------------------------------------- odf --
  {
    file: 'odt/table.odt',
    format: 'odt',
    feature: 'an ODF table whose header rows sit in their own element',
    shape:
      'ODF puts header rows inside <table:table-header-rows>, NOT among the ' +
      'ordinary <table:table-row> children - so a reader that walks only the ' +
      'latter loses the headings and comes back a row short. ' +
      '<table:number-columns-repeated> means "n of these" on both columns and ' +
      'cells; counting elements instead gives one where the file declares three.',
    build: () =>
      odf(
        'application/vnd.oasis.opendocument.text',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<office:document-content ' + ODF_NAMESPACES + '>' +
          '<office:body><office:text>' +
          '<table:table table:name="T1">' +
          '<table:table-column table:number-columns-repeated="2"/>' +
          '<table:table-header-rows>' +
          '<table:table-row>' +
          '<table:table-cell><text:p>Name</text:p></table:table-cell>' +
          '<table:table-cell><text:p>Amount</text:p></table:table-cell>' +
          '</table:table-row>' +
          '</table:table-header-rows>' +
          '<table:table-row>' +
          '<table:table-cell><text:p>Chan</text:p></table:table-cell>' +
          '<table:table-cell><text:p>30</text:p></table:table-cell>' +
          '</table:table-row>' +
          '</table:table>' +
          '</office:text></office:body></office:document-content>',
      ),
    expects: { rows: 2, columns: 2, headerRows: 1 },
  },
  {
    file: 'odt/paragraphs.odt',
    format: 'odt',
    feature: 'paragraphs and headings in an ODF text document',
    shape:
      'A heading is <text:h> with an outline level, NOT a styled paragraph. A ' +
      'reader that only handles <text:p> drops every heading in the document.',
    build: () =>
      odf(
        'application/vnd.oasis.opendocument.text',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<office:document-content ' + ODF_NAMESPACES + '>' +
          '<office:body><office:text>' +
          '<text:h text:outline-level="1">A heading</text:h>' +
          '<text:p>Body text.</text:p>' +
          '</office:text></office:body></office:document-content>',
      ),
    expects: { paragraphs: 2, headingLevel: 1 },
  },
  {
    file: 'odt/spaces.odt',
    format: 'odt',
    feature: 'repeated spaces, which ODF encodes as an element',
    shape:
      'ODF collapses whitespace in XML and encodes runs of spaces as ' +
      '<text:s text:c="n"/>. A reader that ignores it silently squashes them.',
    build: () =>
      odf(
        'application/vnd.oasis.opendocument.text',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<office:document-content ' + ODF_NAMESPACES + '>' +
          '<office:body><office:text>' +
          '<text:p>one<text:s text:c="3"/>two</text:p>' +
          '</office:text></office:body></office:document-content>',
      ),
    expects: { text: ['one   two'] },
  },
  {
    file: 'ods/values.ods',
    format: 'ods',
    feature: 'typed cell values in an ODF spreadsheet',
    shape:
      'A value lives in office:value-type plus its typed attribute, and the ' +
      'visible <text:p> is only a rendering. Reading the text gives a string ' +
      'where the sheet holds a number.',
    build: () =>
      odf(
        'application/vnd.oasis.opendocument.spreadsheet',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<office:document-content ' + ODF_NAMESPACES + '>' +
          '<office:body><office:spreadsheet>' +
          '<table:table table:name="Sheet1">' +
          '<table:table-row>' +
          '<table:table-cell office:value-type="float" office:value="42"><text:p>42</text:p></table:table-cell>' +
          '<table:table-cell office:value-type="string"><text:p>Alpha</text:p></table:table-cell>' +
          '<table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>TRUE</text:p></table:table-cell>' +
          '</table:table-row>' +
          '</table:table>' +
          '</office:spreadsheet></office:body></office:document-content>',
      ),
    expects: { cells: { A1: 42, B1: 'Alpha', C1: true } },
  },
  {
    file: 'ods/repeated-cells.ods',
    format: 'ods',
    feature: 'table:number-columns-repeated, which ODF uses instead of repeating',
    shape:
      'A row of identical cells is emitted once with a repeat count, and a ' +
      'trailing empty repeat of 1000 columns is normal. A reader that expands ' +
      'blindly allocates a million cells for an empty sheet.',
    build: () =>
      odf(
        'application/vnd.oasis.opendocument.spreadsheet',
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<office:document-content ' + ODF_NAMESPACES + '>' +
          '<office:body><office:spreadsheet>' +
          '<table:table table:name="Sheet1">' +
          '<table:table-row>' +
          '<table:table-cell office:value-type="float" office:value="7" table:number-columns-repeated="3">' +
          '<text:p>7</text:p></table:table-cell>' +
          '<table:table-cell table:number-columns-repeated="1000"/>' +
          '</table:table-row>' +
          '</table:table>' +
          '</office:spreadsheet></office:body></office:document-content>',
      ),
    expects: { cells: { A1: 7, B1: 7, C1: 7 }, empty: ['D1'] },
  },

  // ------------------------------------------------------------- pptx --
  {
    file: 'pptx/order-and-titles.pptx',
    format: 'pptx',
    feature: 'slide ORDER from presentation.xml, and titles by placeholder',
    shape:
      'The part names here are deliberately out of order - the second slide in ' +
      'the deck is stored as slide9.xml. PowerPoint names parts arbitrarily and ' +
      'the order lives in <p:sldIdLst>, so a reader that sorts by filename gets ' +
      'this deck backwards. The title is <p:ph type="title"/>, and here it is ' +
      'the SECOND shape on the slide so that taking the first one is wrong.',
    build: () =>
      pptx([
        {
          part: 'slide9.xml',
          shapes:
            shape('Body first, deliberately', null, 914400, 2743200, 10363200, 1828800) +
            shape('The real title', 'title', 914400, 457200, 10363200, 1143000),
        },
        {
          part: 'slide1.xml',
          shapes: shape('Second slide', 'title', 914400, 457200, 10363200, 1143000),
        },
      ]),
    expects: { titles: ['The real title', 'Second slide'] },
  },
  {
    file: 'pptx/emu-geometry.pptx',
    format: 'pptx',
    feature: 'EMU positions, which are not points',
    shape:
      'a:off and a:ext are English Metric Units: 914400 to the inch, 12700 to ' +
      'the point. A reader that treats them as points puts every shape 12700 ' +
      'times too far out, and the slide presents as empty rather than as wrong.',
    build: () =>
      pptx([
        {
          part: 'slide1.xml',
          // Exactly a quarter across and a fifth down on a 12192000 x 6858000
          // slide, so the normalised result is checkable to the decimal.
          shapes: shape('Placed', 'title', 3048000, 1371600, 6096000, 1371600),
        },
      ]),
    expects: { frame: { x: 0.25, y: 0.2, width: 0.5, height: 0.2 } },
  },
  {
    file: 'pptx/paragraphs-and-notes.pptx',
    format: 'pptx',
    feature: 'paragraphs of runs, and notes that are not the slide text',
    shape:
      'Each <a:p> is a line and each <a:r> a run within it, so concatenating ' +
      'every <a:t> turns a list into one sentence. The notes part ALSO carries ' +
      'the slide text in a placeholder, so a reader taking all of its text ' +
      'shows the body twice in the presenter view.',
    build: () =>
      pptx(
        [
          {
            part: 'slide1.xml',
            shapes:
              shape('Deck title', 'title', 914400, 457200, 10363200, 1143000) +
              multiline(['First point', 'Second point'], 914400, 2286000, 10363200, 2743200),
          },
        ],
        {
          notes: {
            'slide1.xml': {
              echo: 'Deck title',
              text: 'Say the thing.\nThen pause.',
            },
          },
        },
      ),
    expects: { body: 'First point\nSecond point', notes: 'Say the thing.\nThen pause.' },
  },

  // -------------------------------------------------------------- odp --
  {
    file: 'odp/units.odp',
    format: 'odp',
    feature: 'lengths carrying their unit, which Number() cannot read',
    shape:
      'ODF writes svg:x="8.467cm" and svg:width="16.933cm". Number("8.467cm") ' +
      'is NaN, and NaN in a frame is a shape at the origin with no size - which ' +
      'presents as a slide whose content failed to load rather than as one in ' +
      'the wrong place. This fixture mixes cm and in so both paths are covered.',
    build: () =>
      odp(
        '<draw:page draw:name="page1">' +
          '<draw:frame presentation:class="title" svg:x="8.467cm" svg:y="3.81cm" ' +
          'svg:width="16.933cm" svg:height="3.81cm">' +
          '<draw:text-box><text:p>Quarter across</text:p></draw:text-box></draw:frame>' +
          '<draw:frame presentation:class="outline" svg:x="1in" svg:y="1in" ' +
          'svg:width="2in" svg:height="1in">' +
          '<draw:text-box><text:p>Inches too</text:p></draw:text-box></draw:frame>' +
          '</draw:page>',
      ),
    expects: { titleFrame: { x: 0.25, y: 0.2 } },
  },
  {
    file: 'odp/notes-and-spaces.odp',
    format: 'odp',
    feature: 'notes inside the page, and encoded runs of spaces',
    shape:
      '<presentation:notes> is a CHILD of the page - the opposite of OOXML, ' +
      'where notes are a separate related part. A reader written for OOXML ' +
      'goes looking for a part, finds none, and reports every slide as ' +
      'unnoted. Spaces are <text:s text:c="n"/> as everywhere in ODF.',
    build: () =>
      odp(
        '<draw:page draw:name="page1">' +
          '<draw:frame presentation:class="title" svg:x="1cm" svg:y="1cm" ' +
          'svg:width="10cm" svg:height="2cm">' +
          '<draw:text-box><text:p>Gap<text:s text:c="3"/>here</text:p></draw:text-box>' +
          '</draw:frame>' +
          '<presentation:notes>' +
          '<draw:frame presentation:class="notes" svg:x="1cm" svg:y="1cm" ' +
          'svg:width="10cm" svg:height="5cm">' +
          '<draw:text-box><text:p>Remember the thing.</text:p></draw:text-box>' +
          '</draw:frame>' +
          '</presentation:notes>' +
          '</draw:page>',
      ),
    expects: { text: 'Gap   here', notes: 'Remember the thing.' },
  },

  // -------------------------------------------------------------- pdf --
  {
    file: 'pdf/rectangles.pdf',
    format: 'pdf',
    feature: 'filled rectangles, colour, and the upward Y axis',
    shape:
      'PDF puts the origin at the BOTTOM-LEFT and Y increases upward. A renderer ' +
      'that draws straight onto screen coordinates puts every page upside down, ' +
      'and on a page of centred content that looks very nearly right. This ' +
      'fixture puts a red box low on the page and a blue box high on it, so a ' +
      'flip swaps them and is caught.',
    build: () =>
      pdf(
        // Red, near the bottom in PDF space.
        '1 0 0 rg\n72 72 144 72 re\nf\n' +
        // Blue, near the top.
        '0 0 1 rg\n72 648 144 72 re\nf\n',
      ),
    expects: { redLow: true, blueHigh: true },
  },
  {
    file: 'pdf/transforms.pdf',
    format: 'pdf',
    feature: 'the CTM stack: q, Q, and cm concatenating rather than replacing',
    shape:
      'cm CONCATENATES onto the current matrix. A renderer that assigns loses ' +
      'every nested transform, and a shape inside two of them lands where the ' +
      'inner one alone would put it. Here a translate wraps a translate, so ' +
      'assignment and concatenation give different answers.',
    build: () =>
      pdf(
        'q\n' +
        '1 0 0 1 100 100 cm\n' +
        'q\n' +
        '1 0 0 1 50 50 cm\n' +
        // At 0,0 in the doubly translated space, so 150,150 on the page.
        '0 g\n0 0 40 40 re\nf\n' +
        'Q\n' +
        'Q\n' +
        // And one outside every transform, to prove Q restored.
        '0 g\n400 400 40 40 re\nf\n',
      ),
    expects: { innerAt: [150, 150], outerAt: [400, 400] },
  },
  {
    file: 'pdf/paths-not-painted.pdf',
    format: 'pdf',
    feature: 'a path built and NOT painted, which is what n means',
    shape:
      're appends a subpath; it does not paint. Painting happens at f, S or B, ' +
      'and `n` ends the path having painted nothing - which is how a clipping ' +
      'rectangle is expressed. A renderer that paints on re fills every clip ' +
      'region in the file with the current colour.',
    build: () =>
      pdf(
        // A big rectangle that is never painted.
        '1 0 0 rg\n0 0 612 792 re\nn\n' +
        // A small one that is.
        '0 1 0 rg\n300 300 60 60 re\nf\n',
      ),
    expects: { painted: 1 },
  },
  {
    file: 'pdf/text-positions.pdf',
    format: 'pdf',
    feature: 'text placement through Tm and Td, and TJ kerning that is not content',
    shape:
      'Tm sets the text and line matrices; Td MOVES the line matrix and resets ' +
      'the text matrix to it. Treating them as one puts the second line of ' +
      'every paragraph in the wrong place. Inside TJ, a number is a kern in ' +
      'thousandths of an em - never content - and a reader that appends it ' +
      'writes the kerning values into the page.',
    build: () =>
      pdf(
        'BT\n/F1 24 Tf\n1 0 0 1 72 700 Tm\n(First line) Tj\n' +
        '0 -30 Td\n[(Ker) -120 (ned)] TJ\n' +
        'ET\n',
      ),
    expects: { lines: ['First line', 'Kerned'] },
  },

  // -------------------------------------------- footnotes and fields --
  {
    file: 'docx/footnotes.docx',
    format: 'docx',
    feature: 'footnote references in the body, and the notes in their own part',
    shape:
      'The marker is <w:footnoteReference w:id="2"/> - an ELEMENT inside a run, ' +
      'not a character. A reader that collects only <w:t> keeps every note and ' +
      'loses every reference, which presents as notes belonging to nothing. ' +
      'The notes live in word/footnotes.xml, and the first two entries there ' +
      'are NOT notes: Word writes a separator and a continuation separator ' +
      'with ids -1 and 0, so a reader that takes every <w:footnote> shows two ' +
      'empty notes at the top of every document that has any.',
    build: () =>
      docx(
        '<w:p><w:r><w:t xml:space="preserve">A claim worth citing</w:t></w:r>' +
          '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>' +
          '<w:footnoteReference w:id="2"/></w:r>' +
          '<w:r><w:t xml:space="preserve"> and the rest of the sentence.</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>A second paragraph</w:t></w:r>' +
          '<w:r><w:footnoteReference w:id="3"/></w:r></w:p>',
        [
          {
            name: 'word/footnotes.xml',
            data:
              '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
              '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
              '<w:footnote w:type="separator" w:id="-1">' +
              '<w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
              '<w:footnote w:type="continuationSeparator" w:id="0">' +
              '<w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
              '<w:footnote w:id="2"><w:p>' +
              '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>' +
              '<w:r><w:t xml:space="preserve">The source of the claim.</w:t></w:r>' +
              '</w:p></w:footnote>' +
              '<w:footnote w:id="3"><w:p>' +
              '<w:r><w:footnoteRef/></w:r>' +
              '<w:r><w:t>A second note.</w:t></w:r>' +
              '</w:p></w:footnote>' +
              '</w:footnotes>',
          },
        ],
      ),
    expects: { notes: 2, refs: [['2'], ['3']] },
  },
  {
    file: 'docx/contents-field.docx',
    format: 'docx',
    feature: 'a table of contents written as a FIELD, in the complex form',
    shape:
      'Word writes a TOC as fldChar begin, an instrText carrying the ' +
      'instruction, fldChar separate, the frozen text a reader without the ' +
      'field sees, and fldChar end. A reader that only handles <w:fldSimple> ' +
      'sees the frozen text and no field, so a refresh either does nothing or ' +
      'appends a second contents beside the first.',
    build: () =>
      docx(
        '<w:p>' +
          '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
          '<w:r><w:instrText xml:space="preserve"> TOC \\o &quot;1-3&quot; \\h </w:instrText></w:r>' +
          '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
          '<w:r><w:t>Introduction</w:t><w:tab/><w:t>1</w:t></w:r>' +
          '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
          '</w:p>' +
          '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' +
          '<w:r><w:t>Introduction</w:t></w:r></w:p>',
      ),
    expects: { field: 'TOC', frozen: 'Introduction' + String.fromCharCode(9) + '1' },
  },
];

/* ------------------------------------------------------------------ main -- */

if (process.argv[1] && process.argv[1].endsWith('build-corpus.mjs')) {
  fs.rmSync(OUT, { recursive: true, force: true });

  for (const entry of CORPUS) {
    const target = path.join(OUT, entry.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.build());
    process.stdout.write(
      '[corpus] ' + entry.file.padEnd(32) + fs.statSync(target).size + ' bytes\n',
    );
  }

  process.stdout.write('[corpus] ' + CORPUS.length + ' fixtures written to ' + OUT + '\n');
}
