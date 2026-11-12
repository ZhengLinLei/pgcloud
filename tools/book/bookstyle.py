"""Styles and flowable helpers that mimic 'PgCloud - The Master Book' (Google Docs export):
A4, Spectral Light 11 pt justified body, 72 pt side margins, grey code blocks, page number bottom-left."""
import os
import re
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (CondPageBreak, Flowable, Image, KeepTogether, PageBreak, Paragraph, Spacer, Table,
                                TableStyle, XPreformatted)

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, 'fonts')   # ./fonts.sh downloads them
SHOTS = os.path.join(HERE, 'shots')

pdfmetrics.registerFont(TTFont('Spectral-Light', os.path.join(FONTS, 'Spectral-Light.ttf')))
pdfmetrics.registerFont(TTFont('Spectral-LightItalic', os.path.join(FONTS, 'Spectral-LightItalic.ttf')))
pdfmetrics.registerFont(TTFont('Spectral', os.path.join(FONTS, 'Spectral-Regular.ttf')))
pdfmetrics.registerFont(TTFont('Spectral-Medium', os.path.join(FONTS, 'Spectral-Medium.ttf')))
pdfmetrics.registerFont(TTFont('Mono', os.path.join(FONTS, 'Inconsolata.ttf')))
pdfmetrics.registerFontFamily('Spectral-Light', normal='Spectral-Light', bold='Spectral', italic='Spectral-LightItalic',
                              boldItalic='Spectral')

PAGE_W, PAGE_H = 596, 842
LEFT, RIGHT = 72, 73
TOP, BOTTOM = 70, 88
FRAME_W = PAGE_W - LEFT - RIGHT

INK = colors.HexColor('#262626')
MUTED = colors.HexColor('#6b6b6b')
LINK = colors.HexColor('#1155cc')
BRAND = colors.HexColor('#b5163a')  # cover red
CODE_BG = colors.HexColor('#f3f3f3')
CODE_INK = colors.HexColor('#5f6368')
CODE_KEY = colors.HexColor('#b5179e')
CODE_VAL = colors.HexColor('#3c8d40')
GRID = colors.HexColor('#d9d9d9')

body = ParagraphStyle('body', fontName='Spectral-Light', fontSize=11, leading=18.5, alignment=TA_JUSTIFY,
                      textColor=INK, spaceAfter=7)
body_left = ParagraphStyle('body_left', parent=body, alignment=TA_LEFT)
small = ParagraphStyle('small', parent=body, fontSize=9.5, leading=14, spaceAfter=4)
caption = ParagraphStyle('caption', parent=body, fontName='Spectral-LightItalic', fontSize=9.5, leading=13,
                         alignment=TA_CENTER, textColor=MUTED, spaceBefore=4, spaceAfter=12)
h1 = ParagraphStyle('h1', fontName='Spectral-Light', fontSize=20, leading=26, textColor=colors.black, spaceAfter=12)
h2 = ParagraphStyle('h2', fontName='Spectral-Light', fontSize=16, leading=21, textColor=colors.black, spaceBefore=14,
                    spaceAfter=8)
h3 = ParagraphStyle('h3', fontName='Spectral-Light', fontSize=13.5, leading=18, textColor=colors.black, spaceBefore=10,
                    spaceAfter=6)
h4 = ParagraphStyle('h4', fontName='Spectral', fontSize=11, leading=17, textColor=colors.black, spaceBefore=6,
                    spaceAfter=3)
cell = ParagraphStyle('cell', fontName='Spectral-Light', fontSize=9, leading=12, textColor=INK)
cell_head = ParagraphStyle('cell_head', parent=cell, fontName='Spectral')
cell_mono = ParagraphStyle('cell_mono', parent=cell, fontName='Mono', fontSize=8.5)
bullet_style = ParagraphStyle('bullet', parent=body, leftIndent=18, bulletIndent=6, spaceAfter=3)
code_style = ParagraphStyle('code', fontName='Mono', fontSize=8.6, leading=12, textColor=CODE_INK, backColor=CODE_BG,
                            borderPadding=(8, 8, 8, 8), leftIndent=8, rightIndent=8, spaceBefore=8, spaceAfter=14)


