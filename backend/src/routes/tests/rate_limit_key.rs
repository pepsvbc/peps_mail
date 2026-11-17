use super::*;

fn extractor(trusted: &str) -> ClientIpKeyExtractor {
    ClientIpKeyExtractor {
        trusted_proxies: Arc::new(parse_trusted_proxies(Some(trusted))),
    }
}

fn request_from(peer: &str, forwarded_for: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().uri("/api/auth/login");
    if let Some(value) = forwarded_for {
        builder = builder.header("x-forwarded-for", value);
    }
    let mut req = builder.body(Body::empty()).unwrap();
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::new(peer.parse().unwrap(), 40000)));
    req
}

fn key(extractor: &ClientIpKeyExtractor, req: &Request<Body>) -> IpAddr {
    extractor.extract(req).unwrap()
}

#[test]
fn forwarded_for_is_ignored_from_untrusted_peers() {
    let ex = extractor("10.0.0.0/8");
    let req = request_from("203.0.113.7", Some("198.51.100.1"));
    assert_eq!(key(&ex, &req), "203.0.113.7".parse::<IpAddr>().unwrap());
}

#[test]
fn trusted_proxy_uses_rightmost_untrusted_hop() {
    let ex = extractor("10.0.0.0/8, 172.16.0.1");
    // The client can prepend fake hops; only the hop added by our proxy counts.
    let req = request_from("10.1.2.3", Some("1.1.1.1, 198.51.100.9, 172.16.0.1"));
    assert_eq!(key(&ex, &req), "198.51.100.9".parse::<IpAddr>().unwrap());
}

#[test]
fn trusted_proxy_without_header_falls_back_to_peer() {
    let ex = extractor("127.0.0.1");
    let req = request_from("127.0.0.1", None);
    assert_eq!(key(&ex, &req), "127.0.0.1".parse::<IpAddr>().unwrap());
}

#[test]
fn ipv6_clients_are_grouped_by_64() {
    let ex = extractor("");
    let a = request_from("2001:db8:1:2:aaaa::1", None);
    let b = request_from("2001:db8:1:2:bbbb::2", None);
    assert_eq!(key(&ex, &a), key(&ex, &b));
    assert_eq!(key(&ex, &a), "2001:db8:1:2::".parse::<IpAddr>().unwrap());
}

#[test]
fn invalid_trusted_proxy_entries_are_skipped() {
    let parsed = parse_trusted_proxies(Some("nope, 10.0.0.0/33, 192.168.0.0/16"));
    assert_eq!(parsed.len(), 1);
    assert!(parsed[0].contains("192.168.4.5".parse().unwrap()));
    assert!(!parsed[0].contains("192.169.0.1".parse().unwrap()));
}
