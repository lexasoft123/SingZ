"""Bake the static glyph shadow at 2x; no SVG parser or Gaussian blur in the frame loop."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
root=Path(__file__).resolve().parent
font=ImageFont.truetype(str(root.parents[2].parent/'singz-ui/gpui/assets/fonts/Bricolage650.ttf'),36)
words='Let the city fade away Find a little room to breathe Every note will light way Sing song you carry underneath moment find its place And begin again with me'.split()
lines=['use gpui_kit::RenderImage;','use std::{sync::Arc,collections::HashMap};','pub fn load() -> HashMap<&\'static str,Arc<RenderImage>> {','    let mut result=HashMap::new();']
for index,word in enumerate(dict.fromkeys(words)):
 width=round(font.getlength(word));height=52;pad=42
 alpha=Image.new('L',(width+pad*2,height+pad*2));draw=ImageDraw.Draw(alpha)
 asc,desc=font.getmetrics();baseline=(height-asc-desc)/2+asc
 draw.text((pad,pad+baseline),word,font=font,anchor='ls',fill=255)
 alpha=alpha.filter(ImageFilter.GaussianBlur(14)).point(lambda v:round(v*.75))
 # GPUI's image atlas expects BGRA; a baked amber texture has blue and red swapped.
 image=Image.new('RGBA',alpha.size,(40,160,255,0));image.putalpha(alpha)
 path=root/'glow'/f'{index}.png';image.save(path)
 lines.append(f'    result.insert("{word}",Arc::new(RenderImage::new(vec![image::Frame::new(image::load_from_memory(include_bytes!("../assets/glow/{index}.png")).expect("glyph mask").into_rgba8())])));')
lines+=['    result','}'];(root.parent/'src/lyric_glow.rs').write_text('\n'.join(lines)+'\n')
# Opacity variants for a moving, feathered horizontal light band.
lines += ['pub fn load_bands() -> HashMap<&\'static str,Vec<Arc<RenderImage>>> {','    let mut result=HashMap::new();']
for index,word in enumerate(dict.fromkeys(words)):
 lines += [f'    let source=image::load_from_memory(include_bytes!("../assets/glow/{index}.png")).expect("word glow").into_rgba8();',
    '    let bands=(1..=8).map(|level| {let mut pixels=source.clone();for pixel in pixels.pixels_mut(){pixel[3]=(pixel[3] as u16*level/8) as u8;}Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))}).collect();',
    f'    result.insert("{word}",bands);']
lines+=['    result','}'];(root.parent/'src/lyric_glow.rs').write_text('\n'.join(lines)+'\n')
