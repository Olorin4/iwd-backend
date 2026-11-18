# TEMPORARY: manual bridge until permanent onboarding is available. Retain executed client records privately.
# Render the local reviewed Markdown copies to static HTML; no source-folder mutation or network access.
from pathlib import Path
import html, re
root=Path(__file__).resolve().parent
banner='<!-- TEMPORARY: manual bridge until permanent onboarding is available. Retain executed client records privately. -->\n\n'
names=['dispatch-service-agreement','limited-power-of-attorney','payment-authorization-form']
def inline(s):
    s=html.escape(s)
    s=re.sub(r'\*\*(.+?)\*\*',r'<strong>\1</strong>',s)
    s=re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)',r'<em>\1</em>',s)
    s=s.replace('[ ]','☐')
    return s

def render(md):
    lines=re.sub(r'<!--.*?-->','',md,flags=re.S).splitlines(); out=[]; i=0
    while i<len(lines):
        t=lines[i].strip()
        if not t: i+=1;continue
        if t.startswith('# '):out.append('<h1>'+inline(t[2:])+'</h1>');i+=1;continue
        if t.startswith('## '):out.append('<h2>'+inline(t[3:])+'</h2>');i+=1;continue
        if t=='---':out.append('<hr>');i+=1;continue
        if t.startswith('|'):
            rows=[]
            while i<len(lines) and lines[i].strip().startswith('|'):
                cells=[x.strip() for x in lines[i].strip().strip('|').split('|')];i+=1
                if all(re.fullmatch(r'[- :]+',x) for x in cells):continue
                rows.append(cells)
            out.append('<table>'+''.join('<tr>'+''.join(('<th>' if k==0 else '<td>')+inline(x)+('</th>' if k==0 else '</td>') for x in row)+'</tr>' for k,row in enumerate(rows))+'</table>');continue
        if t.startswith('- ') or re.match(r'^\d+\. ',t):
            ordered=bool(re.match(r'^\d+\. ',t)); items=[]
            while i<len(lines) and (lines[i].startswith('- ') or re.match(r'^\d+\. ',lines[i])):
                s=re.sub(r'^(?:- |\d+\. )','',lines[i]);i+=1
                while i<len(lines) and lines[i].startswith('  '):s+=' '+lines[i].strip();i+=1
                items.append('<li>'+inline(s)+'</li>')
            tag='ol' if ordered else 'ul';out.append('<'+tag+'>'+''.join(items)+'</'+tag+'>');continue
        para=[t];i+=1
        while i<len(lines) and lines[i].strip() and not re.match(r'^(?:#|\||- |\d+\. )',lines[i]):para.append(lines[i].strip());i+=1
        out.append(('<p class="signature-block">'+ '<br>'.join(inline(x) for x in para) if para[0].startswith('___') else '<p>'+inline(' '.join(para)))+'</p>')
    return '\n'.join(out)
css='''@page { size: Letter; margin: .65in .65in .72in; } *{box-sizing:border-box} body{font:10.5pt/1.3 Arial,sans-serif;color:#17212b;margin:0} h1{font-size:21pt;line-height:1.2;margin:0 0 18pt;color:#13334b} h2{font-size:12pt;margin:12pt 0 6pt;break-after:avoid} p{margin:0 0 7pt;orphans:3;widows:3} ul,ol{padding-left:20pt;margin:7pt 0 11pt} li{margin:4pt 0;break-inside:avoid} table{width:100%;border-collapse:collapse;margin:14pt 0;break-inside:avoid} th,td{border:1px solid #aab5bf;text-align:left;width:50%;padding:6pt;min-height:32pt} th{background:#edf2f5} td{height:27pt;vertical-align:top} hr{border:0;border-top:1px solid #aab5bf;margin:18pt 0} section+section{break-before:page}.signature-block{white-space:pre-wrap}.review{position:fixed;top:45%;left:0;right:0;transform:rotate(-30deg);text-align:center;font-size:35pt;font-weight:bold;color:rgba(170,35,35,.12);z-index:-1}'''
for name in names+['combined-packet']:
    selected=names if name=='combined-packet' else [name]
    content=''.join('<section>'+render((root/(n+'.md')).read_text())+'</section>' for n in selected)
    (root/(name+'.html')).write_text('<!doctype html>\n'+banner+'<html lang="en"><head><meta charset="utf-8"><title>Iron Wing onboarding — review copy</title><style>'+css+'</style></head><body><div class="review">REVIEW COPY — NOT FOR SIGNING</div>'+content+'</body></html>\n')
