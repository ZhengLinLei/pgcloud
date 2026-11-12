"""Builds 'PgCloud - The Master Book' v1.2.0: the v1.1.0 book + chapter 7 (ch7.py) + version updates.

usage: python build.py <book v1.1.0.pdf> <out.pdf>

The v1.1.0 book is in git:  git show b423734:docs/wiki/PgCloud_The_Master_Book.pdf > /tmp/book-1.1.0.pdf
Chapter 7 goes right before the back cover, its headings are added to the contents page (page 6) and the
bookmarks, page 3 gets the date and version, and VERSION_FIXES turns the mentions of the current version in
chapters 4-6 from 1.1.0 into 1.2.0 (history such as "Since 1.1.0" is left as is). For a later version, copy
this script, write the new chapter and list the mentions to update (pdfplumber shows their position).
"""
import io
import os
import sys

import pdfplumber
import pypdfium2 as pdfium
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Link
from reportlab.lib.colors import Color
from reportlab.pdfbase.pdfmetrics import getDescent
from reportlab.pdfgen import canvas
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bookstyle import BOTTOM, FRAME_W, LEFT, PAGE_H, PAGE_W, TOP, Heading  # noqa: E402
from ch7 import chapter7  # noqa: E402

SRC, OUT = sys.argv[1], sys.argv[2]
BOOK_DATE = 'November 11, 2026'
VERSION = '1.2.0'
# 0-based index where chapter 7 starts: right before the back cover. Printed page number == 0-based index.
src = PdfReader(SRC)
FIRST_INDEX = len(src.pages) - 1

# current-version mentions of 1.1.0 in chapters 4-6 (0-based page, x of the first char); history stays as is
VERSION_FIXES = [(78, 293.1), (80, 336.7), (80, 448.1), (81, 389.6), (92, 221.9), (90, 332.7)]
FONT_MAP = {'Spectral-Light': 'Spectral-Light', 'Inconsolata': 'Mono', 'Spectral-Regular': 'Spectral'}


class BookDoc(BaseDocTemplate):
    def __init__(self, buf):
        super().__init__(buf, pagesize=(PAGE_W, PAGE_H), leftMargin=LEFT, rightMargin=PAGE_W - LEFT - FRAME_W,
                         topMargin=TOP, bottomMargin=BOTTOM, title='PgCloud - The Master Book', author='Zheng Lin Lei')
        frame = Frame(LEFT, BOTTOM, FRAME_W, PAGE_H - TOP - BOTTOM, id='f', leftPadding=0, rightPadding=0, topPadding=0,
                      bottomPadding=0)
        self.addPageTemplates([PageTemplate('p', [frame], onPage=self.page_number)])
        self.headings = []

    def page_number(self, c, doc):
        c.setFont('Helvetica', 11)
        c.setFillGray(0)
        c.drawString(72, 52, str(FIRST_INDEX + doc.page - 1))

    def afterFlowable(self, f):
        if isinstance(f, Heading):
            self.headings.append((f.toc_level, f.toc_title, self.page - 1))


def overlay(draw):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(PAGE_W, PAGE_H))
    draw(c)
    c.save()
    return PdfReader(io.BytesIO(buf.getvalue())).pages[0]


def toc_line(c, y, level, title, page):
    x = 72 + 18 * (level - 1)
    c.setFont('Spectral-Light', 9)
    c.setFillGray(0)
    c.drawString(x, y, title)
    num = str(page)
    nw = c.stringWidth(num, 'Spectral-Light', 9)
    c.drawRightString(523.3, y, num)
    start = x + c.stringWidth(title, 'Spectral-Light', 9) + 3
    dot = c.stringWidth('.', 'Spectral-Light', 9)
    n = int((523.3 - nw - 3 - start) / dot)
    if n > 0:
        c.drawString(start, y, '.' * n)


