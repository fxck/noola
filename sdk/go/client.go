// Package noola is a Go client for the Noola public API — the api-key surface a system of record
// (e.g. the Zerops backend) uses to sync its people, clients, projects and technologies into Noola.
//
// Every write is idempotent (upserts keyed by your own ids, snapshot replaces, soft removes), so the
// client retries rate limits (429, honouring Retry-After) and server errors (5xx) on its own.
//
//	c, err := noola.NewClient("https://api.noola.example", os.Getenv("NOOLA_API_KEY"))
//	res, err := c.UpsertContact(ctx, noola.ContactInput{ExternalID: "u_123", Email: "jan@example.com", Name: "Jan"})
package noola

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Version is the SDK version, sent in the User-Agent.
const Version = "0.1.0"

// Client talks to one Noola workspace with one API key. It is safe for concurrent use.
type Client struct {
	baseURL    string
	apiKey     string
	http       *http.Client
	userAgent  string
	maxRetries int
	minBackoff time.Duration
	maxBackoff time.Duration
}

// Option configures a Client.
type Option func(*Client)

// WithHTTPClient replaces the default HTTP client (30s timeout).
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// WithUserAgent prefixes the User-Agent, e.g. "zerops-backend/1.4".
func WithUserAgent(ua string) Option {
	return func(c *Client) { c.userAgent = ua + " " + c.userAgent }
}

// WithRetries sets how many times a request is retried after a 429 / 5xx / network error (default 4).
func WithRetries(n int) Option { return func(c *Client) { c.maxRetries = n } }

// WithBackoff sets the exponential backoff bounds between retries (default 500ms … 30s). A 429's
// Retry-After header always wins.
func WithBackoff(min, max time.Duration) Option {
	return func(c *Client) { c.minBackoff, c.maxBackoff = min, max }
}

// NewClient creates a client for the Noola API at baseURL (the api origin, e.g.
// "https://api.noola.example" — without the /v1 suffix) authenticating with apiKey.
func NewClient(baseURL, apiKey string, opts ...Option) (*Client, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	baseURL = strings.TrimSuffix(baseURL, "/v1")
	if baseURL == "" {
		return nil, errors.New("noola: baseURL is required")
	}
	if _, err := url.ParseRequestURI(baseURL); err != nil {
		return nil, fmt.Errorf("noola: invalid baseURL: %w", err)
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("noola: apiKey is required")
	}
	c := &Client{
		baseURL:    baseURL,
		apiKey:     apiKey,
		http:       &http.Client{Timeout: 30 * time.Second},
		userAgent:  "noola-go/" + Version,
		maxRetries: 4,
		minBackoff: 500 * time.Millisecond,
		maxBackoff: 30 * time.Second,
	}
	for _, o := range opts {
		o(c)
	}
	return c, nil
}

// Ptr returns a pointer to v — for the optional fields (Subscribed, AvgMonthlySpend, …).
func Ptr[T any](v T) *T { return &v }

// APIError is a non-2xx response from Noola.
type APIError struct {
	StatusCode int
	// Message is the server's error text (a validation error is rendered as its JSON detail).
	Message string
	// Conflict names the contact that already holds the email, on a 409 from a contact upsert.
	Conflict *Conflict
	// UnsubscribedSource is set on a 409 "resubscribe_blocked": who opted the person out
	// ("contact", "agent", "import").
	UnsubscribedSource string
	// RetryAfter is the server's Retry-After on a 429.
	RetryAfter time.Duration
	// Body is the raw response body.
	Body []byte
}

func (e *APIError) Error() string {
	return fmt.Sprintf("noola: HTTP %d: %s", e.StatusCode, e.Message)
}

// Conflict identifies the existing contact an upsert collided with.
type Conflict struct {
	ContactID  string  `json:"contact_id"`
	ExternalID *string `json:"external_id"`
}

// IsNotFound reports whether err is a 404 (unknown external id / topic).
func IsNotFound(err error) bool { return statusIs(err, http.StatusNotFound) }

// IsConflict reports whether err is a 409 — an email held by another contact, a concurrent write, or
// a blocked re-subscribe (see IsResubscribeBlocked).
func IsConflict(err error) bool { return statusIs(err, http.StatusConflict) }

// IsResubscribeBlocked reports whether a subscription call was refused because the person opted out
// outside the API. Retry with force only if they consented again in your system.
func IsResubscribeBlocked(err error) bool {
	var e *APIError
	return errors.As(err, &e) && e.StatusCode == http.StatusConflict && e.Message == "resubscribe_blocked"
}

func statusIs(err error, code int) bool {
	var e *APIError
	return errors.As(err, &e) && e.StatusCode == code
}

// do sends one API call with retries; body (if any) is JSON-encoded, the 2xx response decoded into out.
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return fmt.Errorf("noola: encode request: %w", err)
		}
	}
	u := c.baseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}

	for attempt := 0; ; attempt++ {
		var rd io.Reader
		if payload != nil {
			rd = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, method, u, rd)
		if err != nil {
			return fmt.Errorf("noola: build request: %w", err)
		}
		req.Header.Set("x-api-key", c.apiKey)
		req.Header.Set("accept", "application/json")
		req.Header.Set("user-agent", c.userAgent)
		if payload != nil {
			req.Header.Set("content-type", "application/json")
		}

		resp, err := c.http.Do(req)
		if err != nil {
			if ctx.Err() != nil || attempt >= c.maxRetries {
				return fmt.Errorf("noola: %s %s: %w", method, path, err)
			}
			if werr := c.wait(ctx, attempt, 0); werr != nil {
				return werr
			}
			continue
		}
		data, rerr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if rerr != nil {
			return fmt.Errorf("noola: read response: %w", rerr)
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			if out == nil || len(data) == 0 {
				return nil
			}
			if err := json.Unmarshal(data, out); err != nil {
				return fmt.Errorf("noola: decode response: %w", err)
			}
			return nil
		}

		apiErr := parseAPIError(resp, data)
		retryable := resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500
		if !retryable || attempt >= c.maxRetries {
			return apiErr
		}
		if werr := c.wait(ctx, attempt, apiErr.RetryAfter); werr != nil {
			return werr
		}
	}
}

// wait sleeps before retry number attempt+1: Retry-After when given, else jittered exponential backoff.
func (c *Client) wait(ctx context.Context, attempt int, retryAfter time.Duration) error {
	d := retryAfter
	if d <= 0 {
		d = c.minBackoff << attempt
		if d > c.maxBackoff || d <= 0 {
			d = c.maxBackoff
		}
		d = d/2 + time.Duration(rand.Int63n(int64(d/2)+1))
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func parseAPIError(resp *http.Response, data []byte) *APIError {
	e := &APIError{StatusCode: resp.StatusCode, Body: data, Message: http.StatusText(resp.StatusCode)}
	if s := resp.Header.Get("retry-after"); s != "" {
		if secs, err := strconv.Atoi(s); err == nil && secs >= 0 {
			e.RetryAfter = time.Duration(secs) * time.Second
		}
	}
	var body struct {
		Error              json.RawMessage `json:"error"`
		Conflict           *Conflict       `json:"conflict"`
		UnsubscribedSource string          `json:"unsubscribed_source"`
	}
	if json.Unmarshal(data, &body) == nil {
		var msg string
		if json.Unmarshal(body.Error, &msg) == nil && msg != "" {
			e.Message = msg
		} else if len(body.Error) > 0 && string(body.Error) != "null" {
			e.Message = string(body.Error)
		}
		e.Conflict = body.Conflict
		e.UnsubscribedSource = body.UnsubscribedSource
	}
	return e
}
