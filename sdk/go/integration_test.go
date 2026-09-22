package noola

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestIntegration runs against a real Noola API when NOOLA_TEST_URL and NOOLA_TEST_KEY are set (a key
// with contacts:read/write + accounts:read/write, ideally on a throwaway workspace). Ids use the
// "gosdk-" prefix; everything it creates is soft-removed at the end.
func TestIntegration(t *testing.T) {
	baseURL, key := os.Getenv("NOOLA_TEST_URL"), os.Getenv("NOOLA_TEST_KEY")
	if baseURL == "" || key == "" {
		t.Skip("set NOOLA_TEST_URL and NOOLA_TEST_KEY to run against a live API")
	}
	c, err := NewClient(baseURL, key)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	rep, err := c.Sync(ctx,
		[]ContactInput{
			{ExternalID: "gosdk-u1", Email: "gosdk-u1@example.com", Name: "Go SDK One", Subscribed: Ptr(true)},
			{ExternalID: "gosdk-u2", Email: "gosdk-u2@example.com", Name: "Go SDK Two", Subscribed: Ptr(false)},
		},
		[]CompanyInput{{
			ExternalID: "gosdk-c1", Name: "Go SDK Client", AvgMonthlySpend: Ptr(99.5), Currency: "EUR",
			Members: []Member{{ExternalID: "gosdk-u1", Role: "owner"}, {ExternalID: "gosdk-u2", Role: "developer"}, {ExternalID: "gosdk-ghost"}},
			Projects: []Project{{ExternalID: "gosdk-p1", Name: "shop", AvgMonthlySpend: Ptr(80.0), Services: []Service{
				{Type: "ubuntu/nodejs@22", Hostname: "app"}, {Type: "postgresql:ha@16", Hostname: "db"},
			}}},
		}},
	)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if rep.Contacts.Failed != 0 || rep.Companies.Failed != 0 || len(rep.UnknownMembers["gosdk-c1"]) != 1 {
		t.Fatalf("unexpected report: %s %+v", rep, rep.UnknownMembers)
	}

	co, err := c.GetCompany(ctx, "gosdk-c1")
	if err != nil {
		t.Fatal(err)
	}
	if co.AccountStatus != "customer" || len(co.Members) != 2 || len(co.Projects) != 1 || len(co.Projects[0].Services) != 2 {
		t.Fatalf("company not stored as sent: %+v", co)
	}
	for _, s := range co.Projects[0].Services {
		if s.Type == "postgresql:ha@16" && (s.Technology != "postgresql" || s.Version != "16" || s.Mode != "ha") {
			t.Errorf("service not parsed: %+v", s)
		}
	}

	// Spend-only update: nil Members/Projects leave them unchanged.
	if _, err := c.UpsertCompany(ctx, CompanyInput{ExternalID: "gosdk-c1", AvgMonthlySpend: Ptr(120.0)}); err != nil {
		t.Fatal(err)
	}
	if co, _ = c.GetCompany(ctx, "gosdk-c1"); len(co.Members) != 2 || *co.AvgMonthlySpend != 120 {
		t.Errorf("spend-only update touched members or missed spend: %+v", co)
	}

	u1, err := c.GetContact(ctx, "gosdk-u1")
	if err != nil || u1.AccountStatus != "customer" || !u1.Subscribed {
		t.Fatalf("contact: %+v %v", u1, err)
	}
	if _, err := c.UpsertContact(ctx, ContactInput{ExternalID: "gosdk-u3", Email: "gosdk-u1@example.com"}); !IsConflict(err) {
		t.Errorf("taken email should conflict, got %v", err)
	}
	if _, err := c.GetContact(ctx, "gosdk-nobody"); !IsNotFound(err) {
		t.Errorf("unknown contact should be 404, got %v", err)
	}
	if u2, err := c.SetSubscription(ctx, "gosdk-u2", true, false); err != nil || !u2.Subscribed {
		t.Errorf("re-subscribing an API opt-out should work: %+v %v", u2, err)
	}
	if usage, err := c.TechnologyUsage(ctx); err != nil || len(usage) == 0 {
		t.Errorf("usage: %d rows, %v", len(usage), err)
	}

	if co, err := c.RemoveCompany(ctx, "gosdk-c1"); err != nil || co.AccountStatus != "former" {
		t.Errorf("remove company: %+v %v", co, err)
	}
	for _, id := range []string{"gosdk-u1", "gosdk-u2"} {
		if u, err := c.RemoveContact(ctx, id); err != nil || u.AccountStatus != "former" {
			t.Errorf("remove %s: %+v %v", id, u, err)
		}
	}
}
