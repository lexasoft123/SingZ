//! Presentation-only names. Prompt fields and stored training identities stay
//! in the source domain; locale is resolved again for every displayed view.
use crate::{
    i18n::{t, tv},
    training_domain::{Direction, Kind, Prompt, Quality, Role, Task},
};

pub(super) fn capitalize(value: String) -> String {
    let mut chars = value.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().collect::<String>() + chars.as_str()
    })
}
pub(super) fn key_label(value: &str) -> String {
    if let Some(tonic) = value.strip_suffix(" major") {
        tv("key.major", &[("tonic", tonic.into())])
    } else if let Some(tonic) = value.strip_suffix(" minor") {
        tv("key.minor", &[("tonic", tonic.into())])
    } else {
        value.into()
    }
}
fn direction(value: Option<Direction>) -> String {
    t(if value == Some(Direction::Descending) {
        "training.word.descending"
    } else {
        "training.word.ascending"
    })
}
fn quality(value: Quality) -> String {
    t(match value {
        Quality::Major => "training.word.major",
        Quality::Minor => "training.word.minor",
        Quality::Diminished => "training.word.diminished",
        Quality::Augmented => "training.word.augmented",
    })
}
fn chord(prompt: &Prompt) -> String {
    prompt
        .chord
        .as_ref()
        .map(|c| format!("{} {}", c.root_name, quality(c.quality)))
        .unwrap_or_default()
}
fn interval(prompt: &Prompt) -> String {
    let number = prompt.interval.unwrap_or(1) as usize;
    let semitones = prompt.targets[0].midi.abs_diff(prompt.targets[1].midi) as i32;
    let delta = semitones - [0, 2, 4, 5, 7, 9, 11, 12][number - 1];
    let quality = if [1, 4, 5, 8].contains(&number) {
        if delta == 0 {
            "perfect"
        } else if delta == 1 {
            "augmented"
        } else {
            "diminished"
        }
    } else if delta == 0 {
        "major"
    } else if delta == -1 {
        "minor"
    } else if delta > 0 {
        "augmented"
    } else {
        "diminished"
    };
    let ordinal = [
        "unison", "second", "third", "fourth", "fifth", "sixth", "seventh", "octave",
    ][number - 1];
    t(&format!("interval.{quality}.{ordinal}"))
}
pub(super) fn instruction(prompt: &Prompt) -> String {
    if prompt.task == Task::Identify {
        return t(match prompt.kind {
            Kind::Note => "training.session.instruction.identifyNote",
            Kind::Degree => "training.session.instruction.identifyScaleDegree",
            Kind::Interval => "training.session.instruction.identifyInterval",
            Kind::Chord => "training.session.instruction.identifyChordTone",
            Kind::Arpeggio => "training.session.instruction.identifyArpeggio",
            _ => "training.program.scaleLabel",
        });
    }
    let target = &prompt.targets[0];
    match prompt.kind {
        Kind::Note => tv(
            "training.session.instruction.matchNote",
            &[("note", target.note_name.clone())],
        ),
        Kind::Degree => tv(
            "training.session.instruction.singScaleDegree",
            &[
                ("degree", target.degree.to_string()),
                ("note", target.note_name.clone()),
            ],
        ),
        Kind::Interval => tv(
            "training.session.instruction.singInterval",
            &[
                ("interval", interval(prompt)),
                ("direction", direction(prompt.direction)),
                ("from", target.note_name.clone()),
                ("to", prompt.targets[1].note_name.clone()),
            ],
        ),
        Kind::Chord => tv(
            "training.session.instruction.singChordTone",
            &[
                (
                    "role",
                    t(match prompt.role.unwrap_or(Role::Root) {
                        Role::Root => "training.word.root",
                        Role::Third => "training.word.third",
                        Role::Fifth => "training.word.fifth",
                    }),
                ),
                ("chord", chord(prompt)),
                ("note", target.note_name.clone()),
            ],
        ),
        Kind::Arpeggio => tv(
            "training.session.instruction.arpeggiate",
            &[
                ("chord", chord(prompt)),
                ("direction", direction(prompt.direction)),
            ],
        ),
        Kind::Scale => format!(
            "{} · {}",
            target
                .note_name
                .trim_end_matches(|c: char| c.is_ascii_digit() || c == '-'),
            direction(prompt.direction)
        ),
        Kind::Mixed => String::new(),
    }
}
/// The current native snapshot serializes these result statuses as strings.
/// Map that closed domain at the display boundary, without rewriting receipts.
pub(super) fn outcome(value: &str) -> String {
    let key = match value {
        "Skipped" => "training.outcome.skipped",
        "Correct" => "training.outcome.correct",
        "On target" => "training.session.pitch.onTarget",
        "Close" => "training.metric.close",
        "Try again" => "training.outcome.tryAgain",
        "No result" => "training.outcome.none",
        "Wrong note" => "training.outcome.wrongNote",
        "Wrong octave" => "training.outcome.wrongOctave",
        "Other chord tone" => "training.outcome.otherChordTone",
        "Non chord tone" => "training.outcome.nonChordTone",
        "Unstable" => "training.outcome.unstable",
        "Unvoiced" => "training.outcome.unvoiced",
        "Out of range" => "training.outcome.outOfRange",
        _ => return value.into(),
    };
    t(key)
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(super) struct FeedbackCopy {
    pub heading: String,
    pub detail: String,
    pub good: bool,
    pub mark: &'static str,
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(super) struct SummaryCopy {
    pub heading: String,
    pub description: String,
    pub pitch_copy: String,
}

pub(super) fn identify_answer_reveal(prompt: &Prompt) -> Option<String> {
    identify_answer_reveal_in(prompt, crate::i18n::current())
}
fn identify_answer_reveal_in(prompt: &Prompt, locale: crate::i18n::Locale) -> Option<String> {
    if prompt.task != Task::Identify { return None; }
    let text = |key, vars: &[(&str,String)]| crate::i18n::lookup(locale,key,vars);
    let word = |key| text(key,&[]);
    let chord = || prompt.chord.as_ref().map(|chord|format!("{} {}",chord.root_name,word(match chord.quality {
        Quality::Major=>"training.word.major",Quality::Minor=>"training.word.minor",Quality::Diminished=>"training.word.diminished",Quality::Augmented=>"training.word.augmented",
    }))).unwrap_or_default();
    Some(match prompt.kind {
        Kind::Note => text("training.identify.answerNote",&[("note",prompt.targets[0].note_name.trim_end_matches(|c:char|c.is_ascii_digit()||c=='-').into())]),
        Kind::Degree => text("training.identify.answerScaleDegree",&[("n",prompt.targets[0].degree.to_string())]),
        Kind::Interval => {
            let number=prompt.interval.unwrap_or(1) as usize;
            let ordinal=["unison","second","third","fourth","fifth","sixth","seventh","octave"][number-1];
            text("training.identify.answerInterval",&[("interval",word(&format!("training.word.{ordinal}")).to_lowercase()),("direction",word(if prompt.direction==Some(Direction::Descending){"training.word.descending"}else{"training.word.ascending"}))])
        },
        Kind::Chord => text("training.identify.answerChordTone",&[("role",word(match prompt.role.unwrap_or(Role::Root){Role::Root=>"training.word.root",Role::Third=>"training.word.third",Role::Fifth=>"training.word.fifth"})),("chord",chord())]),
        Kind::Arpeggio => text("training.identify.answerArpeggio",&[("degree",prompt.chord.as_ref()?.degree.to_string()),("chord",chord())]),
        Kind::Scale|Kind::Mixed => return None,
    })
}

pub(super) fn feedback_copy(response: &crate::training_run::ResultResponse) -> FeedbackCopy {
    feedback_copy_in(response,crate::i18n::current())
}
fn feedback_copy_in(response: &crate::training_run::ResultResponse, locale:crate::i18n::Locale) -> FeedbackCopy {
    use crate::{training_run::ResultResponse,training_session::Classification as C};
    let (heading,detail,good,mark)=match response {
        ResultResponse::Skipped=>("training.outcome.skipped","training.feedback.skipped.detail",false,"→"),
        ResultResponse::Identify{correct:true}=>("training.outcome.correct","training.feedback.identifyCorrect.detail",true,"✓"),
        ResultResponse::Identify{correct:false}=>("training.feedback.identifyWrong.heading","training.feedback.identifyWrong.detail",false,"↗"),
        ResultResponse::Vocal(classes) if classes.iter().all(|class|*class==C::OnTarget)=>("training.session.pitch.onTarget","training.feedback.onTarget.detail",true,"✓"),
        ResultResponse::Vocal(classes) if classes.iter().all(|class|matches!(class,C::OnTarget|C::Close))=>("training.feedback.close.heading","training.feedback.close.detail",true,"✓"),
        ResultResponse::Vocal(classes)=>{
            let class=classes.iter().find(|class|**class!=C::OnTarget).copied().unwrap_or(C::WrongNote);
            (match class {
                C::OnTarget=>"training.session.pitch.onTarget",C::Close=>"training.classification.close",C::WrongNote=>"training.classification.wrongNote",C::WrongOctave=>"training.classification.wrongOctave",C::OtherChordTone=>"training.classification.otherChordTone",C::NonChordTone=>"training.classification.nonChordTone",C::Unstable=>"training.classification.unstable",C::Unvoiced=>"training.classification.unvoiced",C::OutOfRange=>"training.classification.outOfRange",
            },"training.feedback.wrong.detail",false,"↗")
        },
    };
    FeedbackCopy { heading:crate::i18n::lookup(locale,heading,&[]),detail:crate::i18n::lookup(locale,detail,&[]),good,mark }
}
fn summary_pitch_copy_in(task:Task,average_signed_cents:Option<f64>,locale:crate::i18n::Locale)->String {
    let text=|key,vars:&[(&str,String)]|crate::i18n::lookup(locale,key,vars);
    match average_signed_cents {
        None=>text(if task==Task::Identify{"training.summary.noPitchMetrics"}else{"training.summary.noSteadyNotes"},&[]),
        Some(cents) if cents>10.=>text("training.summary.tended",&[("word",text("training.word.sharp",&[]))]),
        Some(cents) if cents< -10.=>text("training.summary.tended",&[("word",text("training.word.flat",&[]))]),
        _=>text("training.summary.stayedInTune",&[]),
    }
}
pub(super) fn summary_copy(run:&crate::training_run::Snapshot)->SummaryCopy {
    summary_copy_in(run,crate::i18n::current())
}
fn summary_copy_in(run:&crate::training_run::Snapshot,locale:crate::i18n::Locale)->SummaryCopy {
    let final_copy=run.acknowledgement.as_ref().map(|ack|feedback_copy_in(&ack.response,locale));
    let final_answer=run.acknowledgement.as_ref().and_then(|ack|identify_answer_reveal_in(&ack.prompt,locale));
    let mut heading=crate::i18n::lookup(locale,"training.summary.headingTemplate",&[("landed",(run.correct+run.close).to_string()),("attempts",run.attempts.to_string())]);
    let pitch_copy=summary_pitch_copy_in(run.prompt.task,run.average_signed_cents,locale);
    let mut description=pitch_copy.clone();
    if let Some(copy)=final_copy { heading.push_str(&format!(" · {}",copy.heading));description.push_str(&format!(" {}",copy.detail)); }
    if let Some(answer)=final_answer { description.push_str(&format!(" {answer}")); }
    SummaryCopy { heading,description,pitch_copy }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{i18n::Locale,training_domain::{generate,Config},training_run::ResultResponse,training_session::Classification as C};
    fn prompt(kind:Kind)->Prompt {
        generate(&Config{kind,task:Task::Identify,length:1,direction:crate::training_domain::DirectionChoice::Ascending,..Default::default()}).unwrap().remove(0)
    }
    #[test]
    fn identify_reveals_all_five_families_from_the_completed_prompt() {
        let mut note=prompt(Kind::Note);note.targets[0].note_name="B♭-1".into();
        assert_eq!(identify_answer_reveal_in(&note,Locale::En).as_deref(),Some("Answer: B♭"));
        assert_eq!(identify_answer_reveal_in(&note,Locale::Ru).as_deref(),Some("Ответ: B♭"));
        let mut degree=prompt(Kind::Degree);degree.targets[0].degree=6;
        assert_eq!(identify_answer_reveal_in(&degree,Locale::En).as_deref(),Some("Answer: scale degree 6"));
        let mut interval=prompt(Kind::Interval);interval.interval=Some(3);interval.direction=Some(Direction::Descending);
        assert_eq!(identify_answer_reveal_in(&interval,Locale::En).as_deref(),Some("Answer: third descending"));
        let mut chord_prompt=prompt(Kind::Chord);chord_prompt.role=Some(Role::Third);let chord=chord_prompt.chord.as_mut().unwrap();chord.root_name="D".into();chord.quality=Quality::Minor;
        assert_eq!(identify_answer_reveal_in(&chord_prompt,Locale::En).as_deref(),Some("Answer: third of D minor"));
        let mut arpeggio=prompt(Kind::Arpeggio);let chord=arpeggio.chord.as_mut().unwrap();chord.degree=4;chord.root_name="F".into();chord.quality=Quality::Major;
        assert_eq!(identify_answer_reveal_in(&arpeggio,Locale::En).as_deref(),Some("Answer: degree 4 — F major"));
        for mut prompt in [note,degree,interval,chord_prompt,arpeggio] { prompt.task=Task::Find;assert_eq!(identify_answer_reveal_in(&prompt,Locale::En),None); }
    }
    #[test]
    fn feedback_keeps_source_copy_marks_and_every_classification_branch() {
        let check=|response,heading:&str,detail:&str,good,mark| {
            assert_eq!(feedback_copy_in(&response,Locale::En),FeedbackCopy{heading:heading.into(),detail:detail.into(),good,mark});
        };
        check(ResultResponse::Skipped,"Skipped","This exercise was not scored.",false,"→");
        check(ResultResponse::Identify{correct:true},"Correct","Keep that sound in mind before the next question.",true,"✓");
        check(ResultResponse::Identify{correct:false},"Not this time","Listen for the key and compare the notes again.",false,"↗");
        check(ResultResponse::Vocal(vec![C::OnTarget]),"On target","The pitch settled clearly in the center.",true,"✓");
        check(ResultResponse::Vocal(vec![C::OnTarget,C::Close]),"Very close","The right notes are there; give them a little more center.",true,"✓");
        for (class,heading) in [(C::WrongNote,"A different note landed"),(C::WrongOctave,"Right note name, different octave"),(C::OtherChordTone,"Another chord tone landed"),(C::NonChordTone,"The note landed outside the chord"),(C::Unstable,"The pitch did not settle yet"),(C::Unvoiced,"No steady voice was detected"),(C::OutOfRange,"The detected note was outside your chosen range")] {
            check(ResultResponse::Vocal(vec![C::OnTarget,class]),heading,"Release the note, reset, and listen for the next cue.",false,"↗");
        }
        // Source picks the first non-on-target class after rejecting all-close.
        check(ResultResponse::Vocal(vec![C::Close,C::WrongNote]),"Close — one more pass will settle it","Release the note, reset, and listen for the next cue.",false,"↗");
    }
    #[test]
    fn summary_pitch_copy_distinguishes_task_and_signed_tendency_boundaries() {
        assert_eq!(summary_pitch_copy_in(Task::Identify,None,Locale::En),"This ear-only session did not use pitch metrics.");
        assert_eq!(summary_pitch_copy_in(Task::Imitate,None,Locale::En),"No steady in-tune notes were detected in this session.");
        assert_eq!(summary_pitch_copy_in(Task::Find,None,Locale::En),"No steady in-tune notes were detected in this session.");
        for cents in [-10.,0.,10.] { assert_eq!(summary_pitch_copy_in(Task::Imitate,Some(cents),Locale::En),"Your average pitch stayed in tune."); }
        assert_eq!(summary_pitch_copy_in(Task::Imitate,Some(10.1),Locale::En),"Your average pitch tended sharp.");
        assert_eq!(summary_pitch_copy_in(Task::Imitate,Some(-10.1),Locale::En),"Your average pitch tended flat.");
        assert_eq!(summary_pitch_copy_in(Task::Identify,None,Locale::Ru),"В сессии на слух метрики тона не использовались.");
        assert_eq!(summary_pitch_copy_in(Task::Imitate,Some(0.),Locale::Ru),"В среднем вы пели чисто.");
    }
    #[test]
    fn feedback_and_reveals_resolve_source_keys_in_every_locale_without_global_mutation() {
        for locale in Locale::ALL {
            for kind in [Kind::Note,Kind::Degree,Kind::Interval,Kind::Chord,Kind::Arpeggio] {
                let reveal=identify_answer_reveal_in(&prompt(kind),locale).unwrap();
                assert!(!reveal.contains("training.")&&!reveal.contains('{'),"{locale:?}: {reveal}");
            }
            for response in [ResultResponse::Skipped,ResultResponse::Identify{correct:true},ResultResponse::Identify{correct:false},ResultResponse::Vocal(vec![C::OnTarget]),ResultResponse::Vocal(vec![C::Close]),ResultResponse::Vocal(vec![C::WrongOctave])] {
                let copy=feedback_copy_in(&response,locale);
                assert!(!copy.heading.starts_with("training.")&&!copy.detail.starts_with("training."));
            }
        }
    }
    #[test]
    fn summary_description_includes_final_feedback_and_identify_reveal_in_the_selected_locale() {
        let mut run=crate::training_run::Run::new(Config{task:Task::Identify,length:1,low:57,high:58,..Default::default()},0,0.65,10.).unwrap();
        run.phase=crate::training_run::Phase::Respond;run.answer(crate::training_session::Answer::Note(10)).unwrap();run.phase=crate::training_run::Phase::Summary;
        let snapshot=run.snapshot();
        let en=summary_copy_in(&snapshot,Locale::En);
        assert_eq!(en.heading,"0 of 1 landed · Not this time");
        assert_eq!(en.description,"This ear-only session did not use pitch metrics. Listen for the key and compare the notes again. Answer: A");
        let ru=summary_copy_in(&snapshot,Locale::Ru);
        assert!(ru.heading.ends_with(" · Не в этот раз"));
        assert_eq!(ru.description,"В сессии на слух метрики тона не использовались. Прослушайте тональность и сравните ноты снова. Ответ: A");
    }

}
