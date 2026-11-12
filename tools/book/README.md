# Book builder

Builds [`docs/wiki/PgCloud_The_Master_Book.pdf`](../../docs/wiki/PgCloud_The_Master_Book.pdf). Version 1.2.0 is the
1.1.0 book plus **chapter 7, "What's new in 1.2.0"**, with the version references updated. Chapters 1–6 are kept page for
page.

| File | What it is |
|---|---|
| `build.py` | Assembles the book: inserts chapter 7 before the back cover, adds it to the contents page and the bookmarks, sets the date and version on page 3, and turns the mentions of the current version in chapters 4–6 into 1.2.0 |
| `ch7.py` | Text of chapter 7 (ReportLab flowables) |
| `bookstyle.py` | Styles and helpers that mimic the book: A4, Spectral Light 11 pt, grey code blocks, tables, figures, notes, headings collected for the contents |
| `shots.mjs` | Takes the chapter 7 screenshots from the playground launcher (read-only) |
| `shots/` | The screenshots used by chapter 7 |
| `fonts.sh` | Downloads the fonts (Spectral, Inconsolata; SIL Open Font License) into `fonts/` |

## Rebuild the PDF

```bash
cd tools/book
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./fonts.sh
git show b423734:docs/wiki/PgCloud_The_Master_Book.pdf > /tmp/book-1.1.0.pdf
.venv/bin/python build.py /tmp/book-1.1.0.pdf ../../docs/wiki/PgCloud_The_Master_Book.pdf
```

`build.py` prints the page of every chapter 7 section and each version mention it changed. Check the result with any
PDF viewer: page 3 (date and version), page 6 (contents) and pages 120–128.

## Retake the screenshots

They come from the playground with backup nodes (`./RUN.dev.sh --extra`, then add backups on srv-d / srv-e) in the dark
theme, at 1440×900 ×2. The script only reads: it logs in, opens the topology, the inspector of an ex-backup and of a
backup, the Audit, Settings and Deploy tabs.

```bash
cd tools/book
npm install
EXBACKUP=pg3 BACKUP=pg4 node shots.mjs
```

## A new version

Copy `build.py` and `ch7.py`, write the new chapter, and pass the current book as the input. In `build.py`, update
`BOOK_DATE`, `VERSION` and `VERSION_FIXES` (the mentions of the previous version that name the current one; pdfplumber
gives their page and position), and the y position of the first new line on the contents page.

The scripts that generated chapters 4–6 for 1.0.0 / 1.1.0 were lost, so those chapters can only be kept as they are or
patched with overlays like `VERSION_FIXES` does.
