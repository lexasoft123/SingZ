//! Deterministic 120 Hz lyric-paint captures. Hidden rendering is not display FPS.
use super::*;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, directory: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&directory)?;
            handle.update(cx, |_, window, cx| {
                window.resize(size(px(1280.), px(800.)));
                view.update(cx, |this, cx| {
                    this.screen = Screen::Player;
                    this.loaded_song = true;
                    this.playing = false;
                    this.karaoke = true;
                    this.muted = [true, false, false, false, false, false];
                    this.solo = [false; 6];
                    this.fade = [0.14, 1., 1., 1., 1., 1.];
                    this.notice = None;
                    this.started = Instant::now() - Duration::from_secs(2);
                    this.header.update(cx, |header, cx| header.set_review_fixture(true, cx));
                    cx.notify();
                });
            })?;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            let mut frames = Vec::new();
            for (sequence, start, count) in [("first-word", 63.85_f64, 161), ("final-word", 69.25, 161), ("line-boundary", 71.75, 41)] {
                for index in 0..count {
                    let requested_position = start + index as f64 / 120.;
                    let frame = handle.update(cx, |_, window, cx| -> anyhow::Result<_> {
                        view.update(cx, |this, cx| {
                            this.position = requested_position as f32;
                            this.last = Instant::now();
                            cx.notify();
                        });
                        // Explicit settling is intentional: this case measures paint, not scroll animation.
                        for _ in 0..90 { window.simulate_next_frame(cx); window.refresh(); let _ = window.draw(cx); }
                        anyhow::ensure!(!view.read(cx).lyric_scroll_active.get(), "lyric scroll did not settle");
                        let stats = view.read(cx).frame_stats.clone();
                        stats.borrow_mut().advancing_glow_draws = 0;
                        window.refresh(); let _ = window.draw(cx);
                        let draws = stats.borrow().advancing_glow_draws;
                        let player = view.read(cx);
                        let position = player.position;
                        let effective = position + 0.15;
                        let line = ((effective / 8.).floor() as usize).min(23);
                        let total: usize = LYRICS[line % 6].split_whitespace().map(str::len).sum();
                        let singing = effective - line as f32 * 8.;
                        if singing > 0.01 && singing < 6.49 {
                            // Count actual successful image draws, not merely entry into an active-word branch.
                            anyhow::ensure!(draws >= 12, "advancing glow missing at {position}: {draws} draws; {total} chars");
                        }
                        let image = window.render_to_image()?;
                        let dpr = window.scale_factor();
                        // Entire lyrics panel, physical pixels; no scaling, alignment or color conversion.
                        let x = (920. * dpr).round() as u32;
                        let y = (52. * dpr).round() as u32;
                        let width = image.width() - x;
                        let height = (629. * dpr).round() as u32;
                        let file = format!("{sequence}-{index:04}.png");
                        image::imageops::crop_imm(&image, x, y, width, height).to_image().save(directory.join(&file))?;
                        if index == 0 { image.save(directory.join(format!("{sequence}-full.png")))?; }
                        Ok(serde_json::json!({"sequence":sequence,"index":index,"requestedPosition":requested_position,"positionF32":position,"file":file,"sha256":hash(&std::fs::read(directory.join(&file))?),"cropPhysical":[x,y,width,height],"fullImagePixels":[image.width(),image.height()],"deviceScale":dpr,"lyricScroll":player.lyric_scroll.get(),"successfulAdvancingGlowDraws":draws}))
                    })??;
                    frames.push(frame);
                }
                eprintln!("LYRICS_REVIEW {sequence}: {count} frames");
            }
            std::fs::write(directory.join("manifest.json"), serde_json::to_vec_pretty(&serde_json::json!({
                "standard":"gpui-lyrics-approved-120hz-v1","kind":"restorationCandidate","samplingHz":120,"liveFPS":null,
                "viewport":[1280,800],"capture":"hidden GPUI render_to_image; settled scrolling","silent":true,
                "fixture":"192s repeated six-line verse; char-weighted 6.5s words; anticipation 0.15s; gains 0.8",
                "comparisonLimit":"Historical approved preview has different typography/geometry/timing. Paint layers restored from archived code; no claim of whole-image pixel identity.",
                "binarySha256":hash(&std::fs::read(std::env::current_exe()?)?),"mainSourceSha256":hash(include_bytes!("main.rs")),"glowSourceSha256":hash(include_bytes!("lyric_glow.rs")),"font650Sha256":hash(include_bytes!("../assets/Bricolage650.ttf")),"frames":frames
            }))?)?;
            Ok(())
        }.await;
        match result {
            Ok(()) => { let _ = cx.update(|cx| cx.quit()); }
            Err(error) => { eprintln!("LYRICS_REVIEW failed: {error:#}"); std::process::exit(1); }
        }
    }).detach();
}
