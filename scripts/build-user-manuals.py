"""Generate the requested manuals from the same source as in-app help. No DB access."""
import json, sys, re
from pathlib import Path
from xml.sax.saxutils import escape
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.audit-tools'))
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Image, Table, TableStyle, KeepTogether
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import A4
from PIL import Image as PILImage

OUT=ROOT/'docs/user-guide'; OUT.mkdir(parents=True,exist_ok=True)
articles=json.loads((ROOT/'src/modules/help/content.json').read_text(encoding='utf-8'))
logo=ROOT/'public/logo1.png'
title='WATCON Enterprise — Complete User Guide'
note='Edition 24 November 2026. Read this guide with your supervisor during training. Menu visibility depends on your permissions. Screenshots marked local contain fictional training data. The audit reports identify tested and untested operations. This guide does not certify production balances.'
shots={'projects':'local-projects','stock':'local-stock','purchase-orders':'local-purchase-orders','site-receipts':'local-site-receipts','challans':'local-challans','supplier-bills':'local-supplier-bills','running-bills':'local-running-bills','accounts':'local-accounts','payments':'local-payments','tasks':'local-tasks'}
def markdown(items,heading=1):
    lines=[]
    for a in items:
        lines += ['#'*heading+' '+a['title'],'',a['summary'],'']
        for s in a['sections']: lines += ['#'*(heading+1)+' '+s['title'],'',*sum(([p,''] for p in s['paragraphs']),[])]
        shot=OUT/'screenshots'/f"{shots.get(a['id'],'missing')}.png"
        if shot.exists(): lines += [f'![Local training application: {a["title"]}](screenshots/{shot.name})','','The numbered highlight identifies the page name. The image shows the actual local application with fictional records.','']
    return '\n'.join(lines)
(OUT/'WATCON_USER_GUIDE.md').write_text(f'# {title}\n\n{note}\n\n## Contents\n\n'+'\n'.join(f'{i+1}. {a["title"]}' for i,a in enumerate(articles))+'\n\n'+markdown(articles,2),encoding='utf-8')
for name,ids in [('ROLE_WISE_GUIDE.md',[a['id'] for a in articles if a['category']=='Role-wise Guides']),('BUSINESS_WORKFLOW.md',['business-workflow']),('FAQ.md',['faq','troubleshooting'])]:
    (OUT/name).write_text(markdown([a for a in articles if a['id'] in ids]),encoding='utf-8')
(OUT/'screenshots/README.md').write_text('# Screenshot provenance\n\nLive login images contain no entered credentials. All images beginning local- show the isolated training application. The blue numbered marker is added to the rendered page only for capture and removed immediately. No real client or employee records are used. Local role names, parties and prices are fictional. Images document the UI, not proof that every listed action passed. See docs/audit/evidence/local-ui-results.json for executed checks.\n',encoding='utf-8')

for name,file in [('Noto','NotoSans-Regular.ttf'),('NotoBold','NotoSans-Bold.ttf')]: pdfmetrics.registerFont(TTFont(name,str(ROOT/'src/assets/fonts'/file)))
pdfmetrics.registerFontFamily('Noto',normal='Noto',bold='NotoBold',italic='Noto',boldItalic='NotoBold')
styles=getSampleStyleSheet()
for k in ['BodyText','Normal']: styles[k].fontName='Noto'; styles[k].fontSize=10; styles[k].leading=15; styles[k].spaceAfter=7
for k,size in [('Title',25),('Heading1',19),('Heading2',12)]: styles[k].fontName='NotoBold'; styles[k].fontSize=size; styles[k].leading=size*1.35; styles[k].spaceBefore=12; styles[k].spaceAfter=8; styles[k].textColor=colors.HexColor('#075985')
styles['Heading2'].spaceBefore=8;styles['Heading2'].spaceAfter=4
styles['BodyText'].leading=14;styles['BodyText'].spaceAfter=5
styles.add(ParagraphStyle(name='CaptionAudit',fontName='Noto',fontSize=8,leading=11,textColor=colors.HexColor('#475569'),spaceAfter=9))
class ManualDoc(SimpleDocTemplate):
    def afterFlowable(self,flowable):
        if isinstance(flowable,Paragraph) and flowable.style.name=='Heading1' and flowable.getPlainText() != 'Contents':
            self.notify('TOCEntry',(0,flowable.getPlainText(),self.page))
def P(text,style='BodyText'): return Paragraph(escape(text),styles[style])
def image_fit(path,maxw=475,maxh=255):
    with PILImage.open(path) as im: w,h=im.size
    scale=min(maxw/w,maxh/h)
    return Image(str(path),width=w*scale,height=h*scale)
def footer(c,d):
    c.saveState(); w,h=A4
    c.setStrokeColor(colors.HexColor('#cbd5e1'));c.line(48,42,w-48,42)
    c.setFont('Noto',8);c.setFillColor(colors.HexColor('#475569'));c.drawString(48,29,'WATCON Enterprise | Employee guide | 24 November 2026');c.drawRightString(w-48,29,f'Page {d.page}');c.restoreState()
def flow_story():
    rows=[[P('1  SET UP: Clients / Suppliers → Projects → Team Members → Tasks')],[P('2  BUY: Requisitions → Rate Enquiries → Purchase Orders')],[P('3  RECEIVE: Site receipts → verify and post → Inventory')],[P('4  SUPPLY: Client POs → Sales Orders → Challans')],[P('5  BILL: Running Bills → certification → Client Invoices')],[P('6  SETTLE: Payments & Receipts → allocations → Project Accounts')]]
    t=Table(rows,colWidths=[470]);t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#f0f9ff')),('BOX',(0,0),(-1,-1),.5,colors.HexColor('#7dd3fc')),('INNERGRID',(0,0),(-1,-1),.3,colors.HexColor('#bae6fd')),('LEFTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),6)]));return t

