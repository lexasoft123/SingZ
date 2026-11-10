//! Own-process, hidden modal prefix/resize/retirement proof. No OS input/audio.
use super::*;
use anyhow::Context as _;
use gpui_kit::component::input::{Input, InputState};
use std::{path::PathBuf, time::Duration};

struct Probe {
    cache: Rc<RefCell<singz_uikit::ModalBackdropCache>>,
    prefix: Rc<RefCell<Option<image::RgbaImage>>>,
    input: Entity<InputState>,
    open: bool,
    color: u32,
    revision: u64,
    unrelated_tick: u64,
}
impl Render for Probe {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            self.cache.borrow_mut().clear(w, cx);
        }
        let cache = self.cache.clone();
        let prefix = self.prefix.clone();
        let key =
            singz_uikit::ModalBackdropKey::new(w.viewport_size(), w.scale_factor(), self.revision);
        div()
            .size_full()
            .relative()
            .bg(rgb(self.color))
            .when(self.open, |root| {
                root.child(
                    canvas(
                        |b, _, _| b,
                        move |b, _, w, cx| {
                            cache
                                .borrow_mut()
                                .paint(key, b, w, cx, |w| {
                                    let image = w.render_painted_prefix_to_image()?;
                                    *prefix.borrow_mut() = Some(image.clone());
                                    Ok(image)
                                })
                                .expect("paint-prefix probe capture");
                        },
                    )
                    .absolute()
                    .inset_0(),
                )
                .child(
                    div()
                        .absolute()
                        .left(px(80.))
                        .top(px(80.))
                        .right(px(80.))
                        .bottom(px(80.))
                        .bg(rgb(0x0000ff))
                        .child(Input::new(&self.input).w(px(260.))),
                )
            })
    }
}
fn draw(w: &mut Window, cx: &mut App) {
    for _ in 0..3 {
        w.simulate_next_frame(cx);
        w.refresh();
        let _ = w.draw(cx);
    }
    assert!(
        !w.is_visible() && !w.is_window_active(),
        "Backdrop proof activated a window"
    );
}
fn plain_pixel(image: &image::RgbaImage, color: u32) -> bool {
    let pixel = image.get_pixel(image.width() / 2, image.height() / 2).0;
    let expected = [(color >> 16) as u8, (color >> 8) as u8, color as u8];
    pixel[..3]
        .iter()
        .zip(expected)
        .all(|(a, b)| a.abs_diff(b) <= 2)
        && pixel[3] >= 253
}
fn capture(
    probe: &Entity<Probe>,
    w: &mut Window,
    cx: &mut App,
    out: &std::path::Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    let p = probe.read(cx);
    let cache = p.cache.borrow();
    anyhow::ensure!(
        cache.last_error().is_none(),
        "Backdrop cache error: {:?}",
        cache.last_error()
    );
    let prefix = p.prefix.borrow();
    let prefix = prefix
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No paint-prefix capture"))?;
    let image = w.render_to_image()?;
    anyhow::ensure!(
        plain_pixel(prefix, p.color),
        "Paint prefix included the modal or lost the base color"
    );
    anyhow::ensure!(
        plain_pixel(&image, 0x0000ff),
        "Same-frame final modal was hidden by its backdrop"
    );
    anyhow::ensure!(
        [image.width(), image.height()] == [prefix.width(), prefix.height()],
        "Resize reused an old-size backdrop"
    );
    prefix.save(out.join(format!("{name}-prefix.png")))?;
    image.save(out.join(format!("{name}-final.png")))?;
    std::fs::write(
        out.join(format!("{name}.json")),
        serde_json::to_vec_pretty(&serde_json::json!({
            "hidden":!w.is_visible(),"active":w.is_window_active(),"modalContinuous":p.open,
            "viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],
            "scale":w.scale_factor(),"pixels":[image.width(),image.height()],"captures":cache.captures(),
            "baseColor":p.color,"revision":p.revision,"liveFps":null,
            "scope":"Actual same-frame native paint-prefix/final pixels; not production parity or live display cadence"
        }))?,
    )?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                && std::env::var("SINGZ_MUTE").as_deref()==Ok("1") && integration::fixture_mode(),
                "Backdrop proof requires dedicated hidden/muted demo process");
            std::fs::create_dir_all(&out)?;
            // Exercise the real host's frozen display position and structural key.
            handle.update(cx, |_, w, cx| {
                view.update(cx, |p, cx| {
                    p.screen=Screen::Player; p.loaded_song=true; p.position=10.; p.playing=false;
                    p.previous_screen=Screen::Player;
                    p.backdrop.borrow_mut().clear(w,cx);
                    cx.notify();
                });
                draw(w,cx);
                view.update(cx, |p,cx| {
                    p.settings.update(cx, |settings,cx| {settings.set_review_fixture(true);settings.on_open(cx);});
                    p.screen=Screen::Settings;cx.notify();
                });
                draw(w,cx);
            })?;
            let host = handle.update(cx, |_, w, cx| -> anyhow::Result<_> {
                let p=view.read(cx);
                let cache=p.backdrop.borrow();
                let image=cache.image().context("Host backdrop missing")?;
                let captures=cache.captures();
                anyhow::ensure!(w.has_image_atlas_entry(&image),"Host backdrop was not uploaded");
                Ok((p.display_position(), captures, image))
            })??;
            handle.update(cx, |_, w, cx| {
                view.update(cx, |p,cx| { p.position=25.;cx.notify(); });
                draw(w,cx);
                let p=view.read(cx);
                assert_eq!(p.position,25.,"Backdrop rewound actual playback position");
                assert_eq!(p.display_position(),host.0,"Modal-open display clock advanced");
                assert_eq!(p.backdrop.borrow().captures(),host.1,"Clock tick refreshed the backdrop");
                view.update(cx, |p,cx| {
                    p.header.update(cx,|header,cx|header.set_output_label("Backdrop proof output".into(),cx));
                    cx.notify();
                });
                draw(w,cx);
                assert_eq!(view.read(cx).backdrop.borrow().captures(),host.1+1,"Header structural change was not captured");
                assert!(!w.has_image_atlas_entry(&host.2),"Replaced host image remained in atlas");
                view.update(cx, |p,cx| {p.screen=Screen::Player;cx.notify();});
                draw(w,cx);
                assert!(view.read(cx).backdrop.borrow().image().is_none());
                assert_eq!(view.read(cx).display_position(),25.);
            })?;
            // A late training history/profile/error snapshot must refresh the
            // Training underlay while Settings stays continuously mounted.
            handle.update(cx, |_, w, cx| {
                view.update(cx, |p,cx| {
                    p.screen=Screen::Training; p.previous_screen=Screen::Training;
                    cx.notify();
                });
                draw(w,cx);
                view.update(cx, |p,cx| { p.screen=Screen::Settings; cx.notify(); });
                draw(w,cx);
                let count=view.read(cx).backdrop.borrow().captures();
                view.update(cx, |p,cx| {
                    p.training_store_revision=p.training_store_revision.wrapping_add(1);
                    let history=Arc::new(training_store::Snapshot {
                        loaded:true, revision:p.training_store_revision,
                        preference_error:Some("Backdrop training persistence proof".into()),
                        ..Default::default()
                    });
                    p.training.update(cx, |training,cx|training.set_history(history,cx));
                    cx.notify();
                });
                draw(w,cx);
                assert!(view.read(cx).screen==Screen::Settings);
                assert!(view.read(cx).previous_screen==Screen::Training);
                assert_eq!(view.read(cx).backdrop.borrow().captures(),count+1,
                    "Late Training history/error update did not refresh exactly once");
                view.update(cx, |p,cx| { p.position=30.;cx.notify(); });
                draw(w,cx);
                assert_eq!(view.read(cx).backdrop.borrow().captures(),count+1,
                    "Training modal clock recaptured unchanged underlay");
                view.update(cx, |p,cx| {p.screen=Screen::Player;cx.notify();});
                draw(w,cx);
            })?;
            let probe=handle.update(cx,|_,w,cx|w.replace_root(cx,|w,cx|Probe {
                cache:Default::default(),prefix:Default::default(),
                input:cx.new(|cx|InputState::new(w,cx)),open:true,color:0xff0000,revision:0,unrelated_tick:0,
            }))?;
            for (width,height,name) in [(1280.,800.,"wide"),(1060.,640.,"compact")] {
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                cx.background_executor().timer(Duration::from_millis(150)).await;
                handle.update(cx,|_,w,cx|capture(&probe,w,cx,&out,name))??;
                let before=probe.read_with(cx,|p,_|p.cache.borrow().captures());
                handle.update(cx,|_,w,cx| {
                    probe.update(cx,|p,cx| {p.input.update(cx,|input,cx|input.set_value("modal typing",w,cx));p.unrelated_tick+=1;cx.notify();});
                    draw(w,cx);
                    assert_eq!(probe.read(cx).cache.borrow().captures(),before,"Modal typing/ticks recaptured base");
                })?;
            }
            handle.update(cx,|_,w,cx| -> anyhow::Result<()> {
                let old=probe.read(cx).cache.borrow().image().context("Probe backdrop missing")?;
                let count=probe.read(cx).cache.borrow().captures();
                probe.update(cx,|p,cx|{p.color=0x00ff00;p.revision+=1;cx.notify();});
                capture(&probe,w,cx,&out,"structural-green")?;
                anyhow::ensure!(probe.read(cx).cache.borrow().captures()==count+1,"Structural update missing");
                anyhow::ensure!(!w.has_image_atlas_entry(&old),"Old probe texture survived replacement");
                let mut retired=vec![old];
                for _ in 0..4 {
                    retired.push(probe.read(cx).cache.borrow().image().unwrap());
                    // Revision changes exercise replacement without an OS resize
                    // race; actual continuous resize is covered above.
                    probe.update(cx,|p,cx|{p.revision+=1;cx.notify();});
                    draw(w,cx);
                    for old in &retired {anyhow::ensure!(!w.has_image_atlas_entry(old),"Retired texture retained");}
                }
                let last=probe.read(cx).cache.borrow().image().unwrap();
                probe.update(cx,|p,cx|{p.open=false;cx.notify();});draw(w,cx);
                anyhow::ensure!(!w.has_image_atlas_entry(&last),"Closed backdrop retained its atlas entry");
                anyhow::ensure!(probe.read(cx).cache.borrow().image().is_none(),"Closed cache retained an image");
                std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({
                    "passed":true,"hostFrozenPosition":host.0,"actualPositionContinued":25,
                    "prefixExcludesModal":true,"sameFrameModalRemains":true,"continuousModalResize":true,
                    "structuralRefresh":true,"trainingStoreRefreshWhileModalOpen":true,"typingAndClockDoNotRefresh":true,"retiredImages":retired.len()+1,
                    "hardwareInput":false,"scaleTransition":"key unit test; actual display migration unqualified",
                    "liveFps":null,"productionParity":"unqualified"
                }))?)?;
                Ok(())
            })??;
            Ok(())
        }.await;
        match result {Ok(())=>{eprintln!("MODAL_BACKDROP passed");let _=cx.update(|cx|cx.quit());},
            Err(error)=>{eprintln!("MODAL_BACKDROP failed: {error:#}");std::process::exit(1);}}
    }).detach();
}
