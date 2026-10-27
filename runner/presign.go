package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// A flow's replay (.webm) is uploaded by the flow itself, from its sandbox, to a presigned PUT URL
// for exactly runs/<tenant>/<run>.webm that expires with the run — so the sandbox never holds the
// storage keys. AWS Signature V4, query-string form, path-style (Zerops object storage).

func presignPut(endpoint, region, bucket, key, accessKey, secretKey string, expires time.Duration, now time.Time) (string, error) {
	base, err := url.Parse(strings.TrimRight(endpoint, "/"))
	if err != nil || base.Host == "" {
		return "", fmt.Errorf("bad storage endpoint %q", endpoint)
	}
	raw := base.Scheme + "://" + base.Host + "/" + bucket + "/" + key
	return presignURL("PUT", raw, region, accessKey, secretKey, expires, now)
}

func presignURL(method, rawURL, region, accessKey, secretKey string, expires time.Duration, now time.Time) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	now = now.UTC()
	amzDate := now.Format("20060102T150405Z")
	day := now.Format("20060102")
	scope := day + "/" + region + "/s3/aws4_request"
	q := map[string]string{
		"X-Amz-Algorithm":     "AWS4-HMAC-SHA256",
		"X-Amz-Credential":    accessKey + "/" + scope,
		"X-Amz-Date":          amzDate,
		"X-Amz-Expires":       strconv.Itoa(int(expires.Seconds())),
		"X-Amz-SignedHeaders": "host",
	}
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, awsEscape(k, true)+"="+awsEscape(q[k], true))
	}
	query := strings.Join(parts, "&")
	path := awsEscape(u.Path, false)
	if path == "" {
		path = "/"
	}
	canonical := strings.Join([]string{method, path, query, "host:" + u.Host + "\n", "host", "UNSIGNED-PAYLOAD"}, "\n")
	sum := sha256.Sum256([]byte(canonical))
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(sum[:])
	k := hmacSHA256([]byte("AWS4"+secretKey), day)
	k = hmacSHA256(k, region)
	k = hmacSHA256(k, "s3")
	k = hmacSHA256(k, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(k, toSign))
	return u.Scheme + "://" + u.Host + path + "?" + query + "&X-Amz-Signature=" + sig, nil
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

// awsEscape is SigV4's URI encoding: every byte but A-Z a-z 0-9 - _ . ~ as %XX, and '/' too
// unless it separates a path's segments.
func awsEscape(s string, slash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && !slash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
