use gpui_kit::RenderImage;
use std::{collections::HashMap, sync::Arc};
pub fn load() -> HashMap<&'static str, Arc<RenderImage>> {
    let mut result = HashMap::new();
    result.insert(
        "Let",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/0.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "the",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/1.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "city",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/2.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "fade",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/3.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "away",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/4.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "Find",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/5.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "a",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/6.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "little",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/7.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "room",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/8.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "to",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/9.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "breathe",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/10.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "Every",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/11.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "note",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/12.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "will",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/13.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "light",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/14.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "way",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/15.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "Sing",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/16.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "song",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/17.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "you",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/18.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "carry",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/19.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "underneath",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/20.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "moment",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/21.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "find",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/22.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "its",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/23.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "place",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/24.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "And",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/25.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "begin",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/26.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "again",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/27.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "with",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/28.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result.insert(
        "me",
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::load_from_memory(include_bytes!("../assets/glow/29.png"))
                .expect("glyph mask")
                .into_rgba8(),
        )])),
    );
    result
}
pub fn load_bands() -> HashMap<&'static str, Vec<Arc<RenderImage>>> {
    let mut result = HashMap::new();
    let source = image::load_from_memory(include_bytes!("../assets/glow/0.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("Let", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/1.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("the", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/2.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("city", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/3.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("fade", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/4.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("away", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/5.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("Find", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/6.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("a", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/7.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("little", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/8.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("room", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/9.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("to", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/10.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("breathe", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/11.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("Every", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/12.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("note", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/13.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("will", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/14.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("light", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/15.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("way", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/16.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("Sing", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/17.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("song", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/18.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("you", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/19.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("carry", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/20.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("underneath", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/21.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("moment", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/22.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("find", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/23.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("its", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/24.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("place", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/25.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("And", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/26.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("begin", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/27.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("again", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/28.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("with", bands);
    let source = image::load_from_memory(include_bytes!("../assets/glow/29.png"))
        .expect("word glow")
        .into_rgba8();
    let bands = (1..=8)
        .map(|level| {
            let mut pixels = source.clone();
            for pixel in pixels.pixels_mut() {
                pixel[3] = (pixel[3] as u16 * level / 8) as u8;
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    result.insert("me", bands);
    result
}
