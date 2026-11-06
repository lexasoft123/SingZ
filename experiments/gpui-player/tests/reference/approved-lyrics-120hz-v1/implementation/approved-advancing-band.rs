                                    // A continuous feathered band paints PARTS of glyphs; never
                                    // select/switch a whole letter at a glyph boundary.
                                    if position>=start && position<end && p>0. {
                                        let pen=p*width*scale;
                                        let light_width=18.;
                                        let texture_bounds=Bounds::new(origin-point(px(21.),px(21.)),size(px(width*scale+42.),px(25.375*scale+42.)));
                                        for slice in 0..12 {
                                            let u=(slice as f32+0.5)/12.;
                                            let intensity=(1.-(u*2.-1.).abs()).powf(1.5);
                                            let left=pen-light_width/2.+slice as f32*light_width/12.;
                                            let clip=Bounds::new(point(origin.x+px(left),b.origin.y),size(px(light_width/12.),b.size.height));
                                            w.with_content_mask(Some(ContentMask{bounds:clip}),|w| {
                                                if let Some(bands)=glow_bands.get(text) {
                                                    let index=(intensity*8.).ceil().clamp(1.,8.) as usize-1;
                                                    if w.paint_image(texture_bounds,texture_bounds,Corners::default(),bands[index].clone(),0,false).is_ok(){stats.borrow_mut().advancing_glow_draws+=1;}
                                                }
                                                let leading=shape(text,rgb(0xffdf9c).alpha(intensity).into(),scale,w);
                                                let _=leading.paint(origin,px(25.375*scale),TextAlign::Left,None,w,cx);
                                            });
                                        }
                                    }
