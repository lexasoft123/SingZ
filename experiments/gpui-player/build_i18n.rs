//! Strict extraction of source dictionary object literals; never executes TS.
use std::{collections::BTreeMap, fs, path::Path};
pub const LOCALES: [&str; 15] = [
    "en", "ru", "zh-CN", "hi", "ja", "ko", "th", "id", "vi", "fil", "ms", "zh-TW", "tr", "es-419", "pt-BR",
];
struct Parser<'a> {
    text: &'a str,
    pos: usize,
}
impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.text[self.pos..].chars().next()
    }
    fn next(&mut self) -> Result<char, String> {
        let ch = self.peek().ok_or("Unexpected end of dictionary")?;
        self.pos += ch.len_utf8();
        Ok(ch)
    }
    fn skip(&mut self) -> Result<(), String> {
        loop {
            while self.peek().is_some_and(char::is_whitespace) {
                self.next()?;
            }
            if self.text[self.pos..].starts_with("//") {
                while self.peek().is_some_and(|c| c != '\n') {
                    self.next()?;
                }
            } else if self.text[self.pos..].starts_with("/*") {
                self.pos += 2;
                let end = self.text[self.pos..]
                    .find("*/")
                    .ok_or("Unclosed dictionary comment")?;
                self.pos += end + 2;
            } else {
                return Ok(());
            }
        }
    }
    fn expect(&mut self, ch: char) -> Result<(), String> {
        self.skip()?;
        if self.next()? != ch {
            return Err(format!("Expected {ch} at byte {}", self.pos));
        }
        Ok(())
    }
    fn hex(&mut self, digits: usize) -> Result<u32, String> {
        let mut value = 0;
        for _ in 0..digits {
            value = value * 16
                + self
                    .next()?
                    .to_digit(16)
                    .ok_or("Invalid string hex escape")?;
        }
        Ok(value)
    }
    fn string(&mut self) -> Result<String, String> {
        self.skip()?;
        let quote = self.next()?;
        if !matches!(quote, '\'' | '"' | '`') {
            return Err("Dictionary values must be string literals".into());
        }
        let mut result = String::new();
        loop {
            let ch = self.next()?;
            if ch == quote {
                return Ok(result);
            }
            if quote == '`' && ch == '$' && self.peek() == Some('{') {
                return Err("Interpolated TS dictionary template is unsupported".into());
            }
            if ch != '\\' {
                if matches!(ch, '\n' | '\r') && quote != '`' {
                    return Err("Unescaped dictionary string newline".into());
                }
                result.push(ch);
                continue;
            }
            let escaped = self.next()?;
            match escaped {
                '\n' => {}
                '\r' => {
                    if self.peek() == Some('\n') {
                        self.next()?;
                    }
                }
                'n' => result.push('\n'),
                'r' => result.push('\r'),
                't' => result.push('\t'),
                'b' => result.push('\u{8}'),
                'f' => result.push('\u{c}'),
                'v' => result.push('\u{b}'),
                '0' => {
                    if self.peek().is_some_and(|c| c.is_ascii_digit()) {
                        return Err("Legacy octal dictionary escape".into());
                    }
                    result.push('\0');
                }
                'x' => {
                    let value = self.hex(2)?;
                    result.push(char::from_u32(value).ok_or("Invalid dictionary scalar")?);
                }
                'u' => {
                    let mut value = if self.peek() == Some('{') {
                        self.next()?;
                        let start = self.pos;
                        while self.peek().is_some_and(|c| c.is_ascii_hexdigit()) {
                            self.next()?;
                        }
                        let hex = &self.text[start..self.pos];
                        if hex.is_empty() || hex.len() > 6 {
                            return Err("Invalid Unicode dictionary escape".into());
                        }
                        let value =
                            u32::from_str_radix(hex, 16).map_err(|_| "Invalid Unicode escape")?;
                        self.expect('}')?;
                        value
                    } else {
                        self.hex(4)?
                    };
                    if (0xd800..=0xdbff).contains(&value) {
                        if self.next()? != '\\' || self.next()? != 'u' {
                            return Err("Unpaired dictionary surrogate".into());
                        }
                        let low = self.hex(4)?;
                        if !(0xdc00..=0xdfff).contains(&low) {
                            return Err("Unpaired dictionary surrogate".into());
                        }
                        value = 0x10000 + ((value - 0xd800) << 10) + low - 0xdc00;
                    }
                    result.push(char::from_u32(value).ok_or("Invalid Unicode dictionary scalar")?);
                }
                ch => result.push(ch),
            }
        }
    }
}
pub fn parse(text: &str) -> Result<BTreeMap<String, String>, String> {
    let start = text
        .find("export const ")
        .ok_or("Missing dictionary export")?;
    let rest = &text[start..];
    let equal = rest.find('=').ok_or("Missing dictionary object")?;
    let mut parser = Parser {
        text,
        pos: start + equal + 1,
    };
    parser.expect('{')?;
    let mut dictionary = BTreeMap::new();
    loop {
        parser.skip()?;
        if parser.peek() == Some('}') {
            parser.next()?;
            break;
        }
        let key = parser.string()?;
        parser.expect(':')?;
        let value = parser.string()?;
        if dictionary.insert(key.clone(), value).is_some() {
            return Err(format!("Duplicate dictionary key {key}"));
        }
        parser.skip()?;
        match parser.next()? {
            ',' => {}
            '}' => break,
            _ => {
                return Err(
                    "Expected dictionary comma; computed/concatenated values are unsupported"
                        .into(),
                );
            }
        }
    }
    if dictionary.is_empty() {
        return Err("Empty source dictionary".into());
    }
    Ok(dictionary)
}
pub fn merge_order(text: &str) -> Result<Vec<String>, String> {
    let start = text
        .find("export const ")
        .ok_or("Missing dictionary export")?;
    let equal = text[start..].find('=').ok_or("Missing merged dictionary")?;
    let mut parser = Parser {
        text,
        pos: start + equal + 1,
    };
    parser.skip()?;
    if parser.peek() != Some('{') {
        // The English entry exports a literal `base` dictionary with a
        // type-only Box intersection. Resolve only a preceding const object;
        // never evaluate an initializer or include type-only Box strings.
        let alias_start = parser.pos;
        while parser.peek().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            parser.next()?;
        }
        let alias = &text[alias_start..parser.pos];
        if alias.is_empty() {
            return Err("Expected dictionary object or local const alias".into());
        }
        parser.skip()?;
        if !parser.text[parser.pos..].starts_with(&format!("as typeof {alias}")) {
            return Err("Expected type-only dictionary alias assertion".into());
        }
        let declaration = format!("const {alias} =");
        let declaration_start = text[..start].find(&declaration)
            .ok_or("Dictionary alias must name a preceding const object")?;
        parser.pos = declaration_start + declaration.len();
    }
    parser.expect('{')?;
    let mut parts = vec![];
    loop {
        parser.skip()?;
        if parser.peek() == Some('}') {
            parser.next()?;
            break;
        }
        for _ in 0..3 {
            parser.expect('.')?;
        }
        let start = parser.pos;
        while parser
            .peek()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            parser.next()?;
        }
        let part = &text[start..parser.pos];
        if part.is_empty() || part.len() > 64 {
            return Err("Invalid dictionary spread".into());
        }
        parts.push(part.to_owned());
        parser.skip()?;
        match parser.next()? {
            ',' => {}
            '}' => break,
            _ => return Err("Expected dictionary spread comma".into()),
        }
    }
    if parts.is_empty() {
        return Err("Empty merged dictionary".into());
    }
    Ok(parts)
}
pub fn extract(root: &Path) -> Result<BTreeMap<String, BTreeMap<String, String>>, String> {
    let rules = fs::read_to_string(root.join("rules.ts")).map_err(|e| e.to_string())?;
    let start = rules
        .find("export const LOCALE_VALUES")
        .ok_or("Missing source locale list")?;
    let equal = rules[start..]
        .find('=')
        .ok_or("Missing source locale list value")?;
    let mut parser = Parser {
        text: &rules,
        pos: start + equal + 1,
    };
    parser.expect('[')?;
    let mut locales = vec![];
    loop {
        parser.skip()?;
        if parser.peek() == Some(']') {
            parser.next()?;
            break;
        }
        locales.push(parser.string()?);
        parser.skip()?;
        match parser.next()? {
            ',' => {}
            ']' => break,
            _ => return Err("Invalid source locale list".into()),
        }
    }
    if locales.iter().map(String::as_str).collect::<Vec<_>>() != LOCALES {
        return Err("Source locale list changed; update native Locale and supported locale extraction together".into());
    }
    let mut all = BTreeMap::new();
    for locale in LOCALES {
        let index = root.join(locale).join("index.ts");
        let text =
            fs::read_to_string(&index).map_err(|error| format!("{}: {error}", index.display()))?;
        let parts = merge_order(&text).map_err(|error| format!("{}: {error}", index.display()))?;
        let mut dictionary = BTreeMap::new();
        for part in parts {
            let path = root.join(locale).join(format!("{part}.ts"));
            let text = fs::read_to_string(&path)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            dictionary
                .extend(parse(&text).map_err(|error| format!("{}: {error}", path.display()))?);
        }
        all.insert(locale.into(), dictionary);
    }
    Ok(all)
}
