// A fast single-pass reader for comma-separated text with a written broken-row policy.
//
// The text is read once, left to right. A byte-order mark (U+FEFF) at the very start is dropped. A record ends at
// LF or CRLF, and a line holding no characters is no record. Outside quotes a CR that is not followed by LF is
// dropped and reported (stray_cr). A field that opens with a quote runs to the next quote that is not doubled: a
// doubled quote inside stands for one quote, and each CRLF or lone CR inside the field is read as one LF. Whatever
// follows the closing quote, up to the next comma or line break, is appended to the field as it stands and reported
// (quote_junk) when any of it is kept. A quote that never closes is a literal character, and the text after it is
// read again as an unquoted field (unterminated_quote). A quote inside an unquoted field is a literal character.
// Fields stay strings, never trimmed and never converted.
//
// The answer is {columns, rows, errors}: columns is the first record when the input asks for a header, or null
// when it does not ask for one;
// rows holds the remaining records (every record when there is no header), each padded with empty strings
// (short_row) or cut (long_row) to the first record's width. Each error is {code, line, row} in the order met,
// line the 1-based line its record starts on (every LF, CRLF and lone CR inside a quoted field counted) and row
// the record's index in rows, null for the header.
//
// How it runs fast: most records hold no quote and no stray CR, so a record is first tried whole — the span up to
// its line break is checked against two remembered horizons (the next quote and the next CR at or after the read
// head; each horizon only ever moves forward, so the checks cost one pass over the text in total) and, when the
// span is clean, it is split into fields by comma hops and bulk slices. A record that is not clean falls back to
// the field scanner, which likewise hops between separator characters with indexOf and slices plain runs whole.
// Field readers report through shared outcome slots instead of a fresh result object per field.

const CODE_COMMA = 44;
const CODE_QUOTE = 34;
const CODE_LF = 10;
const CODE_CR = 13;
const CODE_BOM = 0xFEFF;

/** How a field ended: the record goes on, the record ends at a line break, or the record ends with the text. */
const ENDED_AT_COMMA = 0;
const ENDED_AT_BREAK = 1;
const ENDED_AT_TEXT_END = 2;

/** Horizon marker for "not looked yet"; a settled horizon is an index, or -1 when the character never comes again. */
const HORIZON_UNSET = -2;

