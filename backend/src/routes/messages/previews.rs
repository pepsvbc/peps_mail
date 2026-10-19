use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct PreviewQuery {
    uids: String,
}

fn parse_uids(value: &str) -> Result<Vec<u32>, AppError> {
    let uids = value
        .split(',')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| AppError::BadRequest("Invalid preview UIDs".into()))?;
    if uids.is_empty() || uids.len() > 50 || uids.contains(&0) {
        return Err(AppError::BadRequest(
            "Request between 1 and 50 message previews".into(),
        ));
    }
    Ok(uids)
}

pub async fn get_previews(
    Extension(session): Extension<SessionState>,
    Extension(imap): Extension<Arc<dyn ImapClient>>,
    Path(folder): Path<String>,
    Query(query): Query<PreviewQuery>,
) -> Result<Response, AppError> {
    let uids = parse_uids(&query.uids)?;
    let creds = ImapCredentials {
        host: session.imap_host.clone(),
        port: session.imap_port,
        tls: session.imap_tls,
        email: session.email.clone(),
        password: session.password.clone(),
    };
    let previews = imap
        .fetch_previews(&creds, &folder, &uids)
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    Ok(Json(
        previews
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>(),
    )
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_requests_and_rejects_imap_query_syntax() {
        assert_eq!(parse_uids("1,2,99").unwrap(), vec![1, 2, 99]);
        for value in ["", "0", "1:*", "1,2 FLAGS", "-1"] {
            assert!(parse_uids(value).is_err());
        }
        assert!(parse_uids(&vec!["1"; 51].join(",")).is_err());
    }
}
