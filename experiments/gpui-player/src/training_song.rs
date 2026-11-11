//! Loaded-song preparation composition. Recipe clicks always open setup;
//! capture and reference audio start only from its explicit Start action.
use super::*;
impl TrainingScreen {
    pub(super) fn song_card(&self, cx: &mut Context<Self>) -> Option<Div> {
        let song = self.song.as_ref()?;
        let key = song
            .key
            .map(|k| {
                let note = crate::training_music::note_name(
                    60 + k.tonic as i32,
                    k.tonic as usize,
                    k.minor,
                );
                format!(
                    "{}{}",
                    tv(
                        if k.minor { "key.minor" } else { "key.major" },
                        &[(
                            "tonic",
                            note.trim_end_matches(|c: char| c.is_ascii_digit()).into()
                        )]
                    ),
                    if song.transpose == 0 {
                        String::new()
                    } else {
                        tv(
                            "training.home.songPrep.transposedSuffix",
                            &[
                                (
                                    "sign",
                                    if song.transpose > 0 {
                                        "+".into()
                                    } else {
                                        "".into()
                                    },
                                ),
                                ("amount", song.transpose.to_string()),
                            ],
                        )
                    }
                )
            })
            .unwrap_or_else(|| t("training.home.songPrep.confirmKeyFirst"));
        Some(
            training_song_card()
                .child(training_eyebrow(
                    t("training.home.songPrep.eyebrow").to_uppercase(),
                ))
                .child(
                    Self::heading(
                        tv(
                            "training.home.songPrep.title",
                            &[("name", song.name.clone())],
                        ),
                        23.,
                    )
                    .font_family("SingZ Display 780")
                    .mt(px(5.))
                    .mb(px(7.)),
                )
                .child(Self::text(key, 12.5, TEXT).font_family(MONO_400).mt(px(3.)))
                .child(Self::text(t("training.home.songPrep.tagline"), 12.5, DIM).mt(px(3.)))
                .child(
                    div().flex().gap(px(7.)).mt(px(17.)).children(
                        [
                            (
                                "notes",
                                t("training.home.songPrep.choice.notes"),
                            ),
                            (
                                "intervals",
                                t("training.exercise.interval.label"),
                            ),
                            (
                                "chords",
                                t("training.home.songPrep.choice.chords"),
                            ),
                            (
                                "mixed",
                                t("training.home.songPrep.choice.mixed"),
                            ),
                        ]
                        .into_iter()
                        .map(|(id, label)| {
                            let enabled = self.audio_available || song.key.is_none();
                            self.probe(
                                format!("training-prepare-{id}"),
                                training_song_choice(
                                    format!("training-prepare-{id}"),
                                    label,
                                    enabled,
                                )
                                .when(true, |button| self.setup_control(
                                    format!("training-prepare-{id}"),button,enabled,cx,
                                )),
                            )
                        }),
                    ),
                )
                .when(song.key.is_none(), |d| {
                    d.child(
                        Self::text(t("training.home.songPrep.chooseFocusHelp"), 12., DIM)
                            .mt(px(8.)),
                    )
                }),
        )
    }
}