def main():
    # chapter 7 (its first flowable is a PageBreak: drop the empty first page)
    story = chapter7()[1:]
    buf = io.BytesIO()
    doc = BookDoc(buf)
    doc.build(story)
    ch7 = PdfReader(io.BytesIO(buf.getvalue()))
    headings = doc.headings
    print('chapter 7 pages:', len(ch7.pages))

    w = PdfWriter(clone_from=src)
    render = pdfium.PdfDocument(SRC)

    # page 3: date + version
    def p3(c):
        c.setFillGray(1)
        c.rect(70, 715, 260, 62, stroke=0, fill=1)
        c.setFillGray(0)
        c.setFont('Spectral-Light', 11)
        c.drawString(72, 842 - 79.8 - 8.3, BOOK_DATE)
        c.drawString(72, 842 - 110.9 - 8.3, f'Version {VERSION}')
    w.pages[2].merge_page(overlay(p3))

    # 1.1.0 -> 1.2.0 where it names the current version: cover the token with the page's own background
    with pdfplumber.open(SRC) as pdf:
        for idx, x in VERSION_FIXES:
            chars = pdf.pages[idx].chars
            txt = ''.join(ch['text'] for ch in chars)
            k = next(i for i, ch in enumerate(chars) if abs(ch['x0'] - x) < 0.5 and txt[i:i + 5] == '1.1.0')
            tok = chars[k:k + 5]
            x0, x1, top, bottom = tok[0]['x0'], tok[-1]['x1'], min(t['top'] for t in tok), max(t['bottom'] for t in tok)
            font = next(v for kf, v in FONT_MAP.items() if kf in tok[0]['fontname'])
            # the real size: the width of the original token in that font (pdfplumber's size includes the text matrix)
            from reportlab.pdfbase.pdfmetrics import stringWidth
            if font == 'Mono':  # monospaced: the advance between the first and the last char gives the size
                size = (tok[4]['x0'] - tok[0]['x0']) / (4 * stringWidth('1', font, 1))
            else:
                size = tok[0]['size']
            img = render[idx].render(scale=2).to_pil()
            # the lightest of a few points around the token is the background (glyphs are darker)
            pts = [(x0 - 1.2, (top + bottom) / 2), (x1 + 0.8, top + 1), ((x0 + x1) / 2, top - 1.0), ((x0 + x1) / 2, bottom + 1.0)]
            bg = max((img.getpixel((int(px * 2), int(py * 2))) for px, py in pts), key=lambda p: sum(p[:3]))

            def fix(c, x0=x0, x1=x1, top=top, bottom=bottom, font=font, size=size, bg=bg, y=tok[0]['y0']):
                c.setFillColor(Color(bg[0] / 255, bg[1] / 255, bg[2] / 255))
                c.rect(x0 - 0.3, 842 - bottom - 0.5, x1 - x0 + 0.6, bottom - top + 1, stroke=0, fill=1)
                # code blocks (grey background) use the code ink, inline code and body text a darker one
                ink = (0.37, 0.39, 0.41) if font == 'Mono' and bg[0] < 250 else (0.235, 0.235, 0.235) if font == 'Mono' else (0.15, 0.15, 0.15)
                c.setFillColor(Color(*ink))
                c.setFont(font, size)
                # baseline: pdfplumber y0 is the bottom of the glyph box (descent included)
                descent = getDescent(font, size)
                c.drawString(x0, y - descent, VERSION)
            w.pages[idx].merge_page(overlay(fix))
            print(f'version fixed on page {idx + 1} ({font} {size:.1f}, bg {bg[:3]})')

    # table of contents (page 6): chapter 7 lines below the last entry (6.7 at 754.7 - 28 * 16.7)
    pitch = 16.7
    y0 = 842 - 80 - 7.3 - 29 * pitch
    entries = [(lvl, title, FIRST_INDEX + pg) for lvl, title, pg in headings if lvl <= 2]
    positions = []

    def p6(c):
        for i, (lvl, title, page) in enumerate(entries):
            y = y0 - i * pitch
            toc_line(c, y, lvl, title.replace(' - ', ' - '), page)
            positions.append((y, page))
    w.pages[5].merge_page(overlay(p6))
    assert positions[-1][0] > 80, 'chapter 7 does not fit on the contents page'

    for i, page in enumerate(ch7.pages):
        w.insert_page(page, FIRST_INDEX + i)
    for y, page in positions:
        w.add_annotation(5, Link(rect=(72, y - 3, 524, y + 10), target_page_index=page))

    parent = None
    for lvl, title, pg in headings:
        if lvl == 1:
            parent = w.add_outline_item(title, FIRST_INDEX + pg)
        elif lvl == 2:
            w.add_outline_item(title.replace(' - ', ' '), FIRST_INDEX + pg, parent=parent)

    w.add_metadata({'/Title': f'PgCloud - The Master Book (v{VERSION})', '/Author': 'Zheng Lin Lei',
                    '/Subject': f'PostgreSQL, Pgpool-II and PgBouncer clusters with PgCloud {VERSION}',
                    '/Producer': 'PgCloud book builder (pypdf + ReportLab)'})
    w.page_mode = '/UseOutlines'
    with open(OUT, 'wb') as f:
        w.write(f)
    print('written', OUT, len(w.pages), 'pages')
    for lvl, title, pg in headings:
        if lvl <= 2:
            print(f'  {title} -> printed {FIRST_INDEX + pg}')


if __name__ == '__main__':
    main()