story=[Spacer(1,60),image_fit(logo,300,100),Spacer(1,30),P(title,'Title'),Spacer(1,20),P('A practical guide for new employees','Heading2'),P(note),Spacer(1,30),flow_story(),PageBreak(),P('Contents','Heading1')]
toc=TableOfContents();toc.levelStyles=[ParagraphStyle(name='TOC',fontName='Noto',fontSize=10,leading=15,leftIndent=0,spaceAfter=5)];story += [toc,PageBreak()]
for a in articles:
    story += [P(a['title'],'Heading1'),P(a['summary'])]
    for s in a['sections']:
        story += [P(s['title'],'Heading2'),*[P(p) for p in s['paragraphs']]]
    shot=OUT/'screenshots'/f"{shots.get(a['id'],'missing')}.png"
    if a['id']=='getting-started' and (OUT/'screenshots/live-login-desktop.png').exists(): story += [KeepTogether([image_fit(OUT/'screenshots/live-login-desktop.png'),P('Actual live sign-in page. Enter your work login, then select Sign in. No credentials are shown.','CaptionAudit')])]
    if shot.exists(): story += [KeepTogether([image_fit(shot),P('Actual local training application. Highlight 1 identifies the page name. All business records shown are fictional.','CaptionAudit')])]
    if a['id']=='business-workflow': story += [flow_story()]
    story += [PageBreak()]
ManualDoc(str(OUT/'WATCON_USER_GUIDE.pdf'),pagesize=A4,rightMargin=48,leftMargin=48,topMargin=42,bottomMargin=58,title=title,author='WATCON Enterprise').multiBuild(story,onFirstPage=footer,onLaterPages=footer)

quick=[image_fit(logo,220,65),P('WATCON Enterprise Quick Start Guide','Title'),P('Keep this sheet beside your desk. Use fictional data only during training.'),P('1. Start your day','Heading1'),P('Sign in with Email or username and Password. Change a temporary password when asked. Open Tasks and check your deadlines.'),P('2. Choose the next step','Heading1'),flow_story(),P('3. Check before saving','Heading1'),P('Check project, client or supplier, item, brand, unit, quantity, price and date. Save a draft first where offered. Approval, posting and issuing are separate steps.'),P('4. Remember the stock rule','Heading1'),P('A PO or SO does not move stock. Posted supplier Site Receipts add accepted quantities. Dispatched challans reduce source stock. Supplier bills do not add stock in this version.'),P('5. Payments and help','Heading1'),P('Accounts staff must allocate payments or receipts to the correct bill or invoice. Open Help & User Guide for instructions. If an action fails, check the list before entering it again. Sign out on a shared computer.')]
SimpleDocTemplate(str(OUT/'QUICK_START_GUIDE.pdf'),pagesize=A4,rightMargin=48,leftMargin=48,topMargin=35,bottomMargin=55,title='WATCON Enterprise Quick Start Guide').build(quick,onFirstPage=footer,onLaterPages=footer)

doc=Document();section=doc.sections[0];section.page_width=Inches(8.27);section.page_height=Inches(11.69);section.top_margin=Inches(.7);section.bottom_margin=Inches(.7);section.left_margin=Inches(.75);section.right_margin=Inches(.75)
normal=doc.styles['Normal'];normal.font.name='Calibri';normal.font.size=Pt(11);normal.paragraph_format.space_after=Pt(7)
for n,size in [('Title',28),('Heading 1',20),('Heading 2',12)]:
    st=doc.styles[n];st.font.name='Calibri';st.font.size=Pt(size);st.font.color.rgb=RGBColor.from_string('000000' if n=='Title' else '075985');st.paragraph_format.keep_with_next=True
doc.add_picture(str(logo),width=Inches(3.5));doc.add_paragraph(title,'Title');doc.add_paragraph('A practical guide for new employees','Subtitle');doc.add_paragraph(note);doc.add_page_break();doc.add_heading('Contents',level=1)
p=doc.add_paragraph();field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'TOC \\o "1-1" \\h \\z \\u');p._p.append(field)
doc.add_page_break()
for article_index,a in enumerate(articles):
    doc.add_heading(a['title'],level=1);doc.add_paragraph(a['summary'])
    for s in a['sections']:
        doc.add_heading(s['title'],level=2)
        for text in s['paragraphs']: doc.add_paragraph(text)
    shot=OUT/'screenshots'/f"{shots.get(a['id'],'missing')}.png"
    if shot.exists(): doc.add_picture(str(shot),width=Inches(6.5));doc.add_paragraph('Actual local training application. Highlight 1 identifies the page name. All records are fictional.','Caption')
    if a['id']=='business-workflow':
        t=doc.add_table(rows=1,cols=4);t.style='Light Shading Accent 1'
        for c,x in zip(t.rows[0].cells,['Event','Quantity','Taxable ₹','Total ₹']):c.text=x
        for row in [('Purchase','10','10,000','11,800'),('Client invoice','10','15,000','17,700'),('Material margin','10','5,000','Before overheads')]:
            for c,x in zip(t.add_row().cells,row):c.text=x
        doc.add_paragraph('SET UP → BUY → RECEIVE → SUPPLY → BILL → SETTLE')
    if article_index < len(articles)-1: doc.add_page_break()
footer_p=section.footer.paragraphs[0];footer_p.add_run('WATCON Enterprise | Employee guide | Page ')
field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'PAGE');footer_p._p.append(field)
doc.core_properties.title=title;doc.core_properties.author='WATCON Enterprise';doc.save(OUT/'WATCON_USER_GUIDE.docx')
print('Generated Markdown, PDF, Word and Quick Start manuals.')
