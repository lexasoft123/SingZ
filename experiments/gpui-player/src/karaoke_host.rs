//! Karaoke's remembered mode is global; loading a song only resets visibility.
use super::*;

impl Player {
    pub(super) fn remember_karaoke(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.karaoke_preferred=enabled;
        self.karaoke_pref_seq+=1;
        if let Some(backend)=&self.backend {
            if let Err(error)=backend.karaoke_pref(self.karaoke_pref_seq,enabled) {
                // Like desktop localStorage, a failed durable write must not
                // undo the user's choice in this running application.
                self.notice=Some(format!("Karaoke mode changed, but its preference could not be saved: {error:#}"));
            }
        }
        cx.notify();
    }
    pub(super) fn restore_karaoke(&mut self, mute_guide: bool, cx: &mut Context<Self>) {
        self.karaoke=false;
        if self.karaoke_preferred && self.audio_available() && (!mute_guide || self.mute_native_karaoke_guide(cx)) {
            self.karaoke=true;
        }
        self.transport.update(cx,|transport,cx|transport.set_karaoke(self.karaoke,cx));
        self.prepare_karaoke_lyrics(cx);
    }
    pub(super) fn prepare_karaoke_lyrics(&mut self, cx: &mut Context<Self>) {
        let recheck=self.project.as_ref().and_then(|p|p.lyrics_raw.as_ref()).is_some_and(lyrics_resolution::needs_online_recheck);
        if self.karaoke && (recheck || !self.lyrics_sidebar.read(cx).is_ready())
            && self.lyrics_flight.lyrics_sidebar.is_none() && self.lyrics_sidebar_needs.is_empty()
            && !self.lyrics_sidebar_download_waiting {
            self.start_sidebar_lyrics(self.lyrics_sidebar_intent,cx);
        }
    }
}
