package noola

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newTestClient(t *testing.T, h http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := NewClient(srv.URL+"/v1/", "nk_test", WithBackoff(time.Millisecond, 5*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	return c, srv
}

func TestNewClientValidation(t *testing.T) {
	if _, err := NewClient("", "k"); err == nil {
		t.Error("empty baseURL accepted")
	}
	if _, err := NewClient("https://x.example", " "); err == nil {
		t.Error("empty apiKey accepted")
	}
	c, err := NewClient("https://x.example/v1/", "k")
	if err != nil || c.baseURL != "https://x.example" {
		t.Errorf("baseURL not normalized: %v %q", err, c.baseURL)
	}
}

func TestCompanyInputNilVsEmpty(t *testing.T) {
	b, _ := json.Marshal(CompanyInput{ExternalID: "c1", AvgMonthlySpend: Ptr(0.0)})
	s := string(b)
	if strings.Contains(s, "members") || strings.Contains(s, "projects") || strings.Contains(s, "name") {
		t.Errorf("nil lists / empty name must be omitted: %s", s)
	}
	if !strings.Contains(s, `"avg_monthly_spend":0`) {
		t.Errorf("explicit zero spend must be sent: %s", s)
	}
	b, _ = json.Marshal(CompanyInput{ExternalID: "c1", Members: []Member{}, Projects: []Project{{ExternalID: "p1"}}})
	s = string(b)
	if !strings.Contains(s, `"members":[]`) || !strings.Contains(s, `"services":[]`) {
		t.Errorf("empty lists must be sent to clear: %s", s)
	}
}

func TestUpsertContactSendsKeyAndDecodes(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/public/contacts/upsert" || r.Method != "POST" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "nk_test" || !strings.HasPrefix(r.Header.Get("user-agent"), "noola-go/") {
			t.Errorf("missing auth / user-agent headers")
		}
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"subscribed":false`) || strings.Contains(string(body), `"email"`) {
			t.Errorf("unexpected body %s", body)
		}
		w.WriteHeader(201)
		io.WriteString(w, `{"contact":{"id":"x","external_id":"u1","email":null,"name":"Jan","subscribed":false,"account_status":"user","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"},"created":true,"matched_by":null,"warnings":[]}`)
	})
	res, err := c.UpsertContact(context.Background(), ContactInput{ExternalID: "u1", Name: "Jan", Subscribed: Ptr(false)})
	if err != nil || !res.Created || res.Contact.Name != "Jan" || res.Contact.AccountStatus != "user" {
		t.Fatalf("got %+v, %v", res, err)
	}
	if _, err := c.UpsertContact(context.Background(), ContactInput{}); err == nil {
		t.Error("missing ExternalID accepted")
	}
}

func TestConflictError(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(409)
		io.WriteString(w, `{"error":"email already belongs to a contact with a different external_id","conflict":{"contact_id":"abc","external_id":"u9"}}`)
	})
	_, err := c.UpsertContact(context.Background(), ContactInput{ExternalID: "u1", Email: "a@b.cz"})
	var apiErr *APIError
	if !IsConflict(err) || !errors.As(err, &apiErr) || apiErr.Conflict == nil || *apiErr.Conflict.ExternalID != "u9" {
		t.Fatalf("expected conflict with details, got %v", err)
	}
}

func TestResubscribeBlocked(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(409)
		io.WriteString(w, `{"error":"resubscribe_blocked","unsubscribed_source":"contact"}`)
	})
	_, err := c.SetSubscription(context.Background(), "u1", true, false)
	var apiErr *APIError
	if !IsResubscribeBlocked(err) || !errors.As(err, &apiErr) || apiErr.UnsubscribedSource != "contact" {
		t.Fatalf("expected resubscribe_blocked, got %v", err)
	}
}

func TestRetriesRateLimitAndServerErrors(t *testing.T) {
	var calls atomic.Int32
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch calls.Add(1) {
		case 1:
			w.Header().Set("retry-after", "0")
			w.WriteHeader(429)
		case 2:
			w.WriteHeader(500) // e.g. the database briefly out of connections
		default:
			io.WriteString(w, `{"usage":[]}`)
		}
	})
	if _, err := c.TechnologyUsage(context.Background()); err != nil || calls.Load() != 3 {
		t.Fatalf("expected success on 3rd attempt, got %v after %d calls", err, calls.Load())
	}
}

func TestNoRetryOnClientErrors(t *testing.T) {
	var calls atomic.Int32
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(400)
		io.WriteString(w, `{"error":{"fieldErrors":{"external_id":["Required"]}}}`)
	})
	_, err := c.GetContact(context.Background(), "u1")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 400 || !strings.Contains(apiErr.Message, "fieldErrors") || calls.Load() != 1 {
		t.Fatalf("400 must not be retried and must carry the detail: %v (%d calls)", err, calls.Load())
	}
}

func TestContextCancelStopsRetries(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) })
	c.minBackoff, c.maxBackoff = time.Second, time.Second
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := c.TechnologyUsage(ctx); !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("expected prompt context error, got %v after %s", err, time.Since(start))
	}
}

func TestBulkChunkingAndSyncReport(t *testing.T) {
	var contactCalls, companyCalls atomic.Int32
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/public/contacts/bulk":
			contactCalls.Add(1)
			var body struct{ Contacts []ContactInput }
			json.NewDecoder(r.Body).Decode(&body)
			res := BulkContactsResult{}
			for i, ci := range body.Contacts {
				id := ci.ExternalID
				status := "created"
				if ci.Email == "taken@example.com" {
					status = "conflict"
					res.Conflicts++
				} else {
					res.Created++
				}
				res.Results = append(res.Results, ContactRowResult{Index: i, ExternalID: &id, Status: status})
			}
			json.NewEncoder(w).Encode(res)
		case "/v1/public/companies/bulk":
			companyCalls.Add(1)
			var body struct{ Companies []map[string]any }
			json.NewDecoder(r.Body).Decode(&body)
			res := BulkCompaniesResult{}
			for i := range body.Companies {
				res.Created++
				row := CompanyRowResult{Index: i, Status: "created"}
				if i == 0 {
					row.UnknownMembers = []string{"ghost"}
				}
				res.Results = append(res.Results, row)
			}
			json.NewEncoder(w).Encode(res)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})
	contacts := make([]ContactInput, 2500)
	for i := range contacts {
		contacts[i] = ContactInput{ExternalID: "u" + string(rune('a'+i%26)), Email: "x@example.com"}
	}
	contacts[2100].Email = "taken@example.com"
	companies := make([]CompanyInput, 250)
	for i := range companies {
		companies[i] = CompanyInput{ExternalID: "c" + string(rune('a'+i%26))}
	}
	companies[200].ExternalID = "second-chunk-first"

	rep, err := c.Sync(context.Background(), contacts, companies)
	if err != nil {
		t.Fatal(err)
	}
	if contactCalls.Load() != 3 || companyCalls.Load() != 2 {
		t.Errorf("chunking: %d contact calls, %d company calls", contactCalls.Load(), companyCalls.Load())
	}
	if rep.Contacts.Created != 2499 || rep.Contacts.Failed != 1 || len(rep.ContactIssues) != 1 || rep.ContactIssues[0].Index != 2100 {
		t.Errorf("contact totals/issue index wrong: %+v %+v", rep.Contacts, rep.ContactIssues)
	}
	if rep.Companies.Created != 250 || len(rep.UnknownMembers) != 2 || rep.UnknownMembers["second-chunk-first"] == nil {
		t.Errorf("company totals / unknown members mapped to the wrong company: %+v %v", rep.Companies, rep.UnknownMembers)
	}
	if rep.OK() {
		t.Error("report with issues must not be OK")
	}
}