/** The reading of one input {text, header}: {columns, rows, errors}. */
export function run(input) {
  const sourceText = String(input.text);
  const wantsHeader = input.header === true;
  const textLength = sourceText.length;
  const foundErrors = [];
  const keptRows = [];
  let headerColumns = null;
  let recordWidth = -1;

  let readingHead = 0; // the index of the next character to read
  let currentLineNo = 1; // the 1-based line the next character sits on
  if (sourceText.charCodeAt(0) === CODE_BOM) readingHead = 1;

  // The record being read: the line it starts on and the index in rows it takes (null while it is the header).
  let recordBirthLine = 1;
  let recordRowIndex = null;

  // The next quote and the next CR at or after the furthest point they were ever asked about.
  let quoteHorizon = HORIZON_UNSET;
  let crHorizon = HORIZON_UNSET;

  // The outcome slots the field readers fill in: the field's value, how it ended, characters kept past a seed.
  let outcomeValue = '';
  let outcomeEndedBy = ENDED_AT_TEXT_END;
  let outcomeKeptChars = 0;

  function noteError(errorCode) {
    foundErrors.push({ code: errorCode, line: recordBirthLine, row: recordRowIndex });
  }

  // The first quote at or after fromIndex, or -1; the horizon keeps the whole run to one forward sweep.
  function nextQuoteAt(fromIndex) {
    if (quoteHorizon === HORIZON_UNSET || (quoteHorizon !== -1 && quoteHorizon < fromIndex)) {
      quoteHorizon = sourceText.indexOf('"', fromIndex);
    }
    return quoteHorizon;
  }

  // The first CR at or after fromIndex, or -1, under the same horizon discipline as nextQuoteAt.
  function nextCrAt(fromIndex) {
    if (crHorizon === HORIZON_UNSET || (crHorizon !== -1 && crHorizon < fromIndex)) {
      crHorizon = sourceText.indexOf('\r', fromIndex);
    }
    return crHorizon;
  }

  // Steps over lines that hold no characters at all: bare LF and CRLF line breaks between records.
  function skipHollowLines() {
    let stillSkipping = true;
    while (stillSkipping && readingHead < textLength) {
      const leadCode = sourceText.charCodeAt(readingHead);
      const leadIsBreak = leadCode === CODE_LF || (leadCode === CODE_CR && sourceText.charCodeAt(readingHead + 1) === CODE_LF);
      if (leadCode === CODE_LF) {
        readingHead += 1;
        currentLineNo += 1;
      }
      if (leadCode === CODE_CR && sourceText.charCodeAt(readingHead + 1) === CODE_LF) {
        readingHead += 2;
        currentLineNo += 1;
      }
      if (!leadIsBreak) stillSkipping = false;
    }
  }

  // Reads unquoted characters onto `seedValue` up to the next comma or line break, filling the outcome slots. A
  // CR not followed by LF is dropped (stray_cr); keptChars counts the characters kept past the seed.
  function readBareField(seedValue) {
    let assembledValue = seedValue;
    let keptChars = 0;
    let endedBy = ENDED_AT_TEXT_END;
    let fieldOpen = true;
    while (fieldOpen) {
      const spanStart = readingHead;
      const commaAt = sourceText.indexOf(',', spanStart);
      const lfAt = sourceText.indexOf('\n', spanStart);
      let nearestAt = -1;
      let nearestCode = 0;
      if (commaAt !== -1) {
        nearestAt = commaAt;
        nearestCode = CODE_COMMA;
      }
      if (lfAt !== -1 && (nearestAt === -1 || lfAt < nearestAt)) {
        nearestAt = lfAt;
        nearestCode = CODE_LF;
      }
      // A CR matters only when it lands before the comma or break that would otherwise end this span.
      const crAt = nextCrAt(spanStart);
      if (crAt !== -1 && (nearestAt === -1 || crAt < nearestAt)) {
        nearestAt = crAt;
        nearestCode = CODE_CR;
      }
      if (nearestAt === -1) {
        assembledValue += sourceText.slice(spanStart, textLength);
        keptChars += textLength - spanStart;
        readingHead = textLength;
        endedBy = ENDED_AT_TEXT_END;
        fieldOpen = false;
      }
      if (nearestAt !== -1 && nearestCode === CODE_COMMA) {
        assembledValue += sourceText.slice(spanStart, nearestAt);
        keptChars += nearestAt - spanStart;
        readingHead = nearestAt + 1;
        endedBy = ENDED_AT_COMMA;
        fieldOpen = false;
      }
      if (nearestAt !== -1 && nearestCode === CODE_LF) {
        assembledValue += sourceText.slice(spanStart, nearestAt);
        keptChars += nearestAt - spanStart;
        readingHead = nearestAt + 1;
        currentLineNo += 1;
        endedBy = ENDED_AT_BREAK;
        fieldOpen = false;
      }
      if (nearestAt !== -1 && nearestCode === CODE_CR) {
        const crIsPair = sourceText.charCodeAt(nearestAt + 1) === CODE_LF;
        if (crIsPair) {
          assembledValue += sourceText.slice(spanStart, nearestAt);
          keptChars += nearestAt - spanStart;
          readingHead = nearestAt + 2;
          currentLineNo += 1;
          endedBy = ENDED_AT_BREAK;
          fieldOpen = false;
        }
        if (!crIsPair) {
          assembledValue += sourceText.slice(spanStart, nearestAt);
          keptChars += nearestAt - spanStart;
          noteError('stray_cr');
          readingHead = nearestAt + 1;
        }
      }
    }
    outcomeValue = assembledValue;
    outcomeEndedBy = endedBy;
    outcomeKeptChars = keptChars;
  }

  // Counts the line breaks inside the span [spanFrom, spanTo), which holds no CR: one per LF.
  function countPlainBreaks(spanFrom, spanTo) {
    let breakCount = 0;
    let huntHead = sourceText.indexOf('\n', spanFrom);
    while (huntHead !== -1 && huntHead < spanTo) {
      breakCount += 1;
      huntHead = sourceText.indexOf('\n', huntHead + 1);
    }
    return breakCount;
  }

  // Rebuilds the span [spanFrom, spanTo) with each CRLF or lone CR read as one LF, counting the lines it crosses.
  function foldQuotedSpan(spanFrom, spanTo) {
    let foldedValue = '';
    let walkHead = spanFrom;
    while (walkHead < spanTo) {
      const walkCode = sourceText.charCodeAt(walkHead);
      if (walkCode === CODE_CR) {
        foldedValue += '\n';
        currentLineNo += 1;
        walkHead += sourceText.charCodeAt(walkHead + 1) === CODE_LF ? 2 : 1;
      }
      if (walkCode === CODE_LF) {
        foldedValue += '\n';
        currentLineNo += 1;
        walkHead += 1;
      }
      if (walkCode !== CODE_CR && walkCode !== CODE_LF) {
        foldedValue += sourceText[walkHead];
        walkHead += 1;
      }
    }
    return foldedValue;
  }

  // Reads a quoted field whose opening quote sits at readingHead, filling the outcome slots.
  function readQuotedField() {
    const openingHead = readingHead;
    const openingLineNo = currentLineNo;
    readingHead += 1;
    let chunkStart = readingHead;
    let assembledValue = '';
    let quoteClosed = false;
    while (!quoteClosed) {
      const quoteAt = sourceText.indexOf('"', readingHead);
      if (quoteAt === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
        // The read head rewinds to just past the opening quote — the one backward step in the whole scan — so
        // both horizons are forgotten: each was settled from a point the rewind now sits behind.
        readingHead = openingHead + 1;
        currentLineNo = openingLineNo;
        quoteHorizon = HORIZON_UNSET;
        crHorizon = HORIZON_UNSET;
        noteError('unterminated_quote');
        readBareField('"');
        return;
      }
      const chunkCrAt = nextCrAt(chunkStart);
      const chunkHasCr = chunkCrAt !== -1 && chunkCrAt < quoteAt;
      if (chunkHasCr) {
        assembledValue += foldQuotedSpan(chunkStart, quoteAt);
      }
      if (!chunkHasCr) {
        currentLineNo += countPlainBreaks(chunkStart, quoteAt);
        assembledValue += sourceText.slice(chunkStart, quoteAt);
      }
      const afterQuoteCode = sourceText.charCodeAt(quoteAt + 1);
      if (afterQuoteCode === CODE_QUOTE) {
        assembledValue += '"';
        readingHead = quoteAt + 2;
        chunkStart = readingHead;
      }
      if (afterQuoteCode !== CODE_QUOTE) {
        readingHead = quoteAt + 1;
        quoteClosed = true;
      }
    }
    let fieldSettled = false;
    if (readingHead >= textLength) {
      outcomeValue = assembledValue;
      outcomeEndedBy = ENDED_AT_TEXT_END;
      outcomeKeptChars = 0;
      fieldSettled = true;
    }
    if (!fieldSettled) {
      const closingCode = sourceText.charCodeAt(readingHead);
      if (closingCode === CODE_COMMA) {
        readingHead += 1;
        outcomeValue = assembledValue;
        outcomeEndedBy = ENDED_AT_COMMA;
        outcomeKeptChars = 0;
        fieldSettled = true;
      }
      if (closingCode === CODE_LF) {
        readingHead += 1;
        currentLineNo += 1;
        outcomeValue = assembledValue;
        outcomeEndedBy = ENDED_AT_BREAK;
        outcomeKeptChars = 0;
        fieldSettled = true;
      }
      if (closingCode === CODE_CR && sourceText.charCodeAt(readingHead + 1) === CODE_LF) {
        readingHead += 2;
        currentLineNo += 1;
        outcomeValue = assembledValue;
        outcomeEndedBy = ENDED_AT_BREAK;
        outcomeKeptChars = 0;
        fieldSettled = true;
      }
    }
    if (!fieldSettled) {
      // What follows the closing quote is appended as it stands, up to the next comma or line break.
      readBareField(assembledValue);
      if (outcomeKeptChars > 0) noteError('quote_junk');
    }
  }

  // Takes a finished record: drops a hollow one, seats the header, fits data rows to the width, keeps the row.
  function absorbRecord(recordFields, lastFieldQuoted) {
    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    const recordIsHollow = recordFields.length === 1 && recordFields[0] === '' && !lastFieldQuoted;
    if (!recordIsHollow) {
      if (recordWidth < 0) recordWidth = recordFields.length;
      let becameHeader = false;
      if (wantsHeader && headerColumns === null) {
        headerColumns = recordFields;
        becameHeader = true;
      }
      if (!becameHeader) {
        if (recordFields.length < recordWidth) {
          foundErrors.push({ code: 'short_row', line: recordBirthLine, row: recordRowIndex, fields: recordFields.length });
          while (recordFields.length < recordWidth) recordFields.push('');
        }
        if (recordFields.length > recordWidth) {
          foundErrors.push({ code: 'long_row', line: recordBirthLine, row: recordRowIndex, extra: recordFields.splice(recordWidth) });
        }
        keptRows.push(recordFields);
      }
    }
  }

  // Tries to read the record at readingHead in one clean sweep: when the span up to its line break holds no
  // quote and no CR but its own CRLF ending, the record cannot span lines or break, so it splits on commas.
  // Reports whether the sweep took the record; on false, nothing was consumed and the field scanner takes over.
  function sweepCleanRecord() {
    const recordStart = readingHead;
    const lfAt = sourceText.indexOf('\n', recordStart);
    const spanEnd = lfAt === -1 ? textLength : lfAt;
    let contentEnd = spanEnd;
    if (lfAt !== -1 && contentEnd > recordStart && sourceText.charCodeAt(contentEnd - 1) === CODE_CR) {
      contentEnd -= 1;
    }
    const quoteAt = nextQuoteAt(recordStart);
    if (quoteAt !== -1 && quoteAt < contentEnd) return false;
    const strayCrAt = nextCrAt(recordStart);
    if (strayCrAt !== -1 && strayCrAt < contentEnd) return false;
    const sweptFields = [];
    let fieldStart = recordStart;
    let commaAt = sourceText.indexOf(',', fieldStart);
    while (commaAt !== -1 && commaAt < contentEnd) {
      sweptFields.push(sourceText.slice(fieldStart, commaAt));
      fieldStart = commaAt + 1;
      commaAt = sourceText.indexOf(',', fieldStart);
    }
    sweptFields.push(sourceText.slice(fieldStart, contentEnd));
    readingHead = lfAt === -1 ? textLength : lfAt + 1;
    if (lfAt !== -1) currentLineNo += 1;
    absorbRecord(sweptFields, false);
    return true;
  }

  let inputOpen = true;
  while (inputOpen) {
    skipHollowLines();
    if (readingHead >= textLength) inputOpen = false;
    if (readingHead < textLength) {
      recordBirthLine = currentLineNo;
      recordRowIndex = wantsHeader && headerColumns === null ? null : keptRows.length;
      const sweptAway = sweepCleanRecord();
      if (!sweptAway) {
        const recordFields = [];
        let lastFieldQuoted = false;
        let recordOpen = true;
        while (recordOpen) {
          const fieldOpensQuoted = sourceText.charCodeAt(readingHead) === CODE_QUOTE;
          lastFieldQuoted = fieldOpensQuoted;
          if (fieldOpensQuoted) readQuotedField();
          if (!fieldOpensQuoted) readBareField('');
          recordFields.push(outcomeValue);
          if (outcomeEndedBy !== ENDED_AT_COMMA) recordOpen = false;
        }
        absorbRecord(recordFields, lastFieldQuoted);
      }
    }
  }

  let columnsAnswer = headerColumns;
  if (wantsHeader && columnsAnswer === null) columnsAnswer = [];
  if (!wantsHeader) columnsAnswer = null;
  return { columns: columnsAnswer, rows: keptRows, errors: foundErrors };
}
