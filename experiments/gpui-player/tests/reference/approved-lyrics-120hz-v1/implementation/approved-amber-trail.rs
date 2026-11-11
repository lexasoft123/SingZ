                            let p=(((position-start)/(end-start)).clamp(0.,1.)*200.).round()/200.;
                            let feather=17.5*0.4*scale;let edge=p*(width*scale+2.*feather)-feather;
                            // A feathered clipping edge across actual glyphs; spacing remains outside each word.
                            let amber=shape(text,rgb(ACCENT).into(),scale,cx);
                            let solid=(edge-feather).max(0.).min(width*scale);
                            if solid>0. {w.with_content_mask(Some(ContentMask{bounds:Bounds::new(point(origin.x,b.origin.y),size(px(solid),b.size.height))}),|w|{let _=amber.paint(origin,px(25.375*scale),TextAlign::Left,None,w,cx);});}
                            for k in 0..12 {let left=(edge-feather+k as f32*2.*feather/12.).max(0.);let right=(edge-feather+(k+1) as f32*2.*feather/12.).min(width*scale);
                                if right<=left{continue;}
                                let alpha=1.-(k as f32+0.5)/12.;let blended=shape(text,rgb(ACCENT).alpha(alpha).into(),scale,cx);
                                w.with_content_mask(Some(ContentMask{bounds:Bounds::new(point(origin.x+px(left),b.origin.y),size(px(right-left),b.size.height))}),|w|{let _=blended.paint(origin,px(25.375*scale),TextAlign::Left,None,w,cx);});
                            }
