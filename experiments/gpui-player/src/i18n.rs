//! Source dictionaries and desktop locale decisions, without a JavaScript runtime.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{
        OnceLock,
        atomic::{AtomicU8, Ordering},
    },
};
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Locale {
    #[default]
    #[serde(rename = "en")]
    En,
    #[serde(rename = "tr")]
    Tr,
    #[serde(rename = "ru")]
    Ru,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "hi")]
    Hi,
    #[serde(rename = "ja")]
    Ja,
    #[serde(rename = "ko")]
    Ko,
    #[serde(rename = "th")]
    Th,
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "vi")]
    Vi,
    #[serde(rename = "fil")]
    Fil,
    #[serde(rename = "ms")]
    Ms,
    #[serde(rename = "zh-TW")]
    ZhTw,
}
impl Locale {
    /// Source LOCALES menu order (distinct from registration order).
    pub const ALL: [Self; 13] = [
        Self::En,
        Self::Tr,
        Self::Ru,
        Self::ZhCn,
        Self::Hi,
        Self::Ja,
        Self::Ko,
        Self::Th,
        Self::Id,
        Self::Vi,
        Self::Fil,
        Self::Ms,
        Self::ZhTw,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Tr => "tr",
            Self::Ru => "ru",
            Self::ZhCn => "zh-CN",
            Self::Hi => "hi",
            Self::Ja => "ja",
            Self::Ko => "ko",
            Self::Th => "th",
            Self::Id => "id",
            Self::Vi => "vi",
            Self::Fil => "fil",
            Self::Ms => "ms",
            Self::ZhTw => "zh-TW",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|locale| locale.as_str() == value)
    }
    pub fn endonym(self) -> &'static str {
        match self {
            Self::En => "English",
            Self::Tr => "Türkçe",
            Self::Ru => "Русский",
            Self::ZhCn => "简体中文",
            Self::Hi => "हिन्दी",
            Self::Ja => "日本語",
            Self::Ko => "한국어",
            Self::Th => "ไทย",
            Self::Id => "Bahasa Indonesia",
            Self::Vi => "Tiếng Việt",
            Self::Fil => "Filipino",
            Self::Ms => "Bahasa Melayu",
            Self::ZhTw => "繁體中文",
        }
    }
    pub fn code(self) -> &'static str {
        match self {
            Self::En => "EN",
            Self::Tr => "TR",
            Self::Ru => "RU",
            Self::ZhCn => "ZH",
            Self::Hi => "HI",
            Self::Ja => "JA",
            Self::Ko => "KO",
            Self::Th => "TH",
            Self::Id => "ID",
            Self::Vi => "VI",
            Self::Fil => "FIL",
            Self::Ms => "MS",
            Self::ZhTw => "ZH-TW",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Language {
    #[default]
    System,
    Locale(Locale),
}
impl Language {
    pub const ALL: [Self; 14] = [
        Self::System,
        Self::Locale(Locale::En),
        Self::Locale(Locale::Tr),
        Self::Locale(Locale::Ru),
        Self::Locale(Locale::ZhCn),
        Self::Locale(Locale::Hi),
        Self::Locale(Locale::Ja),
        Self::Locale(Locale::Ko),
        Self::Locale(Locale::Th),
        Self::Locale(Locale::Id),
        Self::Locale(Locale::Vi),
        Self::Locale(Locale::Fil),
        Self::Locale(Locale::Ms),
        Self::Locale(Locale::ZhTw),
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Locale(locale) => locale.as_str(),
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        if value == "system" {
            Some(Self::System)
        } else {
            Locale::parse(value).map(Self::Locale)
        }
    }
}
impl Serialize for Language {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}
impl<'de> Deserialize<'de> for Language {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).ok_or_else(|| serde::de::Error::custom("Unsupported language"))
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleState {
    pub language: Language,
    pub locale: Locale,
    pub system_locale: Locale,
}
pub fn from_tag(tag: &str) -> Option<Locale> {
    let tag = tag.to_lowercase().replace('_', "-");
    let parts: Vec<_> = tag.split('-').collect();
    Some(match *parts.first()? {
        "en" => Locale::En,
        "ru" => Locale::Ru,
        "hi" => Locale::Hi,
        "tr" => Locale::Tr,
        "tl" | "fil" => Locale::Fil,
        "in" | "id" => Locale::Id,
        "ja" => Locale::Ja,
        "ko" => Locale::Ko,
        "th" => Locale::Th,
        "vi" => Locale::Vi,
        "ms" => Locale::Ms,
        "zh" => {
            if parts.contains(&"hant") {
                Locale::ZhTw
            } else if parts.contains(&"hans") {
                Locale::ZhCn
            } else {
                match parts.iter().skip(1).find(|part| part.len() == 2).copied() {
                    Some("tw" | "hk" | "mo") => Locale::ZhTw,
                    None | Some("cn" | "sg") => Locale::ZhCn,
                    _ => return None,
                }
            }
        }
        _ => return None,
    })
}
pub fn resolve_locale(language: Language, tags: &[String]) -> Locale {
    match language {
        Language::Locale(locale) => locale,
        Language::System => tags
            .iter()
            .find_map(|tag| from_tag(tag))
            .unwrap_or(Locale::En),
    }
}
static CURRENT: AtomicU8 = AtomicU8::new(0);
pub fn current() -> Locale {
    Locale::ALL[CURRENT.load(Ordering::Acquire) as usize]
}
pub fn set_current(locale: Locale) {
    CURRENT.store(locale as u8, Ordering::Release)
}
type Dictionary = BTreeMap<String, String>;
fn dictionaries() -> &'static BTreeMap<String, Dictionary> {
    static DICTS: OnceLock<BTreeMap<String, Dictionary>> = OnceLock::new();
    DICTS.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/i18n.json")))
            .expect("Build-validated source dictionaries")
    })
}
pub fn fill(text: &str, vars: &[(&str, String)]) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        result.push_str(&rest[..start]);
        rest = &rest[start..];
        if let Some(end) = rest.find('}') {
            let key = &rest[1..end];
            if !key.is_empty() && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
                if let Some((_, value)) = vars.iter().rev().find(|(name, _)| *name == key) {
                    result.push_str(value);
                } else {
                    result.push_str(&rest[..=end]);
                }
                rest = &rest[end + 1..];
                continue;
            }
        }
        result.push('{');
        rest = &rest[1..];
    }
    result.push_str(rest);
    result
}
pub fn plural_form(locale: Locale, n: f64) -> &'static str {
    if !n.is_finite() {
        return "other";
    }
    let a = (n.abs() * 1000.).round() / 1000.;
    if locale == Locale::Hi {
        return if a <= 1. { "one" } else { "other" };
    }
    if locale == Locale::Fil {
        let last = if a.fract() == 0. {
            a % 10.
        } else {
            let fraction = format!("{a:.3}");
            fraction
                .trim_end_matches('0')
                .bytes()
                .last()
                .and_then(|b| (b as char).to_digit(10))
                .unwrap_or(0) as f64
        };
        return if [4., 6., 9.].contains(&last) {
            "other"
        } else {
            "one"
        };
    }
    if a.fract() != 0. {
        return "other";
    }
    if locale == Locale::Ru {
        let d = a % 10.;
        let h = a % 100.;
        return if d == 1. && h != 11. {
            "one"
        } else if (2. ..=4.).contains(&d) && !(12. ..=14.).contains(&h) {
            "few"
        } else {
            "many"
        };
    }
    if matches!(
        locale,
        Locale::ZhCn
            | Locale::ZhTw
            | Locale::Ja
            | Locale::Ko
            | Locale::Th
            | Locale::Id
            | Locale::Vi
            | Locale::Ms
    ) {
        "other"
    } else if a == 1. {
        "one"
    } else {
        "other"
    }
}
fn number(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n == f64::INFINITY {
        "Infinity".into()
    } else if n == f64::NEG_INFINITY {
        "-Infinity".into()
    } else if n == 0. {
        "0".into()
    } else if n.abs() >= 1e21 || n.abs() < 1e-6 {
        let value = format!("{n:e}");
        let (base, exp) = value.split_once('e').unwrap();
        let exponent: i32 = exp.parse().unwrap();
        format!("{base}e{}{exponent}", if exponent >= 0 { "+" } else { "" })
    } else {
        n.to_string()
    }
}
pub(crate) fn lookup(locale: Locale, key: &str, vars: &[(&str, String)]) -> String {
    let dicts = dictionaries();
    fill(
        dicts[locale.as_str()]
            .get(key)
            .or_else(|| dicts["en"].get(key))
            .map_or(key, String::as_str),
        vars,
    )
}
pub(crate) fn lookup_plural(locale: Locale, stem: &str, n: f64, vars: &[(&str, String)]) -> String {
    let dicts = dictionaries();
    let dict = &dicts[locale.as_str()];
    let text = dict
        .get(&format!("{stem}_{}", plural_form(locale, n)))
        .or_else(|| dict.get(&format!("{stem}_other")))
        .or_else(|| dicts["en"].get(&format!("{stem}_{}", if n == 1. { "one" } else { "other" })))
        .map_or(stem, String::as_str);
    let mut values = vec![("n", number(n))];
    values.extend_from_slice(vars);
    fill(text, &values)
}
pub fn t(key: &str) -> String {
    lookup(current(), key, &[])
}
pub fn tv(key: &str, vars: &[(&str, String)]) -> String {
    lookup(current(), key, vars)
}
pub fn tn(stem: &str, n: f64, vars: &[(&str, String)]) -> String {
    lookup_plural(current(), stem, n, vars)
}
#[cfg(test)]
#[path = "i18n_tests.rs"]
mod tests;
