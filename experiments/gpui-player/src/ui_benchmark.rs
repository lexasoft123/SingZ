//! Background-only GPU render/readback throughput. This is not display FPS.
use super::*;
use std::{path::PathBuf, time::Duration};

fn summary(values: &[f64]) -> String {
    if values.is_empty() {
        return "null".into();
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let percentile = |p: f64| sorted[((sorted.len() as f64 * p).ceil() as usize).saturating_sub(1)];
    format!(
        "{{\"mean\":{:.6},\"p95\":{:.6},\"p99\":{:.6},\"max\":{:.6},\"samples\":{}}}",
        values.iter().sum::<f64>() / values.len() as f64,
        percentile(0.95),
        percentile(0.99),
        sorted[sorted.len() - 1],
        values.len()
    )
}

fn seconds(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.)
        .unwrap_or(default)
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, output: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"offscreen benchmark requires background mode");
            let warmup = seconds("SINGZ_GPUI_OFFSCREEN_WARMUP",2.);
            let measurement = seconds("SINGZ_GPUI_OFFSCREEN_SECONDS",8.);
            handle.update(cx,|_,window,cx| {
                window.resize(size(px(1280.),px(800.)));
                view.update(cx,|this,cx| {
                    this.screen=Screen::Player; this.loaded_song=true; this.playing=false;
                    this.karaoke=true; this.muted=[false;crate::tracks::LANE_SLOTS]; this.muted[0]=true;
                    this.solo=[false;crate::tracks::LANE_SLOTS]; this.fade=[1.;crate::tracks::LANE_SLOTS]; this.fade[0]=0.16;
                    this.playhead.seek(64.); this.started=Instant::now()-Duration::from_secs(2);
                    this.last=Instant::now(); this.capture_file=None; this.notice=None;
                    cx.notify();
                });
                // A hidden window has no display callbacks. Settle the initial
                // viewport independently of the measured clock/cadence.
                for _ in 0..90 { window.simulate_next_frame(cx); window.refresh(); let _=window.draw(cx); }
            })?;
            let scenario_start=Instant::now();
            let warmup_end=scenario_start+Duration::from_secs_f64(warmup);
            let mut measured_start=None;
            let mut last_frame=None;
            let mut frame_intervals=Vec::new();
            let mut prepare=Vec::new();
            let mut readback=Vec::new();
            let mut lyrics=Vec::new();
            let mut moving_glow_draws=0_usize;
            let mut frames=0_usize;
            let mut image_pixels=(0,0);
            let mut viewport=(0.,0.);
            let mut scale=0.;
            let cadence=Duration::from_nanos(8_333_333);
            loop {
                let frame_start=Instant::now();
                if frame_start>=warmup_end && measured_start.is_none() {
                    measured_start=Some(frame_start);
                    eprintln!("OFFSCREEN_MEASUREMENT_START");
                }
                let measuring=measured_start.is_some();
                if measured_start.is_some_and(|start|frame_start.duration_since(start).as_secs_f64()>=measurement) { break; }
                let (prepare_ms,readback_ms,glow_delta,lyrics_ms,pixels,logical,dpr)=handle.update(cx,|_,window,cx| -> anyhow::Result<_> {
                    let start=Instant::now();
                    let stats=view.read(cx).frame_stats.clone();
                    let before_glow=stats.borrow().advancing_glow_draws;
                    view.update(cx,|this,cx| {
                        this.playhead.seek(64.+scenario_start.elapsed().as_secs_f64());
                        this.playing=false; this.last=Instant::now(); cx.notify();
                    });
                    window.simulate_next_frame(cx); window.refresh(); let _=window.draw(cx);
                    // C-35 negative control: a per-frame stall that the perf smoke gate must catch.
                    if let Some(ms)=gated_env!("SINGZ_PERF_INJECT_FRAME_SLEEP_MS").and_then(|value|value.to_str().and_then(|text|text.parse::<u64>().ok())) {
                        std::thread::sleep(Duration::from_millis(ms));
                    }
                    let prepare_ms=start.elapsed().as_secs_f64()*1000.;
                    let paint=stats.borrow();
                    // FrameStats emits/reset counters each180 paints. This is
                    // deliberately a lower bound; stderr retains complete totals.
                    let glow=paint.advancing_glow_draws.saturating_sub(before_glow);
                    let lyrics_ms=paint.paint.last().copied();
                    drop(paint);
                    let read_start=Instant::now();
                    let image=window.render_to_image()?;
                    let read_ms=read_start.elapsed().as_secs_f64()*1000.;
                    let logical=window.viewport_size();
                    Ok((prepare_ms,read_ms,glow,lyrics_ms,(image.width(),image.height()),
                        (f32::from(logical.width),f32::from(logical.height)),window.scale_factor()))
                })??;
                if measuring {
                    if let Some(last)=last_frame { frame_intervals.push(frame_start.duration_since(last).as_secs_f64()*1000.); }
                    last_frame=Some(frame_start);
                    prepare.push(prepare_ms); readback.push(readback_ms);
                    if let Some(value)=lyrics_ms { lyrics.push(value); }
                    moving_glow_draws+=glow_delta; frames+=1;
                    image_pixels=pixels; viewport=logical; scale=dpr;
                }
                let remaining=cadence.saturating_sub(frame_start.elapsed());
                // Always yield so app events and pending invalidations can run.
                cx.background_executor().timer(remaining.max(Duration::from_micros(1))).await;
            }
            let actual=measured_start.ok_or_else(||anyhow::anyhow!("measurement never started"))?.elapsed().as_secs_f64();
            let record=format!(concat!("{{\n",
                "\"schema\":1,\"kind\":\"offscreenThroughput\",\"liveFPS\":null,\"hidden\":true,\n",
                "\"scenario\":\"six fixture stems, advancing lyrics/glow, 120Hz-budget GPU render and synchronous readback\",\n",
                "\"viewport\":[{},{}],\"deviceScale\":{},\"imagePixels\":[{},{}],\n",
                "\"warmupSeconds\":{:.6},\"measurementSeconds\":{:.6},\"frames\":{},\"offscreenFramesPerSecond\":{:.6},\n",
                "\"frameIntervalMs\":{},\"prepareAndDrawWallMs\":{},\"gpuRenderReadbackWallMs\":{},\"lyricsPaintWallMs\":{},\n",
                "\"movingGlowDrawsLowerBound\":{},\"movingGlowCovered\":{},\n",
                "\"gpuCommandTime\":{{\"available\":false,\"reason\":\"GPUI exposes no per-command GPU timestamps\"}},\n",
                "\"definitions\":{{\"offscreenFramesPerSecond\":\"completed GPU-rendered readback images per wall second; not display or presentation FPS\",",
                "\"prepareAndDrawWallMs\":\"main-thread state update, layout and draw wall time; process CPU is sampled separately\",",
                "\"gpuRenderReadbackWallMs\":\"synchronous offscreen GPU render plus CPU readback wait, not pure GPU execution time\",",
                "\"liveFPS\":\"unmeasured: hidden scene captures do not measure presentation cadence\"}}\n}}\n"),
                viewport.0,viewport.1,scale,image_pixels.0,image_pixels.1,warmup,actual,frames,frames as f64/actual,
                summary(&frame_intervals),summary(&prepare),summary(&readback),summary(&lyrics),moving_glow_draws,moving_glow_draws>0);
            if let Some(parent)=output.parent(){std::fs::create_dir_all(parent)?;}
            let temporary=output.with_extension("tmp");
            std::fs::write(&temporary,record)?; std::fs::rename(temporary,&output)?;
            eprintln!("OFFSCREEN_BENCHMARK complete: {frames} images/{actual:.3}s; live FPS unmeasured");
            Ok(())
        }.await;
        match result {
            Ok(())=>{let _=cx.update(|cx|cx.quit());}
            Err(error)=>{eprintln!("OFFSCREEN_BENCHMARK failed: {error:#}");std::process::exit(1);}
        }
    }).detach();
}
