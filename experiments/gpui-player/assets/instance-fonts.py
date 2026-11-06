from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from pathlib import Path
root=Path('experiments/gpui-player/assets')
for source,family in [('Bricolage','SingZ Display'),('MartianMono','SingZ Mono')]:
    weights=[400,500,600,650,700,800] if source=='Bricolage' else [400,500,700]
    for weight in weights:
        font=TTFont(Path('node_modules/@fontsource-variable') / ('bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2' if source=='Bricolage' else 'martian-mono/files/martian-mono-latin-wght-normal.woff2'))
        font.flavor=None
        axes={a.axisTag:a.defaultValue for a in font['fvar'].axes};axes['wght']=weight
        family_name=family+' '+str(weight)
        font=instantiateVariableFont(font,axes,inplace=True)
        style={400:'Regular',500:'Medium',600:'SemiBold',650:'DemiBold',700:'Bold',800:'ExtraBold'}[weight]
        names=font['name']
        for ident,value in [(1,family_name),(2,style),(4,family_name+' '+style),(6,family.replace(' ','')+'-'+style),(16,family_name),(17,style)]:
            for platform,encoding,lang in [(3,1,0x409),(1,0,0)]:names.setName(value,ident,platform,encoding,lang)
        font.save(root/(source+str(weight)+'.ttf'))