def inline(text: str) -> str:
    """Tiny markup: `code`, **strong**, [text](url)."""
    t = escape(text)
    t = re.sub(r'`([^`]+)`', r'<font name="Mono" size="9.5" color="#3c3c3c">\1</font>', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2" color="#1155cc"><u>\1</u></a>', t)
    return t


def P(text, style=body):
    return Paragraph(inline(text), style)


def bullets(items, style=bullet_style, numbered=False):
    out = []
    for i, it in enumerate(items, 1):
        out.append(Paragraph(inline(it), style, bulletText=f'{i}.' if numbered else '●'))
    out.append(Spacer(1, 5))
    return out


def _hl(line: str) -> str:
    s = escape(line)
    stripped = line.strip()
    if stripped.startswith('#') or stripped.startswith('--') or stripped.startswith(';'):
        return f'<font color="#9aa0a6">{s}</font>'
    m = re.match(r'^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$', line)
    if m:
        k, eq, v = m.group(2), m.group(3), m.group(4)
        return f'{escape(m.group(1))}<font color="#b5179e">{escape(k)}</font>{escape(eq)}<font color="#3c8d40">{escape(v)}</font>'
    if stripped.startswith('$ '):
        return f'<font color="#3c3c3c">{s}</font>'
    return s


def code(text: str, highlight=True):
    lines = text.strip('\n').split('\n')
    body_ = '\n'.join(_hl(l) if highlight else escape(l) for l in lines)
    return XPreformatted(body_, code_style)


def table(rows, widths=None, head=True, mono_cols=(), font_size=None):
    data = []
    for r_i, row in enumerate(rows):
        cells = []
        for c_i, v in enumerate(row):
            st = cell_head if (head and r_i == 0) else (cell_mono if c_i in mono_cols else cell)
            if font_size:
                st = ParagraphStyle(st.name + 'x', parent=st, fontSize=font_size, leading=font_size * 1.35)
            cells.append(Paragraph(inline(str(v)), st))
        data.append(cells)
    if widths:
        total = sum(widths)
        widths = [w * FRAME_W / total for w in widths]
    t = Table(data, colWidths=widths, repeatRows=1 if head else 0, hAlign='LEFT')
    style = [
        ('GRID', (0, 0), (-1, -1), 0.4, GRID),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ]
    if head:
        style.append(('BACKGROUND', (0, 0), (-1, 0), CODE_BG))
    t.setStyle(TableStyle(style))
    return [t, Spacer(1, 12)]


class Shot(Flowable):
    """Screenshot with a thin frame, scaled to the text width."""

    def __init__(self, path, width=FRAME_W, max_height=None):
        super().__init__()
        from PIL import Image as PILImage
        self.path = path
        iw, ih = PILImage.open(path).size
        self.w = width
        self.h = width * ih / iw
        if max_height and self.h > max_height:
            self.h = max_height
            self.w = max_height * iw / ih

    def wrap(self, aw, ah):
        return self.w, self.h

    def draw(self):
        c = self.canv
        x = (FRAME_W - self.w) / 2
        c.drawImage(self.path, x, 0, self.w, self.h, mask='auto')
        c.setStrokeColor(GRID)
        c.setLineWidth(0.6)
        c.rect(x, 0, self.w, self.h)


def figure(name, text, width=FRAME_W, max_height=430):
    path = os.path.join(SHOTS, name + '.png')
    return [KeepTogether([Spacer(1, 4), Shot(path, width, max_height), Paragraph(inline(text), caption)])]


class Note(Flowable):
    """Callout with a red left bar (brand colour of the cover)."""

    def __init__(self, title, text):
        super().__init__()
        self.p = Paragraph(f'<font name="Spectral">{escape(title)}</font>  {inline(text)}',
                           ParagraphStyle('note', parent=body_left, fontSize=10, leading=15.5, spaceAfter=0))

    def wrap(self, aw, ah):
        self.pw, self.ph = self.p.wrap(aw - 26, ah)
        return aw, self.ph + 16

    def draw(self):
        c = self.canv
        c.setFillColor(colors.HexColor('#fbf3f5'))
        c.rect(0, 0, FRAME_W, self.ph + 16, stroke=0, fill=1)
        c.setFillColor(BRAND)
        c.rect(0, 0, 3, self.ph + 16, stroke=0, fill=1)
        self.p.drawOn(c, 16, 8)


def note(title, text):
    return [Note(title, text), Spacer(1, 12)]


class Heading(Paragraph):
    """Paragraph that remembers its TOC level and title (collected by the doc template)."""

    def __init__(self, text, style, level, toc_title):
        super().__init__(inline(text), style)
        self.toc_level = level
        self.toc_title = toc_title


def H(level, number, title):
    style = {1: h1, 2: h2, 3: h3, 4: h4}[level]
    text = f'{number}. {title}' if level == 1 else f'{number} - {title}'
    out = []
    if level == 2:
        out.append(CondPageBreak(120))
    elif level == 3:
        out.append(CondPageBreak(80))
    out.append(Heading(text, style, level, text))
    return out


__all__ = [n for n in dir() if not n.startswith('_')] + ['PageBreak', 'Spacer', 'KeepTogether', 'CondPageBreak']
