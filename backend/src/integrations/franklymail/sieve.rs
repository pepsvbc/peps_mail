use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const BEGIN: &str = "\n# BEGIN PEPS FRANKLYMAIL FORWARD v1\n";
const END: &str = "# END PEPS FRANKLYMAIL FORWARD v1\n";

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Forwarding {
    pub enabled: bool,
    pub address: String,
    pub keep_copy: bool,
}

pub fn email(value: &str) -> Result<String, AppError> {
    let value = value.trim();
    // Restrict to a plain address. Quoting, Sieve interpolation and line injection
    // are deliberately unsupported, even if accepted by some mail servers.
    if value.len() > 254
        || value
            .bytes()
            .any(|c| c <= 32 || c >= 127 || b"\"\\;<>$(){}".contains(&c))
        || value.parse::<lettre::Address>().is_err()
    {
        return Err(AppError::BadRequest("Enter a plain email address".into()));
    }
    Ok(value.to_lowercase())
}

pub fn revision(script: &str) -> String {
    format!("{:x}", Sha256::digest(script.as_bytes()))
}

fn block(rule: &Forwarding) -> String {
    let json = serde_json::to_string(rule).expect("forwarding is serializable");
    let keep = if rule.keep_copy { "keep;\n" } else { "" };
    format!(
        "{BEGIN}# {json}\nredirect \"{}\";\n{keep}stop;\n{END}",
        rule.address
    )
}

/// Own only a canonical trailing block. External edits are conflicts, never deleted.
pub fn split(script: &str) -> Result<(&str, Forwarding), AppError> {
    let conflict = || {
        AppError::BadRequest("The forwarding script was edited outside this app. Reconcile it in FranklyMail before continuing.".into())
    };
    let Some((original, managed)) = script.split_once(BEGIN) else {
        if script.contains("PEPS FRANKLYMAIL FORWARD") {
            return Err(conflict());
        }
        return Ok((
            script,
            Forwarding {
                keep_copy: true,
                ..Default::default()
            },
        ));
    };
    if original.contains("PEPS FRANKLYMAIL FORWARD") {
        return Err(conflict());
    }
    let first_line = managed
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("# "))
        .ok_or_else(conflict)?;
    let rule: Forwarding = serde_json::from_str(first_line).map_err(|_| conflict())?;
    if !rule.enabled || email(&rule.address).is_err() || format!("{BEGIN}{managed}") != block(&rule)
    {
        return Err(conflict());
    }
    Ok((original, rule))
}

pub fn replace(script: &str, rule: &Forwarding, own_email: &str) -> Result<String, AppError> {
    let (original, _) = split(script)?;
    if !rule.enabled {
        return Ok(original.to_string());
    }
    let mut rule = rule.clone();
    rule.address = email(&rule.address)?;
    if rule.address.eq_ignore_ascii_case(own_email) {
        return Err(AppError::BadRequest(
            "Forwarding to the same mailbox would create a loop".into(),
        ));
    }
    Ok(format!("{original}{}", block(&rule)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_original_and_restores_exact_bytes() {
        let original = "require [\"fileinto\"];\nif header :contains \"subject\" \"news\" { fileinto \"News\"; } # last comment";
        let rule = Forwarding {
            enabled: true,
            address: "other@example.org".into(),
            keep_copy: true,
        };
        let script = replace(original, &rule, "me@example.com").unwrap();
        assert_eq!(split(&script).unwrap(), (original, rule.clone()));
        assert!(script.contains("keep;\nstop;"));
        assert_eq!(
            replace(&script, &Forwarding::default(), "me@example.com").unwrap(),
            original
        );
        let no_copy = replace(
            &script,
            &Forwarding {
                keep_copy: false,
                ..rule
            },
            "me@example.com",
        )
        .unwrap();
        assert!(!no_copy.contains("keep;"));
    }
    #[test]
    fn rejects_tampering_injection_and_self_forward() {
        let rule = Forwarding {
            enabled: true,
            address: "me@example.com".into(),
            keep_copy: true,
        };
        assert!(replace("", &rule, "ME@example.com").is_err());
        for value in [
            "x@example.com\nstop;",
            "${x}@example.com",
            "a\"@example.com",
            "Name <a@example.com>",
        ] {
            assert!(email(value).is_err());
        }
        let script = replace("", &rule, "other@example.com").unwrap();
        assert!(split(&format!("{script}keep;")).is_err());
        assert!(split(&script.replace("redirect", "discard; # redirect")).is_err());
    }
}
